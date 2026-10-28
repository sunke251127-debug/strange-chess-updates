'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { startChessServer } = require('../server/server.cjs');
const { APK_NAME, PACKAGE_ID } = require('../server/android-download.cjs');
async function withServer(options, run) {
  const server = await startChessServer({ host: '127.0.0.1', port: 0, quiet: true, ...options });
  try { await run(server.url); } finally { await server.close(); }
}
test('Android feed, actual APK GET and HEAD return matching metadata and bytes without exposing publisher files', async () => {
  await withServer({}, async url => {
    const info = await (await fetch(url + 'api/android/latest')).json();
    const local = JSON.parse(await fs.readFile(path.join(__dirname, '../release/android-build-info.json')));
    assert.equal(info.available, true); assert.equal(info.packageId, PACKAGE_ID);
    assert.equal(info.packageId, 'cn.strangechess.mobile.matching');
    assert.equal(local.edition, 'matching'); assert.notEqual(local.packageId, 'cn.strangechess.mobile');
    assert.equal(info.versionCode, local.versionCode); assert.equal(info.versionName, local.versionName);
    assert.equal(info.url, '/download/android');
    const response = await fetch(new URL(info.url, url));
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /application\/vnd.android.package-archive/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, info.bytes); assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), info.sha256);
    assert.deepEqual(bytes, await fs.readFile(path.join(__dirname, '../release', APK_NAME)));
    const head = await fetch(new URL(info.url, url), { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(Number(head.headers.get('content-length')), bytes.length); assert.equal((await head.arrayBuffer()).byteLength, 0);
    const headInfo = await fetch(url + 'api/android/latest', { method: 'HEAD' }); assert.equal(headInfo.status, 200); assert.equal((await headInfo.arrayBuffer()).byteLength, 0);
    for (const route of ['android/.local/toolchain.json','android-release.p12','release/android-build-info.json','download/','download/android/../android-password.txt']) assert.equal((await fetch(url + route)).status, 404, route);
  });
});
test('missing, tampered and mismatched APK releases are never offered for updates', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chess-apk-feed-'));
  await withServer({ androidReleaseDirectory: directory }, async url => {
    async function unavailable() {
      assert.equal((await (await fetch(url + 'api/android/latest')).json()).available, false);
      assert.equal((await fetch(url + 'download/android')).status, 404);
    }
    await unavailable();
    const bytes = await fs.readFile(path.join(__dirname, '../release', APK_NAME));
    const info = JSON.parse(await fs.readFile(path.join(__dirname, '../release/android-build-info.json')));
    const apk = path.join(directory, APK_NAME), meta = path.join(directory, 'android-build-info.json');
    await fs.writeFile(apk, bytes); await fs.writeFile(meta, JSON.stringify(info));
    assert.equal((await (await fetch(url + 'api/android/latest')).json()).available, true);
    await fs.writeFile(meta, JSON.stringify({ ...info, file: '../android-release.p12' })); await unavailable();
    await fs.writeFile(meta, JSON.stringify({ ...info, packageId: 'evil.package' })); await unavailable();
    // The matching feed must never offer the original APK identity.
    await fs.writeFile(meta, JSON.stringify({ ...info, packageId: 'cn.strangechess.mobile' })); await unavailable();
    await fs.writeFile(meta, JSON.stringify({ ...info, bytes: info.bytes + 1 })); await unavailable();
    await fs.writeFile(meta, JSON.stringify(info));
    const altered = Buffer.from(bytes); altered[altered.length - 1] ^= 1; await fs.writeFile(apk, altered); await unavailable();
  });
});

test('a hash-valid 129MB APK is refused by the bounded 128MB update channel', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chess-large-apk-'));
  const apk = path.join(directory, APK_NAME), handle = await fs.open(apk, 'w+');
  try {
    await handle.truncate(129 * 1024 * 1024);
    const hash = crypto.createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk);
    const original = JSON.parse(await fs.readFile(path.join(__dirname, '../release/android-build-info.json')));
    await fs.writeFile(path.join(directory, 'android-build-info.json'), JSON.stringify({ ...original, bytes: 129 * 1024 * 1024, sha256: hash.digest('hex') }));
    await withServer({ androidReleaseDirectory: directory }, async url => {
      assert.equal((await (await fetch(url + 'api/android/latest')).json()).available, false);
      assert.equal((await fetch(url + 'download/android')).status, 404);
    });
  } finally { await handle.close(); }
});
