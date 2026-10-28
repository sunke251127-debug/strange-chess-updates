'use strict';
// Opt-in public-network check for the permanent logical matching service.
// It uses the default public HyperDHT bootstrap and a random isolated topic;
// no local bootstrap, mock discovery or real player is involved.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('hypercore-crypto');
const { Rendezvous } = require('../dht/rendezvous.cjs');

test('public HyperDHT introduces two isolated-topic clients through the fixed matching service and carries bidirectional encrypted game traffic', { timeout: 120000 }, async () => {
  const topic = crypto.randomBytes(32);
  const options = { topic, heartbeatInterval: 300, discoveryInterval: 1800, electionDelay: 1200, electionSettle: 600, ticketTimeout: 20000 };
  const a = new Rendezvous(options), b = new Rendezvous(options);
  const received = [[], []], events = [[], []];
  [a, b].forEach((node, index) => node.on('event', event => {
    events[index].push(event.type);
    if (event.type === 'data') received[index].push(event.body);
  }));
  let timer;
  try {
    a.start(); b.start();
    await new Promise((resolve, reject) => {
      const check = setInterval(() => {
        if (a.pair && b.pair) { clearInterval(check); clearTimeout(timer); resolve(); }
      }, 100);
      timer = setTimeout(() => { clearInterval(check); reject(new Error('Public matching service did not introduce peers; events=' + JSON.stringify(events))); }, 95000);
    });
    assert.equal(a.pair.session, b.pair.session);
    assert.notEqual(a.pair.host, b.pair.host);
    a.send({ probe: 'a-to-b' }); b.send({ probe: 'b-to-a' });
    await new Promise((resolve, reject) => {
      const check = setInterval(() => {
        if (received.every(values => values.length)) { clearInterval(check); clearTimeout(timer); resolve(); }
      }, 50);
      timer = setTimeout(() => { clearInterval(check); reject(new Error('Public matched game traffic timed out')); }, 12000);
    });
    assert.deepEqual(received[0], [{ probe: 'b-to-a' }]);
    assert.deepEqual(received[1], [{ probe: 'a-to-b' }]);
    assert.ok(events.flat().includes('introducing') || events.flat().includes('searching'));
  } finally { clearTimeout(timer); await Promise.all([a.close(), b.close()]); }
});
