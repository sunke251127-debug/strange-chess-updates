'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const URL = 'https://dl.google.com/android/repository/android-ndk-r28c-windows.zip';
const PREFIX = 'android-ndk-r28c/toolchains/llvm/prebuilt/windows-x86_64/';
const TRIPLES = { 'arm64-v8a': 'aarch64-linux-android', 'armeabi-v7a': 'arm-linux-androideabi', x86_64: 'x86_64-linux-android', x86: 'i686-linux-android' };
const HASHES = {
  'arm64-v8a/libc++_shared.so': 'ab4e6c71b96b851de45a8a9bd86369e7dbc2130a44b3b4520564be94847910f2',
  'armeabi-v7a/libc++_shared.so': '10ee48131d6742899619f7cfb3b8df150ad787d723c766a3fb80d4bb275711ff',
  'x86_64/libc++_shared.so': 'e4cd73c8a3607269f3be58d15c21f78bff112e27f9398d6261e5f965668f8746',
  'x86/libc++_shared.so': '0d3760e528242389388893f46de419ebf80870d08fa73732dc2b1e9b69a793c1',
  'llvm-strip.exe': '2d411db64e0b45508775e9e8fd436fb6e0af814a9dfbf8aea8fc37ce436c435c',
  'libwinpthread-1.dll': '441e8c679824d2b1cf6a9aa889490ad0e9b4b52ff01a0659371f113396efa5f5',
  NOTICE: 'f96f763beb66a7ba7a667647fc64c0226ace875e590c831fdd9579ec1c1d91e1'
};
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');

// Fetch only the official NDK's selected ZIP members, rather than a 748MB SDK.
// HTTP ranges, central-directory sizes and CRCs are verified before extraction.
async function prepareLibcxx(cache) {
  const directory = path.join(cache, 'libcxx-r28c'); fs.mkdirSync(directory, { recursive: true });
  const manifest = path.join(directory, 'manifest.json');
  if (fs.existsSync(manifest)) {
    const info = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (info.source === URL && [...Object.keys(TRIPLES).map(abi => abi + '/libc++_shared.so'), 'NOTICE', 'llvm-strip.exe', 'libwinpthread-1.dll'].every(file => {
      const target = path.join(directory, file);
      return fs.existsSync(target) && sha256(fs.readFileSync(target)) === HASHES[file];
    })) return { directory, ...info };
  }
  async function range(start, end) {
    const response = await fetch(URL, { headers: { Range: start < 0 ? 'bytes=' + start : 'bytes=' + start + '-' + end, 'Accept-Encoding': 'identity' } });
    const contentRange = response.headers.get('content-range') || '';
    if (response.status !== 206 || !/^bytes \d+-\d+\/\d+$/.test(contentRange)) throw new Error('NDK server did not return a valid ZIP range');
    const bytes = Buffer.from(await response.arrayBuffer());
    const [, first, last] = contentRange.match(/^bytes (\d+)-(\d+)\//);
    if (bytes.length !== Number(last) - Number(first) + 1 || (start >= 0 && Number(first) !== start) || (end !== '' && Number(last) !== Number(end))) throw new Error('NDK ZIP range mismatch');
    return bytes;
  }
  const tail = await range(-65536, '');
  const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('NDK ZIP end directory missing');
  const size = tail.readUInt32LE(eocd + 12), offset = tail.readUInt32LE(eocd + 16);
  if (size > 20 * 1024 * 1024 || !size) throw new Error('Invalid NDK ZIP central directory');
  const central = await range(offset, offset + size - 1);
  const entries = new Map();
  for (let at = 0; at < central.length;) {
    if (central.readUInt32LE(at) !== 0x02014b50) throw new Error('Invalid NDK ZIP directory entry');
    const nameLength = central.readUInt16LE(at + 28), extra = central.readUInt16LE(at + 30), comment = central.readUInt16LE(at + 32);
    const name = central.toString('utf8', at + 46, at + 46 + nameLength);
    entries.set(name, { method: central.readUInt16LE(at + 10), crc: central.readUInt32LE(at + 16),
      compressed: central.readUInt32LE(at + 20), uncompressed: central.readUInt32LE(at + 24), offset: central.readUInt32LE(at + 42) });
    at += 46 + nameLength + extra + comment;
  }
  const selected = Object.entries(TRIPLES).map(([abi, triple]) => [PREFIX + 'sysroot/usr/lib/' + triple + '/libc++_shared.so', abi + '/libc++_shared.so']);
  selected.push([PREFIX + 'bin/llvm-strip.exe', 'llvm-strip.exe']);
  selected.push([PREFIX + 'bin/libwinpthread-1.dll', 'libwinpthread-1.dll']);
  const notice = [PREFIX + 'NOTICE', 'android-ndk-r28c/NOTICE'].find(name => entries.has(name));
  if (!notice) throw new Error('Official NDK license notice missing');
  selected.push([notice, 'NOTICE']);
  const hashes = {};
  for (const [name, relative] of selected) {
    const entry = entries.get(name);
    if (!entry || entry.compressed > 30 * 1024 * 1024 || entry.uncompressed > 60 * 1024 * 1024) throw new Error('Invalid NDK member: ' + name);
    const header = await range(entry.offset, entry.offset + 29);
    if (header.readUInt32LE(0) !== 0x04034b50) throw new Error('Invalid NDK member header');
    const dataOffset = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const compressed = await range(dataOffset, dataOffset + entry.compressed - 1);
    const data = entry.method === 8 ? zlib.inflateRawSync(compressed) : compressed;
    if (data.length !== entry.uncompressed || zlib.crc32(data) !== entry.crc) throw new Error('NDK member CRC mismatch: ' + name);
    if (sha256(data) !== HASHES[relative]) throw new Error('NDK member SHA256 mismatch: ' + name);
    const target = path.join(directory, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data);
    hashes[relative] = sha256(data);
  }
  const info = { source: URL, version: '28.2.13676358', hashes };
  fs.writeFileSync(manifest, JSON.stringify(info, null, 2));
  return { directory, ...info };
}
module.exports = { prepareLibcxx };
