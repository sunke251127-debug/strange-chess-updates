'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../src/system-random.js');
const E = require('../src/game-engine.js');
const { startChessServer } = require('../server/server.cjs');
test('local and server shuffles use OS entropy with Math.random unavailable and preserve piece counts/rules', async () => {
  const original = Math.random; Math.random = () => { throw new Error('insecure RNG used'); };
  let server;
  try {
    for (let i=0; i<10; i++) {
      const state = R.game(E); assert.equal(state.pieces.length, 32);
      for (const color of ['red','black']) assert.equal(state.pieces.filter(p => p.color === color).length, 16);
      assert.equal(state.pieces.filter(p => p.kind === 'king').length, 2);
      assert.ok(state.pieces.every(p => !p.faceUp));
    }
    server = await startChessServer({ host: '127.0.0.1', port: 0, quiet: true });
    assert.equal(server.manager.createRoom().game.pieces.length, 32);
    assert.notEqual(R.id(), R.id());
  } finally { Math.random = original; await server?.close(); }
});
test('integer sampling rejects biased overflow and refuses missing system randomness', () => {
  let count = 0;
  const context = vm.createContext({ Uint8Array, Number, Math, Error, crypto: { getRandomValues: array => { count++; array.fill(count === 1 ? 255 : 0); return array; } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/system-random.js'), 'utf8'), context);
  assert.equal(context.SystemRandom.integer(3), 0); assert.equal(count, 2);
  assert.throws(() => R.integer(0)); assert.throws(() => R.bytes(4097));
  const missing = vm.createContext({ Uint8Array, Number, Math, Error });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/system-random.js'), 'utf8'), missing);
  assert.throws(() => missing.SystemRandom.bytes(4), /随机源不可用/);
});
