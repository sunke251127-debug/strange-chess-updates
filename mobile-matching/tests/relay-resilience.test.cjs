'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { startChessServer } = require('../server/server.cjs');
const { pair } = require('./helpers/direct.cjs');
const { faultBroker } = require('./helpers/fault-broker.cjs');

async function fixture(t, rtc = false) {
  const mqtt = await faultBroker(), server = await startChessServer({ host: '127.0.0.1', port: 0, quiet: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const contexts = [], errors = [], sockets = [];
  t.after(async () => { await Promise.all(contexts.map(c => c.close())); await browser.close(); await server.close(); await mqtt.close(); });
  async function open() {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); contexts.push(context);
    await context.addInitScript(rtc => {
      const Native = RTCPeerConnection;
      window.RTCPeerConnection = rtc ? class extends Native { constructor(options) { super({ ...options, iceServers: [] }); } } : class { constructor() { throw new Error('ICE blocked by this test network'); } };
    }, rtc);
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); page.on('websocket', ws => sockets.push(ws.url()));
    await page.goto(server.url);
    await page.evaluate(url => {
      const Native = StrangeChessDirect.Link;
      StrangeChessDirect.Link = class extends Native {
        constructor(options = {}) {
          super({ ...options, relayUrls: [url], fallbackDelay: 5000, heartbeatInterval: 300, peerTimeout: 1800,
            relayOptions: { reconnectBase: 80, reconnectMax: 250, heartbeatInterval: 300, peerTimeout: 1800, pingInterval: 300, pongTimeout: 1800, retryInterval: 100 } });
          window.testLink = this; window.roomViews = []; window.linkStates = [];
          this.addEventListener('state', event => linkStates.push(event.detail));
          this.addEventListener('message', event => { const value = JSON.parse(event.data); if (value.type === 'room') roomViews.push(value); });
        }
      };
    }, mqtt.url);
    return page;
  }
  const host = await open(), guest = await open(); await pair(host, guest);
  return { mqtt, server, host, guest, errors, sockets };
}
async function move(page, other, number) {
  await page.locator('.cell.is-selectable').first().tap(); await page.locator('.cell.is-legal, .cell.is-capture').first().tap();
  for (const target of [page, other]) await target.waitForFunction(n => document.querySelector('#moveNumber').textContent.includes('第 ' + n + ' 手'), number);
}
async function healthy(host, guest) {
  for (const page of [host, guest]) {
    await page.waitForFunction(() => document.querySelector('#connBadge').textContent === '已连接' && document.querySelector('#roomStatusText').textContent.includes('对局进行中'));
  }
}
async function sameState(host, guest) {
  const a = await host.evaluate(() => roomViews.at(-1)), b = await guest.evaluate(() => roomViews.at(-1));
  assert.equal(a.roomCode, b.roomCode); assert.deepEqual(a.state, b.state);
  return a;
}

test('friend UI keeps the original game through a 32-second outage and repeated broker restarts without another invitation', { timeout: 65000 }, async t => {
  const { mqtt, host, guest, server, errors } = await fixture(t);
  await move(host, guest, 1); const before = await sameState(host, guest);
  mqtt.block('guest');
  for (const page of [host, guest]) await page.waitForFunction(() => document.querySelector('#connBadge').textContent === '重连中');
  assert.equal(await host.evaluate(() => mobileGame.hasRoom()), true);
  assert.match(await host.locator('#roomStatusText').textContent(), /棋局已保留/);
  await guest.evaluate(() => testLink.relay.send({ type: 'sync' }));
  // Real elapsed time crosses the old fatal 30-second ACK timeout. The browser
  // remains on the game page throughout; no fake clock or weakened deadline.
  await new Promise(resolve => setTimeout(resolve, 32000));
  for (const page of [host, guest]) assert.equal(await page.evaluate(() => testLink.ended || testLink.relay.closed), false);
  assert.ok(await guest.evaluate(() => testLink.relay.unconfirmed.size > 0));
  mqtt.unblock('guest'); await guest.evaluate(() => window.dispatchEvent(new Event('online')));
  await healthy(host, guest); const after = await sameState(host, guest);
  assert.equal(after.roomCode, before.roomCode); assert.deepEqual(after.state, before.state);
  await move(guest, host, 2);
  for (let i = 0; i < 2; i++) {
    const checkpoint = await host.evaluate(() => linkStates.length), connections = mqtt.connections;
    mqtt.drop();
    await host.waitForFunction(at => linkStates.slice(at).includes('reconnecting'), checkpoint);
    await healthy(host, guest); await sameState(host, guest);
    assert.ok(mqtt.connections >= connections + 2, 'each broker restart must establish new subscriptions');
    for (const page of [host, guest]) assert.equal(await page.evaluate(() => testLink.ended), false);
  }
  await move(host, guest, 3); await sameState(host, guest);
  assert.equal(await host.evaluate(() => testLink.room.gameCount), 1, 'reconnect must not initialize a new board');
  assert.equal(server.manager.rooms.size, 0);
  assert.equal(Buffer.concat(mqtt.published).includes(Buffer.from('"pieces"')), false);
  assert.deepEqual(errors, []);
});

test('silent half-open sockets are detected by PINGRESP deadlines and replaced while an idle game stays intact', { timeout: 20000 }, async t => {
  const { mqtt, host, guest, errors } = await fixture(t);
  await move(host, guest, 1); const before = await sameState(host, guest), count = mqtt.connections;
  mqtt.blackhole();
  await host.waitForFunction(() => document.querySelector('#connBadge').textContent === '重连中');
  await healthy(host, guest);
  assert.ok(mqtt.connections >= count + 2, 'both clients must open a fresh MQTT subscription');
  assert.deepEqual((await sameState(host, guest)).state, before.state);
  await move(guest, host, 2); assert.deepEqual(errors, []);
});

test('a live broker cannot mask an unreachable peer, and peer recovery resumes the same board without redial', { timeout: 18000 }, async t => {
  const { mqtt, host, guest, errors } = await fixture(t);
  await move(host, guest, 1);
  for (const page of [host, guest]) await page.waitForFunction(() => testLink.relay.peerConnected);
  const connections = mqtt.connections, before = await sameState(host, guest);
  mqtt.mute('host'); mqtt.mute('guest');
  for (const page of [host, guest]) await page.waitForFunction(() => document.querySelector('#connBadge').textContent === '重连中');
  assert.equal(mqtt.connections, connections, 'broker PINGRESP is healthy; the failure is end-to-end peer reachability');
  for (const page of [host, guest]) assert.equal(await page.evaluate(() => mobileGame.hasRoom() && !testLink.ended), true);
  mqtt.unmute('host'); mqtt.unmute('guest'); await healthy(host, guest);
  assert.deepEqual((await sameState(host, guest)).state, before.state);
  await move(guest, host, 2); assert.deepEqual(errors, []);
});

test('lost move confirmation is retransmitted after reconnect and applies exactly once', { timeout: 20000 }, async t => {
  const { mqtt, host, guest, errors } = await fixture(t);
  await move(host, guest, 1);
  mqtt.mute('guest');
  await guest.locator('.cell.is-selectable').first().tap(); await guest.locator('.cell.is-legal').first().tap();
  await host.waitForFunction(() => roomViews.at(-1).state.moveNumber === 2);
  assert.ok(await guest.evaluate(() => testLink.relay.unconfirmed.size > 0));
  mqtt.drop(); mqtt.unmute('guest');
  await healthy(host, guest);
  await guest.waitForFunction(() => roomViews.at(-1).state.moveNumber === 2 && testLink.relay.unconfirmed.size === 0);
  assert.equal((await sameState(host, guest)).state.moveNumber, 2);
  await move(host, guest, 3); await move(guest, host, 4);
  assert.equal((await sameState(host, guest)).state.moveNumber, 4); assert.deepEqual(errors, []);
});

test('an established real RTC game migrates to relay after its data channel breaks without losing seats or hidden-piece identities', { timeout: 25000 }, async t => {
  const { mqtt, host, guest, errors, sockets } = await fixture(t, true);
  assert.deepEqual(sockets, [], 'a healthy direct connection must not use any relay');
  await move(host, guest, 1); const before = await sameState(host, guest);
  await host.evaluate(() => testLink.channel.close());
  for (const page of [host, guest]) await page.waitForFunction(() => testLink.transport === 'relay' && testLink.readyState === 1 && roomViews.at(-1).transport === 'relay');
  await healthy(host, guest); const after = await sameState(host, guest);
  assert.equal(after.roomCode, before.roomCode); assert.deepEqual(after.state, before.state);
  assert.ok(mqtt.connections >= 2);
  assert.equal(await host.evaluate(() => testLink.room.gameCount), 1);
  assert.ok(after.state.pieces.some(p => !Object.hasOwn(p, 'kind') && !Object.hasOwn(p, 'color')));
  await move(guest, host, 2); await sameState(host, guest); assert.deepEqual(errors, []);
});
