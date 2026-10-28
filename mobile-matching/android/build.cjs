'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const PACKAGE_ID = 'cn.strangechess.mobile.matching';
const EDITION = 'matching';
const APK_BASE = '根本就没有这样的象棋-安卓及鸿蒙4.2';
const MAX_APK_BYTES = 64 * 1024 * 1024;
const { SIMULATIONS } = require('../src/ai-search.js');
// Read-only reuse of the installed publisher identity. The build must never
// mint a replacement key, or Android would reject the branch as an update.
const EXPECTED_SIGNER = 'ce9a58357f5126eb3d7856387a07f8b89c89309930138a48e78a46914f50fee0';
// Random matching now runs entirely in the WebView. These are the only Java
// sources in the APK; the legacy DhtBridge/DhtMessages files stay as an
// optional development reference and are deliberately not compiled here.
const JAVA_SOURCES = [
  'MainActivity.java',
  'ApkUpdater.java',
  'UpdateChannel.java',
  'LocalRoutes.java',
  'LocalServer.java',
  'UpdateProvider.java'
];
function publisherDirectory() {
  const candidates = [];
  if (process.env.STRANGE_CHESS_ANDROID_PUBLISHER) candidates.push(process.env.STRANGE_CHESS_ANDROID_PUBLISHER);
  candidates.push(path.join(process.env.LOCALAPPDATA, 'StrangeChessMobilePublisher'));
  const packages = path.join(process.env.LOCALAPPDATA, 'Packages');
  try {
    for (const entry of fs.readdirSync(packages, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(packages, entry.name, 'LocalCache/Local/StrangeChessMobilePublisher'));
    }
  } catch { /* no packaged app-local cache on this machine */ }
  const seen = new Set();
  for (const directory of candidates) {
    if (seen.has(directory)) continue; seen.add(directory);
    if (fs.existsSync(path.join(directory, 'android-release.p12')) && fs.existsSync(path.join(directory, 'android-password.txt'))) return directory;
  }
  throw new Error('Original publisher signature was not found. Restore android-release.p12 and android-password.txt; this build refuses to generate a new key.');
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(path.basename(command) + ' failed\n' + result.stdout + result.stderr);
  return result.stdout + result.stderr;
}
function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]); }
async function main() {
  const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/ai/model.json'), 'utf8'));
  if (model.source_status !== 'completed' || model.search.simulations !== SIMULATIONS) throw new Error('Expected a completed historical model with '+SIMULATIONS+' simulations');
  const modelBytes = fs.readFileSync(path.join(ROOT, 'assets/ai/model.onnx'));
  if (modelBytes.length !== model.bytes || crypto.createHash('sha256').update(modelBytes).digest('hex') !== model.sha256) throw new Error('Offline model integrity mismatch');
  const configFile = path.join(__dirname, '.local/toolchain.json');
  if (!fs.existsSync(configFile)) run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'prepare-toolchain.ps1')], { stdio: 'inherit' });
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, ''));
  const java = name => path.join(config.javaBin, name + '.exe');
  const sdk = name => path.join(config.buildTools, name + '.exe');
  const buildRoot = path.join(process.env.LOCALAPPDATA, 'StrangeChessMobileBuild');
  fs.mkdirSync(buildRoot, { recursive: true });
  const work = fs.mkdtempSync(path.join(buildRoot, 'apk-lite-'));
  for (const dir of ['assets/www/src', 'res/drawable', 'res/values', 'classes', 'dex']) fs.mkdirSync(path.join(work, dir), { recursive: true });

  const { FILES, readAsset } = require('../server/mobile-assets.cjs');
  const assetHashes = {};
  for (const [url, [relative]] of Object.entries(FILES)) {
    const target = path.join(work, 'assets/www', url === '/' ? 'index.html' : url.slice(1));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let bytes = readAsset(url, relative);
    if (url === '/') bytes = Buffer.from(bytes.toString('utf8').replace('</body>', '  <script src="android-shell.js"></script>\n</body>'));
    fs.writeFileSync(target, bytes);
    assetHashes[url] = crypto.createHash('sha256').update(bytes).digest('hex');
  }
  fs.copyFileSync(path.join(__dirname, 'android-shell.js'), path.join(work, 'assets/www/android-shell.js'));
  fs.copyFileSync(path.join(ROOT, 'renderer/icon-512.png'), path.join(work, 'res/drawable/icon.png'));
  fs.copyFileSync(path.join(__dirname, 'res/values/styles.xml'), path.join(work, 'res/values/styles.xml'));

  const versionName = require('../package.json').version;
  const [major, minor, patch] = versionName.split('.').map(Number);
  const versionCode = major * 10000 + minor * 100 + patch;
  const manifest = fs.readFileSync(path.join(__dirname, 'AndroidManifest.xml'), 'utf8')
    .replace(/android:versionCode="\d+"/, 'android:versionCode="' + versionCode + '"')
    .replace(/android:versionName="[^"]+"/, 'android:versionName="' + versionName + '"');
  fs.writeFileSync(path.join(work, 'AndroidManifest.xml'), manifest);

  console.log('Compiling lightweight WebView Android resources…');
  run(sdk('aapt2'), ['compile', '--dir', path.join(work, 'res'), '-o', path.join(work, 'resources.zip')]);
  run(sdk('aapt2'), ['link', '-o', path.join(work, 'unsigned.apk'), '-I', config.androidJar, '--manifest', path.join(work, 'AndroidManifest.xml'), '--min-sdk-version', '26', '--target-sdk-version', '35', path.join(work, 'resources.zip')]);
  const sources = JAVA_SOURCES.map(file => path.join(__dirname, 'java/cn/strangechess/mobile', file));
  run(java('javac'), ['-J-Duser.language=en', '-J-Dfile.encoding=UTF-8', '-encoding', 'UTF-8', '--release', '8', '-classpath', config.androidJar, '-d', path.join(work, 'classes'), ...sources]);
  run(java('java'), ['-cp', path.join(config.buildTools, 'lib/d8.jar'), 'com.android.tools.r8.D8', '--lib', config.androidJar, '--min-api', '26', '--output', path.join(work, 'dex'), ...walk(path.join(work, 'classes')).filter(file => file.endsWith('.class'))]);
  // aapt2's Windows -A path produced assets/www\index.html, invisible to Android.
  // JDK jar emits canonical ZIP separators for the entire asset tree.
  run(java('jar'), ['uf', path.join(work, 'unsigned.apk'), '-C', work, 'assets', '-C', path.join(work, 'dex'), 'classes.dex']);
  const entries = run(java('jar'), ['tf', path.join(work, 'unsigned.apk')]).split(/\r?\n/).filter(Boolean);
  if (entries.some(entry => entry.includes('\\'))) throw new Error('APK contains a non-Android backslash path');
  for (const file of ['index.html', 'app.js', 'mobile.js', 'android-shell.js', 'src/game-engine.js', 'src/random-match.js', 'src/peer-link.js', 'src/relay-channel.js', 'src/system-random.js', 'src/room-model.js', 'ai-client.js', 'ai-worker.js', 'src/ai-search.js', 'src/ai-rules.js', 'ai/model.onnx', 'ai/model.json', 'ai/ort.wasm.min.js', 'ai/ort-wasm-simd-threaded.mjs', 'ai/ort-wasm-simd-threaded.wasm']) {
    if (!entries.includes('assets/www/' + file)) throw new Error('Missing exact Android asset path: ' + file);
  }
  if (entries.some(entry => entry.startsWith('lib/') || entry.endsWith('.so'))) throw new Error('Lightweight APK must not contain native libraries');
  if (entries.some(entry => entry.startsWith('assets/dht/') || entry.includes('dht-link.js'))) throw new Error('Lightweight APK must not contain the legacy native DHT runtime');

  run(sdk('zipalign'), ['-f', '4', path.join(work, 'unsigned.apk'), path.join(work, 'aligned.apk')]);
  const publisher = publisherDirectory();
  const key = path.join(publisher, 'android-release.p12'), passwordFile = path.join(publisher, 'android-password.txt');
  const signingEnv = { ...process.env, STRANGE_CHESS_ANDROID_SIGN_PASS: fs.readFileSync(passwordFile, 'utf8').trim() };
  const release = path.join(ROOT, 'release'); fs.mkdirSync(release, { recursive: true });
  for (const name of fs.readdirSync(release)) if (/\.(apk|idsig)$/i.test(name)) fs.rmSync(path.join(release, name), { force: true });
  const output = path.join(release, APK_BASE + '.apk');
  const signer = ['-jar', path.join(config.buildTools, 'lib/apksigner.jar')];
  run(java('java'), [...signer, 'sign', '--ks', key, '--ks-key-alias', 'chess', '--ks-pass', 'env:STRANGE_CHESS_ANDROID_SIGN_PASS', '--key-pass', 'env:STRANGE_CHESS_ANDROID_SIGN_PASS', '--v1-signing-enabled', 'true', '--out', output, path.join(work, 'aligned.apk')], { env: signingEnv });
  const verified = run(java('java'), [...signer, 'verify', '--min-sdk-version', '23', '--verbose', '--print-certs', output]);
  const signerSha256 = verified.match(/certificate SHA-256 digest: ([a-f0-9]+)/i)?.[1];
  if (signerSha256 !== EXPECTED_SIGNER) throw new Error('APK signer does not match the installed publisher certificate: ' + signerSha256);
  const badging = run(sdk('aapt2'), ['dump', 'badging', output]);
  run(sdk('zipalign'), ['-c', '4', output]);
  const apk = fs.readFileSync(output);
  if (apk.length > MAX_APK_BYTES) throw new Error('Offline-model APK exceeds 64MiB: ' + apk.length + ' bytes');
  const info = { file: path.basename(output), platform: 'android', edition: EDITION, packageId: PACKAGE_ID, versionName, versionCode,
    minSdk: 26, targetSdk: 35, nativeLibraries: false, webviewOnly: true,
    matchingTransport: 'webrtc-or-encrypted-relay', discovery: 'public-wss-mqtt', maxBytes: MAX_APK_BYTES,
    offlineModel: { id: model.id, sourceRun: model.source_run, iteration: model.iteration, sourceSha256: model.source_sha256, sha256: model.sha256, simulations: SIMULATIONS, precision: model.precision },
    bytes: apk.length, sha256: crypto.createHash('sha256').update(apk).digest('hex'), signerSha256,
    assetHashes, builtAt: new Date().toISOString() };
  fs.writeFileSync(path.join(release, 'android-build-info.json'), JSON.stringify(info, null, 2));
  fs.writeFileSync(path.join(release, 'android-verification.txt'), verified + '\n' + badging);
  fs.writeFileSync(path.join(__dirname, '.local/last-build.json'), JSON.stringify({ work, output }, null, 2));
  console.log(JSON.stringify(info, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
