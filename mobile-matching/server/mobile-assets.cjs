'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const FILES = {
  '/': ['renderer/index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['renderer/styles.css', 'text/css; charset=utf-8'],
  '/polish.css': ['renderer/polish.css', 'text/css; charset=utf-8'],
  '/mobile.css': ['renderer/mobile.css', 'text/css; charset=utf-8'],
  '/app.js': ['renderer/app.js', 'text/javascript; charset=utf-8'],
  '/mobile.js': ['renderer/mobile.js', 'text/javascript; charset=utf-8'],
  '/ai-client.js': ['renderer/ai-client.js', 'text/javascript; charset=utf-8'],
  '/ai-worker.js': ['renderer/ai-worker.js', 'text/javascript; charset=utf-8'],
  '/src/ai-search.js': ['src/ai-search.js', 'text/javascript; charset=utf-8'],
  '/src/ai-rules.js': ['src/ai-rules.js', 'text/javascript; charset=utf-8'],
  '/src/ai-repetition.js': ['src/ai-repetition.js', 'text/javascript; charset=utf-8'],
  '/ai/model.onnx': ['assets/ai/model.onnx', 'application/octet-stream'],
  '/ai/model.json': ['assets/ai/model.json', 'application/json; charset=utf-8'],
  '/ai/ort.wasm.min.js': ['assets/ai/ort.wasm.min.js', 'text/javascript; charset=utf-8'],
  '/ai/ort-wasm-simd-threaded.mjs': ['assets/ai/ort-wasm-simd-threaded.mjs', 'text/javascript; charset=utf-8'],
  '/ai/ort-wasm-simd-threaded.wasm': ['assets/ai/ort-wasm-simd-threaded.wasm', 'application/wasm'],
  '/ai/runtime.json': ['assets/ai/runtime.json', 'application/json; charset=utf-8'],
  '/ai/ORT-LICENSE.txt': ['assets/ai/ORT-LICENSE.txt', 'text/plain; charset=utf-8'],
  '/ai/ORT-NOTICES.txt': ['assets/ai/ORT-NOTICES.txt', 'text/plain; charset=utf-8'],
  '/src/system-random.js': ['src/system-random.js', 'text/javascript; charset=utf-8'],
  '/src/room-model.js': ['server/game-room.cjs', 'text/javascript; charset=utf-8'],
  '/src/peer-link.js': ['src/peer-link.js', 'text/javascript; charset=utf-8'],
  '/src/random-match.js': ['src/random-match.js', 'text/javascript; charset=utf-8'],
  '/src/piece-glyphs.js': ['src/piece-glyphs.js', 'text/javascript; charset=utf-8'],
  '/src/relay-channel.js': ['src/relay-channel.js', 'text/javascript; charset=utf-8'],
  '/src/game-engine.js': ['src/game-engine.js', 'text/javascript; charset=utf-8'],
  '/src/check-detector.js': ['src/check-detector.js', 'text/javascript; charset=utf-8'],
  '/src/invite.js': ['src/invite.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['renderer/manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/icon-192.png': ['renderer/icon-192.png', 'image/png'],
  '/icon-512.png': ['renderer/icon-512.png', 'image/png'],
  '/icon.svg': ['renderer/icon.svg', 'image/svg+xml']
};
function createMobileAssets(overrides = {}) {
  const assets = new Map();
  for (const [url, [file, type]] of Object.entries(FILES)) {
    const body = Object.hasOwn(overrides, url) ? Buffer.from(overrides[url]) : readAsset(url, file);
    assets.set(url, { body, type, hash: crypto.createHash('sha256').update(body).digest('hex') });
  }
  const worker = fs.readFileSync(path.join(ROOT, 'renderer/sw.js'), 'utf8');
  const version = require('../package.json').version;
  const build = crypto.createHash('sha256').update(version).update(worker).update(JSON.stringify([...assets].map(([u, a]) => [u, a.hash]))).digest('hex').slice(0, 24);
  const config = { build, version, files: [...assets].map(([url, a]) => ({ url, hash: a.hash })) };
  const script = worker.replace('/*__CONFIG__*/', JSON.stringify(config));
  return {
    build,
    handle(req, res, pathname) {
      if (pathname === '/api/version') {
        const body = JSON.stringify({ version: require('../package.json').version, build });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(req.method === 'HEAD' ? undefined : body); return true;
      }
      const route = pathname === '/index.html' ? '/' : pathname;
      const asset = pathname === '/sw.js' ? { body: Buffer.from(script), type: 'text/javascript; charset=utf-8' } : assets.get(route);
      if (!asset) return false;
      const url = new URL(req.url, 'http://localhost');
      if (url.searchParams.has('build') && url.searchParams.get('build') !== build) {
        res.writeHead(409, { 'Cache-Control': 'no-store' }); res.end('Bundle changed; retry update'); return true;
      }
      res.writeHead(200, { 'Content-Type': asset.type, 'Content-Length': asset.body.length,
        'Cache-Control': 'no-store', 'Service-Worker-Allowed': '/', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      res.end(req.method === 'HEAD' ? undefined : asset.body); return true;
    }
  };
}
function readAsset(url, file) {
  return url === '/src/room-model.js' ? Buffer.from(require('./browser-room.cjs').browserRoom()) : fs.readFileSync(path.join(ROOT, file));
}
module.exports = { createMobileAssets, FILES, readAsset };
