'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const DHT = require('hyperdht');
const { Matchmaker } = require('../dht/matchmaker.cjs');
const { browserRoom } = require('../server/browser-room.cjs');

function until(predicate, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const check = () => {
      let value;
      try { value = predicate(); } catch (error) { reject(error); return; }
      if (value) resolve(value);
      else if (Date.now() > deadline) reject(new Error('DHT condition timeout'));
      else setTimeout(check, 20);
    };
    check();
  });
}

async function fixture(run) {
  const reservation = dgram.createSocket('udp4'); reservation.bind(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const bootstrap = DHT.bootstrapper(port, '127.0.0.1');
  await bootstrap.fullyBootstrapped();
  const clients = [];
  function client() {
    const match = new Matchmaker({ dht: { bootstrap: [port], firewalled: false }, heartbeatInterval: 100, peerTimeout: 2500, reservationTimeout: 3000, discoveryInterval: 250 });
    match.events = []; match.on('event', value => match.events.push(value)); clients.push(match); return match;
  }
  try { await run({ client, clients, bootstrap }); }
  finally { await Promise.all(clients.map(value => value.close())); await bootstrap.destroy(); }
}

test('real HyperDHT discovery pairs exactly two peers and exchanges framed, acknowledged data without a game server', { timeout: 40000 }, async () => {
  await fixture(async ({ client }) => {
    const a = client().start(), b = client().start();
    await until(() => a.pair && b.pair);
    assert.equal(a.pair.peer, b.id); assert.equal(b.pair.peer, a.id);
    assert.equal(a.pair.session, b.pair.session); assert.notEqual(a.pair.host, b.pair.host);
    a.send({ text: '中文棋步\n测试', move: [0, 6, 0, 5] });
    b.send({ text: 'reply' });
    await until(() => a.events.some(e => e.type === 'data') && b.events.some(e => e.type === 'data'));
    assert.deepEqual(b.events.find(e => e.type === 'data').body, { text: '中文棋步\n测试', move: [0, 6, 0, 5] });
    await until(() => a.pending.size === 0 && b.pending.size === 0);
    // Retransmission of an already delivered sequence must never apply a move twice.
    a.write(a.active, { kind: 'data', session: a.pair.session, seq: 1, body: { duplicate: true } });
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.equal(b.events.filter(e => e.type === 'data').length, 1);
  });
});

test('concurrent real DHT peers never double-match; cancelled search cannot become a ghost opponent', { timeout: 50000 }, async () => {
  await fixture(async ({ client }) => {
    const cancelled = client().start(); await cancelled.close();
    const peers = Array.from({ length: 4 }, () => client().start());
    await until(() => peers.every(value => value.pair), 25000);
    assert.equal(new Set(peers.map(value => value.pair.session)).size, 2);
    for (const peer of peers) {
      const other = peers.find(value => value.id === peer.pair.peer);
      assert.ok(other); assert.equal(other.pair.peer, peer.id);
      assert.equal(other.pair.session, peer.pair.session);
      assert.equal(peer.events.filter(e => e.type === 'paired').length, 1);
    }
    assert.equal(cancelled.events.some(e => e.type === 'paired'), false);
  });
});

test('a broken Noise connection resumes only its locked opponent and does not redeliver acknowledged data', { timeout: 50000 }, async () => {
  await fixture(async ({ client }) => {
    const a = client().start(), b = client().start();
    await until(() => a.pair && b.pair);
    const session = a.pair.session;
    a.send({ move: 1 }); await until(() => b.received === 1 && a.pending.size === 0);
    a.active.socket.destroy();
    await until(() => a.events.some(e => e.type === 'disconnected'));
    const waiting = client().start();
    await until(() => a.events.some(e => e.type === 'reconnected') && b.events.some(e => e.type === 'reconnected'), 25000);
    assert.equal(a.pair.session, session); assert.equal(b.pair.session, session); assert.equal(waiting.pair, null);
    b.send({ move: 2 }); await until(() => a.events.some(e => e.type === 'data' && e.body.move === 2));
    assert.equal(b.events.filter(e => e.type === 'data').length, 1);
  });
});

test('a lost final pairing acknowledgement completes with the same reservation after real transport reconnection', { timeout: 45000 }, async () => {
  await fixture(async ({ client }) => {
    const a = client(), b = client();
    let dropped = false;
    for (const peer of [a, b]) {
      const original = peer.write.bind(peer);
      peer.write = (socket, value) => {
        if (value.kind === 'ready' && !dropped) { dropped = true; socket.socket.destroy(); return false; }
        return original(socket, value);
      };
    }
    a.start(); b.start();
    await until(() => a.active && b.active, 25000);
    assert.ok(dropped); assert.equal(a.pair.session, b.pair.session);
    assert.equal(a.pair.peer, b.id); assert.equal(b.pair.peer, a.id);
    a.send({ afterLostReady: true });
    await until(() => b.events.some(event => event.type === 'data' && event.body.afterLostReady));
  });
});

function browserClient(match) {
  const context = vm.createContext({ console, EventTarget, Event, MessageEvent, CustomEvent, TextEncoder, TextDecoder,
    crypto: webcrypto, btoa, atob, setTimeout, clearTimeout, setInterval, clearInterval });
  const root = path.resolve(__dirname, '..');
  for (const file of ['src/game-engine.js', 'src/system-random.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
  vm.runInContext(browserRoom(), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'src/peer-link.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'src/dht-link.js'), 'utf8'), context);
  let id;
  match.on('event', value => context.receiveDhtEvent(id, value));
  context.AndroidShell = {
    startDht(value) { id = value; match.start(); },
    sendDht(_id, raw) { match.send(JSON.parse(raw)); },
    stopDht() { void match.close(); }
  };
  vm.runInContext('globalThis.link = new StrangeChessDht.Link(); globalThis.messages = []; link.addEventListener("message", event => messages.push(JSON.parse(event.data))); link.start();', context);
  return context;
}

test('the actual browser DHT link hosts the existing concealed game and synchronizes both players legal moves', { timeout: 45000 }, async () => {
  await fixture(async ({ client }) => {
    const a = browserClient(client()), b = browserClient(client());
    try {
      const room = context => context.messages.filter(value => value.type === 'room').at(-1);
      await until(() => room(a)?.status === 'playing' && room(b)?.status === 'playing');
      const host = a.link.host ? a : b, guest = a.link.host ? b : a;
      const plain = value => JSON.parse(JSON.stringify(value));
      assert.equal(host.link.transport, 'dht'); assert.equal(guest.link.transport, 'dht');
      assert.equal(room(host).roomCode, room(guest).roomCode);
      assert.ok(room(guest).state.pieces.every(piece => !Object.hasOwn(piece, 'kind') && !Object.hasOwn(piece, 'color')));
      function move(context) {
        const state = room(context).state;
        const piece = state.pieces.find(p => context.StrangeChess.legalMoves(state, p.x, p.y).length);
        const to = context.StrangeChess.legalMoves(state, piece.x, piece.y)[0];
        context.link.send(JSON.stringify({ type: 'move', fromX: piece.x, fromY: piece.y, toX: to.x, toY: to.y }));
      }
      move(host); await until(() => room(host).state.moveNumber === 1 && room(guest).state.moveNumber === 1);
      assert.deepEqual(plain(room(host).state), plain(room(guest).state));
      move(guest); await until(() => room(host).state.moveNumber === 2 && room(guest).state.moveNumber === 2);
      assert.deepEqual(plain(room(host).state), plain(room(guest).state));
      guest.link.send(JSON.stringify({ type: 'move', fromX: 0, fromY: 0, toX: 0, toY: 1 }));
      await until(() => guest.messages.some(value => value.type === 'error' && value.code === 'NOT_YOUR_TURN'));
      assert.equal(room(host).state.moveNumber, 2);
    } finally { a.link.close(); b.link.close(); }
  });
});
