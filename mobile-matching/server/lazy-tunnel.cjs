'use strict';
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { hashFile } = require('./hash-file.cjs');
// Immutable publisher digest, verified against Cloudflare's official release.
const COMPONENT = {
  version: '2026.9.1', bytes: 54976432,
  sha256: '2837888cc0f5d58f15b6dc478376de90b4d3ba5241c7947455d1e0a0df429712',
  metadata: 'https://api.github.com/repos/cloudflare/cloudflared/releases/tags/2026.9.1',
  mirror: 'https://registry.npmjs.org/@camera.ui/cloudflared-win32-x64/-/cloudflared-win32-x64-2026.9.1-cui.1.tgz'
};
class LazyTunnel extends EventEmitter {
  constructor(options) {
    super(); Object.assign(this, options);
    this.fetch = options.fetch || globalThis.fetch;
    this.component = options.component || COMPONENT;
    this.state = { status: 'off', url: null, message: '' };
    this.host = null; this.pending = null; this.controller = null;
  }
  snapshot() { return { ...this.state }; }
  change(state) { this.state = state; this.emit('change', this.snapshot()); }
  async ensureBinary(signal) {
    const component = this.component;
    const binary = path.join(this.directory, `cloudflared-${component.version}.exe`);
    try { if (await hashFile(binary) === component.sha256) return binary; } catch { /* first use */ }
    await fs.mkdir(this.directory, { recursive: true });
    if (component.mirror) {
      try {
        // A compressed transport mirror is smaller; only Cloudflare's pinned
        // executable digest grants trust. No package scripts or paths are used.
        const response = await this.fetch(component.mirror, { signal });
        if (!response.ok) throw new Error('压缩组件下载失败');
        const chunks = []; let received = 0, previous = -1;
        const total = Number(response.headers.get('content-length'));
        for await (const chunk of response.body) {
          received += chunk.length;
          if (received > 32 * 1024 * 1024) throw new Error('压缩组件超出大小限制');
          chunks.push(chunk);
          const progress = total ? Math.floor(received / total * 100) : Math.floor(received / 1048576);
          if (progress !== previous) {
            previous = progress;
            this.change({ status: 'starting', url: null, message: `首次使用：正在下载联网组件 ${progress}${total ? '%' : 'MB'}，以后使用本机缓存。可取消。` });
          }
        }
        const tar = zlib.gunzipSync(Buffer.concat(chunks), { maxOutputLength: 70 * 1024 * 1024 });
        let executable;
        for (let offset = 0; offset + 512 <= tar.length;) {
          const header = tar.subarray(offset, offset + 512);
          if (header.every(byte => byte === 0)) break;
          const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
          const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
          if (!/^[0-7]+$/.test(sizeText)) throw new Error('压缩组件目录无效');
          const size = parseInt(sizeText, 8); offset += 512;
          if (offset + size > tar.length) throw new Error('压缩组件不完整');
          if (name.endsWith('/cloudflared.exe') && [0, 48].includes(header[156])) {
            if (executable) throw new Error('压缩组件包含重复程序');
            executable = tar.subarray(offset, offset + size);
          }
          offset += Math.ceil(size / 512) * 512;
        }
        if (!executable || executable.length !== component.bytes || crypto.createHash('sha256').update(executable).digest('hex') !== component.sha256) throw new Error('联网组件校验失败');
        signal.throwIfAborted();
        const partial = `${binary}.${crypto.randomUUID()}.part`;
        try { await fs.writeFile(partial, executable, { flag: 'wx' }); await fs.rename(partial, binary); }
        finally { await fs.unlink(partial).catch(() => {}); }
        return binary;
      } catch (error) { signal.throwIfAborted(); /* Fall back to the official release transport. */ }
    }
    const response = await this.fetch(component.metadata, { signal, headers: { Accept: 'application/json', 'User-Agent': 'strange-chess' } });
    if (!response.ok) throw new Error(`联网组件下载服务暂不可用（${response.status}）`);
    const release = await response.json();
    const asset = release.assets?.find(asset => asset.name === 'cloudflared-windows-amd64.exe');
    if (!asset || asset.digest !== `sha256:${component.sha256}` || asset.size !== component.bytes ||
        !/^https:\/\/api\.github\.com\/repos\/cloudflare\/cloudflared\/releases\/assets\/\d+$/.test(asset.url)) throw new Error('联网组件的发行信息与内置信任记录不符');
    const partial = `${binary}.${crypto.randomUUID()}.part`;
    let file;
    try {
      let url = asset.url, download;
      for (let i = 0; i <= 5; i++) {
        if (new URL(url).protocol !== 'https:') throw new Error('联网组件必须通过 HTTPS 下载');
        download = await this.fetch(url, { signal, redirect: 'manual', headers: { Accept: 'application/octet-stream', 'User-Agent': 'strange-chess' } });
        if (![301, 302, 303, 307, 308].includes(download.status)) break;
        const location = download.headers.get('location');
        await download.body?.cancel();
        if (!location || i === 5) throw new Error('联网组件下载跳转无效');
        url = new URL(location, url).href;
      }
      if (!download.ok) throw new Error(`联网组件下载失败（${download.status}）`);
      file = await fs.open(partial, 'wx');
      const hash = crypto.createHash('sha256'); let bytes = 0, previous = -1;
      for await (const chunk of download.body) {
        bytes += chunk.length;
        if (bytes > component.bytes) throw new Error('联网组件大小不符');
        hash.update(chunk);
        for (let offset = 0; offset < chunk.length;) offset += (await file.write(chunk, offset)).bytesWritten;
        const progress = Math.floor(bytes / component.bytes * 100);
        if (progress !== previous) {
          previous = progress;
          this.change({ status: 'starting', url: null, message: `首次使用：正在下载联网组件 ${progress}%，以后直接使用缓存。可取消。` });
        }
      }
      if (bytes !== component.bytes || hash.digest('hex') !== component.sha256) throw new Error('联网组件校验失败');
      await file.close(); file = null;
      await fs.rename(partial, binary);
      return binary;
    } finally { await file?.close(); await fs.unlink(partial).catch(() => {}); }
  }
  start(port) {
    if (this.pending) return this.pending;
    if (this.host?.snapshot().status === 'ready') return Promise.resolve(this.snapshot());
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const timer = setTimeout(() => this.controller?.abort(), 15 * 60 * 1000);
    this.change({ status: 'starting', url: null, message: '正在准备互联网组件；首次使用需要下载…' });
    this.pending = (async () => {
      try {
        const binary = await this.ensureBinary(signal);
        signal.throwIfAborted();
        if (!this.host) { this.host = this.makeHost(binary); this.host.on('change', state => this.change(state)); }
        return await this.host.start(port);
      } catch (error) {
        if (!signal.aborted) this.change({ status: 'error', url: null, message: error.message });
        return this.snapshot();
      } finally { clearTimeout(timer); this.pending = null; this.controller = null; }
    })();
    return this.pending;
  }
  async stop() {
    this.controller?.abort();
    if (this.host) await this.host.stop();
    this.change({ status: 'off', url: null, message: '互联网入口已关闭' });
    if (this.pending) await this.pending;
    return this.snapshot();
  }
}
module.exports = { LazyTunnel, COMPONENT };
