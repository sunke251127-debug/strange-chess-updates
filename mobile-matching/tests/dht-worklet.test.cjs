'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

test('native addon load failure reports the requesting match id after handlers are registered and does not abort the app', async () => {
  const ipc = new EventEmitter(), bare = new EventEmitter(), output = [];
  ipc.write = bytes => output.push(JSON.parse(bytes.toString()));
  let loads = 0;
  const context = vm.createContext({ Buffer, BareKit: { IPC: ipc }, Bare: bare,
    require() { loads++; throw new Error('native addon unavailable'); } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../dht/worklet.cjs'), 'utf8'), context);
  assert.equal(loads, 0, 'boot must not load addons before a request can receive an error');
  assert.equal(bare.listenerCount('uncaughtException'), 1);
  assert.equal(bare.listenerCount('unhandledRejection'), 1);
  const id = 'matching_request_123456';
  const bytes = Buffer.from(JSON.stringify({ type: 'start', id }) + '\n');
  for (const byte of bytes) ipc.emit('data', Buffer.from([byte]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loads, 1); assert.equal(output.length, 1);
  assert.equal(output[0].id, id); assert.equal(output[0].type, 'fatal');
  assert.match(output[0].message, /native addon unavailable/);
});
