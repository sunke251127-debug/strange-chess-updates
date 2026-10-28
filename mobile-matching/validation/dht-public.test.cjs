'use strict';
// Opt-in public-network test. No local bootstrap or mocked discovery is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('hypercore-crypto');
const { Matchmaker } = require('../dht/matchmaker.cjs');

test('public HyperDHT bootstrap discovers two isolated-topic peers and carries bidirectional encrypted traffic', { timeout: 100000 }, async () => {
  const topic = crypto.randomBytes(32);
  const a = new Matchmaker({ topic }), b = new Matchmaker({ topic });
  const received = [[], []];
  const events = [[], []];
  [a, b].forEach((peer, index) => peer.on('event', event => {
    events[index].push(event.type);
    if (event.type === 'data') received[index].push(event.body);
  }));
  let timer;
  try {
    a.start(); b.start();
    await new Promise((resolve, reject) => {
      const check = setInterval(() => {
        if (a.active && b.active) { clearInterval(check); clearTimeout(timer); resolve(); }
      }, 100);
      timer = setTimeout(() => { clearInterval(check); reject(new Error('Public DHT not reachable or peers could not connect; events=' + JSON.stringify(events))); }, 85000);
    });
    assert.equal(a.pair.session, b.pair.session);
    a.send({ probe: 'a-to-b' }); b.send({ probe: 'b-to-a' });
    await new Promise((resolve, reject) => {
      const check = setInterval(() => {
        if (received.every(values => values.length)) { clearInterval(check); clearTimeout(timer); resolve(); }
      }, 50);
      timer = setTimeout(() => { clearInterval(check); reject(new Error('Public encrypted stream timed out')); }, 10000);
    });
    assert.deepEqual(received[0], [{ probe: 'b-to-a' }]);
    assert.deepEqual(received[1], [{ probe: 'a-to-b' }]);
  } finally { clearTimeout(timer); await Promise.all([a.close(), b.close()]); }
});
