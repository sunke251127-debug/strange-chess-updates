'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { once } = require('node:events');
const DHT = require('hyperdht');
const { Matchmaker } = require('../dht/matchmaker.cjs');

test('a WebView send racing the native disconnect is queued for the same peer and delivered once after reconnect', { timeout: 45000 }, async () => {
  const reservation = dgram.createSocket('udp4'); reservation.bind(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const bootstrap = DHT.bootstrapper(port, '127.0.0.1'); await bootstrap.fullyBootstrapped();
  const options = { dht: { bootstrap: [port], firewalled: false }, heartbeatInterval: 100, discoveryInterval: 250, peerTimeout: 2500 };
  const a = new Matchmaker(options), b = new Matchmaker(options);
  async function wait(client, type, predicate = () => true) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { client.off('event', listener); reject(new Error('DHT event timeout: ' + type)); }, 20000);
      function listener(event) {
        if (event.type === type && predicate(event)) { clearTimeout(timer); client.off('event', listener); resolve(event); }
      }
      client.on('event', listener);
    });
  }
  try {
    const paired = Promise.all([wait(a, 'paired'), wait(b, 'paired')]); a.start(); b.start(); await paired;
    const originalPeer = a.pair.peer;
    const disconnected = wait(a, 'disconnected');
    const reconnected = wait(a, 'reconnected');
    const delivered = wait(b, 'data', event => event.body.pendingMove === 1);
    let count = 0; b.on('event', event => { if (event.type === 'data') count++; });
    a.active.socket.destroy(); await disconnected;
    assert.equal(a.active, null);
    assert.doesNotThrow(() => a.send({ pendingMove: 1 }));
    assert.equal(a.closed, false); assert.equal(a.pending.size, 1);
    await reconnected; await delivered;
    assert.equal(a.pair.peer, originalPeer); assert.equal(count, 1);
  } finally { await Promise.all([a.close(), b.close()]); await bootstrap.destroy(); }
});
