'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { browserRoom } = require('../server/browser-room.cjs');

test('cancelling while the opponent identity is being verified cannot start a late RTC connection or create a ghost game', async () => {
  const subtle = webcrypto.subtle;
  let pendingDigest, holdDigest = false, rtcAllocations = 0;
  const controlledSubtle = new Proxy(subtle, { get(target, name) {
    const value = target[name];
    if (name === 'digest') return (...args) => holdDigest ? new Promise(resolve => { pendingDigest = () => resolve(value.apply(target, args)); }) : value.apply(target, args);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const context = vm.createContext({ console, EventTarget, Event, MessageEvent, CustomEvent, TextEncoder, TextDecoder,
    btoa, atob, setTimeout, clearTimeout, setInterval, clearInterval,
    crypto: { getRandomValues: value => webcrypto.getRandomValues(value), subtle: controlledSubtle },
    RTCPeerConnection: class { constructor() { rtcAllocations++; } } });
  const root = path.resolve(__dirname, '..');
  for (const file of ['src/system-random.js', 'src/game-engine.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
  vm.runInContext(browserRoom(), context);
  for (const file of ['src/relay-channel.js', 'src/peer-link.js', 'src/random-match.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
  const keys = await Promise.all([0, 1].map(() => subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey'])));
  const publics = await Promise.all(keys.map(key => subtle.exportKey('raw', key.publicKey)));
  const b64 = bytes => Buffer.from(bytes).toString('base64url');
  const ids = await Promise.all(publics.map(value => subtle.digest('SHA-256', value).then(b64)));
  const link = new context.StrangeChessRandom.Link();
  link.matchId = ids[0]; link.publicKey = b64(publics[0]); link.identityKeys = keys[0];
  const ticket = { session: 'test_session_for_cancel_123456', from: ids[0], expires: Date.now() + 10000, members: [
    { id: ids[0], pub: b64(publics[0]), request: link.matchRequest },
    { id: ids[1], pub: b64(publics[1]), request: 'opponent_request_123456789' }
  ] };
  holdDigest = true;
  const pending = link.acceptAssignment(ticket);
  assert.equal(typeof pendingDigest, 'function', 'verification must really be pending');
  link.close(); pendingDigest(); await pending;
  assert.equal(rtcAllocations, 0);
  assert.equal(link.pc, null); assert.equal(link.room, null);
  assert.equal(link.assignment, undefined);
});
