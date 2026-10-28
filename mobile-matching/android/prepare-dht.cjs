'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const Bundle = require('bare-bundle');
const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(__dirname, '.local/bare');
const HOSTS = ['android-arm64', 'android-arm', 'android-x64', 'android-ia32'];
const ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86'];
const KIT = 'react-native-bare-kit-0.16.0.tgz';
const KIT_HASH = 'j3jlvsf+q2506a4+6apKtJsj/TzywAdC/QGPTgBuEkh61bYDJxaZYROnqgRcewfH1U9As6RVpJuO98VdRaKEcg==';

function run(executable, args) {
  const result = spawnSync(executable, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
}

async function prepareDht() {
  fs.mkdirSync(CACHE, { recursive: true });
  const archive = path.join(CACHE, KIT);
  if (!fs.existsSync(archive)) {
    const response = await fetch('https://registry.npmjs.org/react-native-bare-kit/-/' + KIT);
    if (!response.ok) throw new Error('Bare Kit download failed: ' + response.status);
    const data = Buffer.from(await response.arrayBuffer());
    if (crypto.createHash('sha512').update(data).digest('base64') !== KIT_HASH) throw new Error('Bare Kit integrity mismatch');
    fs.writeFileSync(archive, data);
  }
  if (crypto.createHash('sha512').update(fs.readFileSync(archive)).digest('base64') !== KIT_HASH) throw new Error('Cached Bare Kit integrity mismatch');
  const kit = path.join(CACHE, 'package/android/libs/bare-kit');
  if (!fs.existsSync(path.join(kit, 'classes.jar'))) run('tar', ['-xf', archive, '-C', CACHE, 'package/android/libs/bare-kit', 'package/LICENSE']);
  const bundle = path.join(CACHE, 'chess-dht.bundle');
  run(process.execPath, [path.join(ROOT, 'node_modules/bare-pack/bin.js'), '--linked', ...HOSTS.flatMap(host => ['--host', host]), '--out', bundle, 'dht/worklet.cjs']);
  const manifest = Bundle.from(fs.readFileSync(bundle));
  if (!manifest.addons.length) throw new Error('DHT bundle contains no native addons');
  // The upstream ELF writer uses narrow Windows filenames. Its output path
  // must be ASCII even when this project lives in a Chinese-named directory.
  const addons = fs.mkdtempSync(path.join(os.tmpdir(), 'StrangeChessDht-'));
  if (/[^\x00-\x7f]/.test(addons)) throw new Error('Bare native linking requires an ASCII system temporary directory');
  run(process.execPath, [path.join(ROOT, 'node_modules/bare-link/bin.js'), '--preset', 'android', '--out', addons, 'dht/worklet.cjs']);
  const libraries = [];
  // Verify the exact native set required by the bundle; never silently package
  // a build with missing UDP/crypto libraries.
  for (const reference of manifest.addons) {
    const match = reference.match(/^linked:lib(.+)\.(\d+\.\d+\.\d+(?:-[\w.]+)?)\.so$/);
    if (!match || match[1].includes('..')) throw new Error('Unexpected linked addon: ' + reference);
    const base = path.join(ROOT, 'node_modules', match[1]);
    const pkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));
    if (pkg.version !== match[2] || pkg.addon !== true) throw new Error('Native addon manifest mismatch');
    for (const abi of ABIS) {
      const library = path.join(addons, abi, reference.slice('linked:'.length));
      if (!fs.existsSync(library) || fs.readFileSync(library).readUInt32BE(0) !== 0x7f454c46) throw new Error('Missing Android ELF: ' + library);
      libraries.push(library);
    }
  }
  for (const abi of ABIS) {
    if (!fs.existsSync(path.join(kit, 'jni', abi, 'libbare-kit.so'))) throw new Error('Missing Bare Kit ABI: ' + abi);
  }
  const info = { kit, bundle, addons, libraries, abis: ABIS, minDhtSdk: 29, runtimeVersion: '0.16.0', kitSha512: KIT_HASH, nativeReferences: manifest.addons };
  info.libcxx = await require('./prepare-libcxx.cjs').prepareLibcxx(CACHE);
  fs.writeFileSync(path.join(CACHE, 'dht-build.json'), JSON.stringify(info, null, 2));
  return info;
}
module.exports = { prepareDht };
if (require.main === module) prepareDht().then(info => console.log(JSON.stringify(info, null, 2))).catch(error => { console.error(error); process.exitCode = 1; });
