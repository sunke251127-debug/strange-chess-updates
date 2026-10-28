'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { Rendezvous } = require('../dht/rendezvous.cjs');

const key = i => i.toString(16).padStart(64, '0');
const request = i => i.toString(16).padStart(32, '0');

function loadLink() {
  const context = vm.createContext({
    console, EventTarget, Event, MessageEvent, CustomEvent, TextEncoder, TextDecoder,
    SystemRandom: { id: () => 'match_request_1234567890' },
    StrangeChessRooms: {},
    StrangeChessDirect: {
      Link: class extends EventTarget {
        constructor() { super(); this.ended = false; this.readyState = 0; this.transport = ''; }
        state(value) { this.dispatchEvent(new CustomEvent('state', { detail: value })); }
        close(reason = '') { this.ended = true; this.dispatchEvent(new CustomEvent('close', { detail: reason })); }
        pause() {} resume() {}
      }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/dht-link.js'), 'utf8'), context);
  const bridge = { startDht() {}, sendDht() {}, stopDht() {} };
  context.bridge = bridge;
  vm.runInContext('globalThis.link = new StrangeChessDht.Link({ bridge }); globalThis.phases = []; link.addEventListener("matchstatus", event => phases.push(event.detail));', context);
  return context;
}

test('matching phases from the native Rendezvous core reach the UI without pretending to be a connected transport', () => {
  const context = loadLink();
  const link = context.link;
  link.nativeEvent({ type: 'searching' });
  link.nativeEvent({ type: 'hosting', service: 'logical-service' });
  link.nativeEvent({ type: 'coordinator', self: true });
  link.nativeEvent({ type: 'coordinator', self: false });
  link.nativeEvent({ type: 'introducing' });
  link.nativeEvent({ type: 'retry', ticket: 'a'.repeat(32) });
  link.nativeEvent({ type: 'searching' });
  link.nativeEvent({ type: 'notice', message: '当前匹配节点的未完成建连名额已满，正在等待空位后重试。' });
  const phases = Array.from(context.phases, value => String(value.phase));
  assert.deepEqual(phases, ['searching', 'hosting', 'hosting', 'waiting', 'introducing', 'searching', 'searching', 'searching']);
  const messages = Array.from(context.phases, value => String(value.message));
  assert.match(messages[1], /临时提供匹配服务/);
  assert.match(messages[3], /登记并等待/);
  assert.match(messages[4], /建立双方独立连接/);
  assert.match(messages[5], /继续重试/);
  assert.match(messages.at(-1), /名额已满/);
  assert.equal(link.nativeConnected, false, 'matchmaking phases must not mark the game transport connected');
  assert.equal(link.matchPhase, 'searching');
});

test('a full 100-introduction capacity waits, emits one notice and retries after a slot opens', async () => {
  const node = new Rendezvous({ capacity: 2, fullRetryDelay: 40, fullNoticeInterval: 5000 });
  node.id = key(99); node.leader = node.id; node.isCoordinator = true; node.waiting = true; node.readyAt = Number.MAX_SAFE_INTEGER;
  node.queue.join(key(1), request(1), key(101));
  node.queue.join(key(2), request(2), key(102));
  const notices = []; node.on('event', event => { if (event.type === 'notice') notices.push(event.message); });
  node.joinQueue();
  assert.equal(node.queue.players.size, 2);
  assert.ok(node.joinAfter > Date.now(), 'full queue must schedule a later retry');
  assert.equal(notices.length, 1); assert.match(notices[0], /名额已满/);
  node.joinQueue();
  assert.equal(notices.length, 1, 'retries inside the wait window must not spam the player');
  await new Promise(resolve => setTimeout(resolve, 60));
  node.queue.capacity = 3;
  node.joinQueue();
  assert.equal(node.queue.players.size, 3);
  assert.equal(notices.length, 1);
});
