'use strict';
// Copy a pinned runtime into the APK/PWA; the application never contacts a CDN.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const source = path.join(ROOT, 'node_modules/onnxruntime-web');
const output = path.join(ROOT, 'assets/ai');
const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
fs.mkdirSync(output, { recursive: true });
const files = ['ort.wasm.min.js', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];
const hashes = {};
for (const file of files) {
  const bytes = fs.readFileSync(path.join(source, 'dist', file));
  fs.writeFileSync(path.join(output, file), bytes);
  hashes[file] = { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}
// The npm distribution omits notices. The official v1.31.1 license and
// ThirdPartyNotices.txt are vendored alongside the runtime in this repository.
for (const file of ['ORT-LICENSE.txt', 'ORT-NOTICES.txt']) if (!fs.existsSync(path.join(output, file))) throw new Error('Missing vendored official license: ' + file);
fs.writeFileSync(path.join(output, 'runtime.json'), JSON.stringify({ name: pkg.name, version: pkg.version, files: hashes,
  source: 'https://www.npmjs.com/package/onnxruntime-web/v/' + pkg.version,
  documentation: 'https://onnxruntime.ai/docs/tutorials/web/deploy.html' }, null, 2) + '\n');
console.log(JSON.stringify({ runtime: pkg.version, files: hashes }));
