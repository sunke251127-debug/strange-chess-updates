'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { once } = require('node:events');
const DHT = require('hyperdht');
const crypto = require('hypercore-crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { browserRoom } = require('../server/browser-room.cjs');
const { IntroductionQueue } = require('../dht/introduction-queue.cjs');
const { Rendezvous, SERVICE, TOPIC } = require('../dht/rendezvous.cjs');

const key = i => i.toString(16).padStart(64, '0');
const request = i => i.toString(16).padStart(32, '0');
function until(predicate, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    function check() {
      let value;
      try { value = predicate(); } catch (error) { reject(error); return; }
      if (value) resolve(value);
      else if (Date.now() > deadline) reject(new Error('Rendezvous condition timed out'));
      else setTimeout(check, 20);
    }
    check();
  });
}

test('100 introductions reserve each player once and release all information after both connection confirmations', () => {
  const queue = new IntroductionQueue();
  for (let i = 1; i <= 100; i++) assert.equal(queue.join(key(i), request(i), key(i + 1000)).status, 'waiting');
  assert.equal(queue.join(key(101), request(101), key(1101)).status, 'full');
  assert.equal(queue.join(key(1), request(1), key(1001)).status, 'waiting');
  assert.equal(queue.players.size, 100);
  const tickets = queue.pair();
  assert.equal(tickets.length, 50);
  assert.equal(new Set(tickets.flatMap(ticket => ticket.players.map(player => player.id))).size, 100);
  assert.equal(queue.pair().length, 0);
  const first = tickets[0];
  assert.equal(queue.confirm(key(999), request(999), first.id), false);
  assert.equal(queue.confirm(first.players[0].id, request(999), first.id), false);
  for (const ticket of tickets) {
    assert.deepEqual(Object.keys(ticket).sort(), ['expires', 'id', 'players', 'topic']);
    for (const player of ticket.players) assert.equal(queue.confirm(player.id, player.request, ticket.id), true);
  }
  assert.equal(queue.players.size, 0);
  assert.equal(queue.tickets.size, 0);
  assert.equal(queue.join(key(101), request(101), key(1101)).status, 'waiting');
});

test('cancelled requests, duplicate requests and expired handshakes do not occupy the queue indefinitely', () => {
  let now = 1000;
  const queue = new IntroductionQueue({ now: () => now, ttl: 100 });
  queue.join(key(1), request(1), key(1001));
  assert.equal(queue.join(key(1), request(2), key(1001)).status, 'busy');
  assert.deepEqual(queue.cancel(key(1), request(2)), []);
  assert.equal(queue.players.size, 1);
  queue.cancel(key(1), request(1));
  queue.join(key(2), request(2), key(1002)); queue.join(key(3), request(3), key(1003));
  const ticket = queue.pair()[0];
  assert.equal(queue.players.size, 2);
  now += 101;
  assert.equal(queue.expire()[0].id, ticket.id);
  assert.equal(queue.players.size, 0); assert.equal(queue.tickets.size, 0);
});

async function fixture(run) {
  const reservation = dgram.createSocket('udp4'); reservation.bind(0, '127.0.0.1');
  await once(reservation, 'listening'); const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const bootstrap = DHT.bootstrapper(port, '127.0.0.1'); await bootstrap.fullyBootstrapped();
  const topic = crypto.randomBytes(32), clients = [];
  function client(extra = {}) {
    const node = new Rendezvous({ topic, dht: { bootstrap: [port], firewalled: false },
      heartbeatInterval: 80, peerTimeout: 2200, discoveryInterval: 180, electionDelay: 280,
      electionSettle: 500, ticketTimeout: 12000, ...extra });
    node.events = []; node.on('event', event => node.events.push(event)); clients.push(node);
    return node;
  }
  try { await run({ client, clients }); }
  finally { await Promise.all(clients.map(node => node.close())); await bootstrap.destroy(); }
}

test('the fixed logical service starts without a player server and elects a single coordinator to introduce two players', { timeout: 30000 }, async () => {
  assert.equal(typeof SERVICE, 'string'); assert.equal(TOPIC.length, 32);
  await fixture(async ({ client }) => {
    const a = client().start(), b = client().start();
    await until(() => a.pair && b.pair);
    assert.equal(a.pair.session, b.pair.session);
    assert.notEqual(a.pair.host, b.pair.host);
    assert.equal(a.pair.peer, b.game.id); assert.equal(b.pair.peer, a.game.id);
    const coordinator = [a, b].find(node => node.isCoordinator);
    assert.ok(coordinator);
    await until(() => coordinator.queue.players.size === 0 && coordinator.queue.tickets.size === 0);
    a.send({ check: '棋步A' }); b.send({ check: '棋步B' });
    await until(() => a.events.some(event => event.type === 'data') && b.events.some(event => event.type === 'data'));
    assert.deepEqual(a.events.find(event => event.type === 'data').body, { check: '棋步B' });
  });
});

test('an introduction server can disappear entirely while an established independent game continues, and new players can create its successor', { timeout: 35000 }, async () => {
  await fixture(async ({ client }) => {
    const server = client({ coordinatorOnly: true, electionDelay: 0 }).start();
    await until(() => server.isCoordinator);
    const a = client().start(), b = client().start();
    await until(() => a.pair && b.pair);
    await until(() => server.queue.players.size === 0 && server.queue.tickets.size === 0);
    const session = a.pair.session;
    await server.close();
    a.send({ move: 1 }); b.send({ move: 2 });
    await until(() => a.events.some(event => event.type === 'data') && b.events.some(event => event.type === 'data'));
    assert.equal(a.pair.session, session); assert.equal(b.pair.session, session);
    const c = client().start(), d = client().start();
    await until(() => c.pair && d.pair);
    assert.notEqual(c.pair.session, session);
    a.send({ move: 3 });
    await until(() => b.events.some(event => event.type === 'data' && event.body.move === 3));
    assert.equal(a.game.closed, false); assert.equal(b.game.closed, false);
  });
});

test('a waiting player takes over a departed coordinator and cancelled searches never become opponents', { timeout: 35000 }, async () => {
  await fixture(async ({ client }) => {
    const server = client({ coordinatorOnly: true, electionDelay: 0 }).start();
    await until(() => server.isCoordinator);
    const cancelled = client().start();
    await until(() => server.queue.players.has(cancelled.id)); await cancelled.close();
    await until(() => !server.queue.players.has(cancelled.id));
    const a = client().start(); await until(() => server.queue.players.has(a.id));
    await server.close(); await until(() => a.isCoordinator);
    const b = client().start(); await until(() => a.pair && b.pair);
    assert.equal(a.pair.session, b.pair.session);
    assert.equal(cancelled.events.some(event => event.type === 'paired'), false);
    assert.equal(cancelled.game, null);
  });
});

test('an introduced direct game reconnects to the same opponent after losing its Noise socket without needing the coordinator', { timeout: 35000 }, async () => {
  await fixture(async ({ client }) => {
    const server = client({ coordinatorOnly: true, electionDelay: 0 }).start();
    await until(() => server.isCoordinator);
    const a = client().start(), b = client().start();
    await until(() => a.pair && b.pair);
    await server.close(); const session = a.pair.session;
    a.send({ move: 1 }); await until(() => a.pending.size === 0 && b.game.received === 1);
    a.active.socket.destroy();
    await until(() => a.events.some(event => event.type === 'reconnected') && b.events.some(event => event.type === 'reconnected'));
    b.send({ move: 2 }); await until(() => a.events.some(event => event.type === 'data' && event.body.move === 2));
    assert.equal(a.pair.session, session); assert.equal(b.pair.session, session);
    assert.equal(b.events.filter(event => event.type === 'data').length, 1);
  });
});

function browserClient(match) {
  const context = vm.createContext({ console, EventTarget, Event, MessageEvent, CustomEvent, TextEncoder, TextDecoder,
    crypto: webcrypto, btoa, atob, setTimeout, clearTimeout, setInterval, clearInterval });
  const root = path.resolve(__dirname, '..');
  for (const file of ['src/system-random.js', 'src/game-engine.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
  vm.runInContext(browserRoom(), context);
  for (const file of ['src/peer-link.js', 'src/dht-link.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
  context.nativeBridge = { startDht: () => match.start(), sendDht: (_, raw) => match.send(JSON.parse(raw)), stopDht: () => { void match.close(); } };
  vm.runInContext('globalThis.messages = []; globalThis.link = new StrangeChessDht.Link({ bridge: nativeBridge }); link.addEventListener("message", event => messages.push(JSON.parse(event.data)));', context);
  match.on('event', event => context.link.nativeEvent(event));
  return context;
}

test('the existing mobile native link plays the concealed game through introductions and continues moves after its matching server shuts down', { timeout: 35000 }, async () => {
  await fixture(async ({ client }) => {
    const server = client({ coordinatorOnly: true, electionDelay: 0 }).start(); await until(() => server.isCoordinator);
    const a = browserClient(client()), b = browserClient(client());
    a.link.start(); b.link.start();
    const room = context => [...context.messages].reverse().find(message => message.type === 'room');
    const plain = value => JSON.parse(JSON.stringify(value));
    try {
      await until(() => room(a)?.status === 'playing' && room(b)?.status === 'playing');
      assert.deepEqual(plain(room(a).state), plain(room(b).state));
      assert.ok(room(b).state.pieces.every(piece => !Object.hasOwn(piece, 'kind') && !Object.hasOwn(piece, 'color')));
      await until(() => server.queue.players.size === 0 && server.queue.tickets.size === 0);
      await server.close();
      const host = a.link.host ? a : b, guest = a.link.host ? b : a;
      function move(context) {
        const state = room(context).state;
        const piece = state.pieces.find(piece => context.StrangeChess.legalMoves(state, piece.x, piece.y).length);
        const to = context.StrangeChess.legalMoves(state, piece.x, piece.y)[0];
        context.link.send(JSON.stringify({ type: 'move', fromX: piece.x, fromY: piece.y, toX: to.x, toY: to.y }));
      }
      move(host); await until(() => room(host).state.moveNumber === 1 && room(guest).state.moveNumber === 1);
      move(guest); await until(() => room(host).state.moveNumber === 2 && room(guest).state.moveNumber === 2);
      assert.deepEqual(plain(room(host).state), plain(room(guest).state));
      assert.equal(host.link.transport, 'dht'); assert.equal(guest.link.transport, 'dht');
    } finally { a.link.close(); b.link.close(); }
  });
});
