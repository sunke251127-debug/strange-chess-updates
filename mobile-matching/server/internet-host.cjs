'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const path = require('node:path');

// Only Cloudflare's random HTTPS host is accepted. Never expose a localhost/LAN URL as internet-ready.
function tunnelUrlFromLog(text) {
  const match = String(text).match(/https:\/\/([a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com)(?=[\s/|]|$)/i);
  return match ? `https://${match[1].toLowerCase()}/` : null;
}

class InternetHost extends EventEmitter {
  constructor(options = {}) {
    super();
    this.binaryPath = options.binaryPath || path.resolve(__dirname, '..', 'tools', 'cloudflared.exe');
    this.spawn = options.spawn || spawn;
    this.timeoutMs = options.timeoutMs || 65000;
    this.child = null;
    this.status = { status: 'off', url: null, message: '' };
    this.pending = null;
    this.timer = null;
  }

  snapshot() { return { ...this.status }; }

  setStatus(status, url = null, message = '') {
    this.status = { status, url, message };
    this.emit('change', this.snapshot());
  }

  start(port) {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return Promise.reject(new Error('本地服务端口无效'));
    if (this.status.status === 'ready') return Promise.resolve(this.snapshot());
    if (this.pending) return this.pending;
    this.setStatus('starting', null, '正在建立互联网入口…');
    let settle;
    const pending = new Promise(resolve => { settle = resolve; });
    this.pending = pending;
    let child;
    const finish = () => {
      if (this.pending === pending) this.pending = null;
      clearTimeout(this.timer);
      this.timer = null;
      settle(this.snapshot());
    };
    try {
      child = this.spawn(this.binaryPath, [
        'tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`,
        '--protocol', 'http2', '--edge-ip-version', '4', '--loglevel', 'info'
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
    } catch (error) {
      this.setStatus('error', null, `互联网入口无法启动：${error.message}`);
      finish();
      return pending;
    }

    let buffer = '', url = null, connected = false;
    const consume = data => {
      if (this.child !== child) return;
      buffer = (buffer + String(data)).slice(-12000);
      url = tunnelUrlFromLog(buffer) || url;
      if (/Registered tunnel connection/.test(buffer)) connected = true;
      if (url && connected && this.status.status !== 'ready') {
        this.setStatus('ready', url, '互联网入口已开启，主机需保持游戏运行');
        finish();
      }
    };
    child.stdout?.on('data', consume);
    child.stderr?.on('data', consume);
    child.once('error', error => {
      if (this.child !== child) return;
      this.child = null;
      this.setStatus('error', null, `互联网入口启动失败：${error.code === 'ENOENT' ? '未找到随游戏附带的联网组件' : error.message}`);
      finish();
    });
    child.once('exit', () => {
      if (this.child !== child) return;
      this.child = null;
      this.setStatus('error', null, '互联网入口已断开，请重试；也可以连接自建公网服务器');
      finish();
    });
    this.timer = setTimeout(() => {
      if (this.child !== child || this.status.status !== 'starting') return;
      this.child = null;
      try { child.kill(); } catch { /* Already exited. */ }
      this.setStatus('error', null, '互联网入口连接超时，请检查网络后重试，或连接自建公网服务器');
      finish();
    }, this.timeoutMs);
    this.timer.unref?.();
    this.finishPending = finish;
    return pending;
  }

  async stop() {
    const child = this.child;
    this.child = null;
    clearTimeout(this.timer);
    this.timer = null;
    this.setStatus('off', null, '互联网入口已关闭');
    this.finishPending?.();
    this.finishPending = null;
    if (!child) return;
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 2500);
      timer.unref?.();
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      try { child.kill(); } catch { clearTimeout(timer); resolve(); }
    });
  }
}

module.exports = { InternetHost, tunnelUrlFromLog };
