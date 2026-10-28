'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream');
const APK_NAME = '根本就没有这样的象棋-安卓及鸿蒙4.2.apk';
const PACKAGE_ID = 'cn.strangechess.mobile.matching';
const MAX_APK_BYTES = 128 * 1024 * 1024;
function createAndroidDownload(directory = path.join(__dirname, '../release')) {
  async function verifiedRelease() {
    let file;
    try {
      const metadataFile = path.join(directory, 'android-build-info.json');
      const metadataStat = await fs.lstat(metadataFile);
      if (!metadataStat.isFile() || metadataStat.size > 32768) return null;
      const info = JSON.parse(await fs.readFile(metadataFile, 'utf8'));
      if (info.file !== APK_NAME || info.platform !== 'android' || info.packageId !== PACKAGE_ID || !Number.isSafeInteger(info.versionCode) || info.versionCode <= 0 || !/^\d+\.\d+\.\d+$/.test(info.versionName) || !/^[a-f0-9]{64}$/i.test(info.sha256)) return null;
      const apkPath = path.join(directory, APK_NAME);
      if (!(await fs.lstat(apkPath)).isFile()) return null;
      file = await fs.open(apkPath, 'r');
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== info.bytes || stat.size <= 0 || stat.size > MAX_APK_BYTES) return null;
      const hash = crypto.createHash('sha256');
      for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
      if (hash.digest('hex') !== info.sha256.toLowerCase()) return null;
      const release = { file, bytes: stat.size, descriptor: { available: true, platform: 'android', packageId: PACKAGE_ID, versionName: info.versionName,
        versionCode: info.versionCode, bytes: stat.size, sha256: info.sha256.toLowerCase(), url: '/download/android' } };
      file = null; return release;
    } catch { return null; }
    finally { await file?.close(); }
  }
  return async function androidDownload(req, res, pathname) {
    if (pathname !== '/api/android/latest' && pathname !== '/download/android') return false;
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
    const release = await verifiedRelease();
    if (pathname === '/api/android/latest') {
      await release?.file.close();
      const bytes = Buffer.from(JSON.stringify(release?.descriptor || { available: false, platform: 'android' }));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length });
      res.end(req.method === 'HEAD' ? undefined : bytes); return true;
    }
    if (!release) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(req.method === 'HEAD' ? undefined : 'APK unavailable'); return true; }
    res.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': release.bytes,
      'Content-Disposition': 'attachment; filename="strange-chess-' + release.descriptor.versionName + '-android-harmony42.apk"' });
    if (req.method === 'HEAD') { await release.file.close(); res.end(); }
    else pipeline(release.file.createReadStream({ start: 0, autoClose: true }), res, error => { if (error) res.destroy(); });
    return true;
  };
}
module.exports = { createAndroidDownload, APK_NAME, PACKAGE_ID, MAX_APK_BYTES };
