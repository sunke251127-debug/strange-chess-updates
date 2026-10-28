'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Bundle = require('bare-bundle');
const { prepareDht } = require('../android/prepare-dht.cjs');

test('the Android worklet bundle has real UDP/crypto native libraries for all four Android ABIs', { timeout: 90000 }, async () => {
  const info = await prepareDht();
  const bundle = Bundle.from(fs.readFileSync(info.bundle));
  assert.equal(bundle.main, '/dht/worklet.cjs');
  const files = [...bundle.keys()];
  for (const core of ['/dht/rendezvous.cjs', '/dht/introduction-queue.cjs', '/dht/matchmaker.cjs']) assert.ok(files.includes(core), core);
  assert.ok(bundle.addons.some(name => name.includes('udx-native')));
  assert.ok(bundle.addons.some(name => name.includes('sodium-native')));
  const machines = { 'arm64-v8a': 183, 'armeabi-v7a': 40, x86_64: 62, x86: 3 };
  for (const [abi, machine] of Object.entries(machines)) {
    for (const name of ['libbare-kit.so', ...bundle.addons.map(name => name.slice('linked:'.length))]) {
      const filename = name === 'libbare-kit.so' ? path.join(info.kit, 'jni', abi, name) : path.join(info.addons, abi, name);
      const bytes = fs.readFileSync(filename);
      assert.equal(bytes.readUInt32BE(0), 0x7f454c46, filename);
      assert.equal(bytes.readUInt16LE(18), machine, filename);
      assert.ok(bytes.length > 4096, 'a native implementation must be present');
    }
  }
  assert.equal(fs.readFileSync(path.join(info.kit, 'classes.jar')).readUInt32LE(0), 0x04034b50);
});
