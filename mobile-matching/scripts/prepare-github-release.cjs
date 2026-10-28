'use strict';
// Builds the two public, non-secret release assets for the GitHub update feed.
// Usage: node scripts/prepare-github-release.cjs [tag]
// The script never uploads and never reads credentials.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const REPOSITORY = 'sunke251127-debug/strange-chess-updates';
const APK_ASSET = 'strange-chess-matching-android.apk';
const MANIFEST = 'android-update.json';
const packageJson = require('../package.json');
const { SIMULATIONS } = require('../src/ai-search.js');
const release = path.join(ROOT, 'release');
const info = JSON.parse(fs.readFileSync(path.join(release, 'android-build-info.json'), 'utf8'));
const tag = process.argv[2] || 'mobile-v' + packageJson.version;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(tag)) throw new Error('Invalid release tag: ' + tag);
if (info.versionName !== packageJson.version) throw new Error('Build metadata and package.json version differ');
if (info.packageId !== 'cn.strangechess.mobile.matching') throw new Error('Unexpected package id');
if (info.signerSha256 !== 'ce9a58357f5126eb3d7856387a07f8b89c89309930138a48e78a46914f50fee0') throw new Error('Unexpected publisher certificate');
if (info.nativeLibraries !== false || info.webviewOnly !== true) throw new Error('Release is not the lightweight WebView build');
if (!Number.isSafeInteger(info.versionCode) || info.versionCode <= 10701) throw new Error('Release must be newer than 1.7.1');
const apk = path.join(release, info.file);
const bytes = fs.readFileSync(apk);
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
if (bytes.length !== info.bytes || sha256 !== info.sha256) throw new Error('APK metadata does not match the file');
if (bytes.length > 64 * 1024 * 1024) throw new Error('APK exceeds the offline-model 64MiB limit');
if (info.offlineModel?.simulations !== SIMULATIONS) throw new Error('Expected packaged offline-model search with '+SIMULATIONS+' simulations');
const url = 'https://github.com/' + REPOSITORY + '/releases/download/' + encodeURIComponent(tag) + '/' + APK_ASSET;
const manifest = {
  available: true,
  platform: 'android',
  edition: 'matching',
  packageId: info.packageId,
  versionName: info.versionName,
  versionCode: info.versionCode,
  bytes: bytes.length,
  sha256,
  url,
  signerSha256: info.signerSha256,
  minSdk: info.minSdk,
  targetSdk: info.targetSdk,
  channel: 'stable'
};
fs.writeFileSync(path.join(release, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(release, 'SHA256SUMS.txt'), sha256 + '  ' + APK_ASSET + '\n');
console.log(JSON.stringify({ tag, apk: path.basename(apk), manifest, checksums: 'SHA256SUMS.txt' }, null, 2));
