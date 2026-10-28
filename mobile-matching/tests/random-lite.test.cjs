'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { startChessServer } = require('../server/server.cjs');
const { faultBroker } = require('./helpers/fault-broker.cjs');

async function fixture(run, disableRtc = false) {
  const broker = await faultBroker();
  const server = await startChessServer({ host: '127.0.0.1', port: 0, quiet: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const errors = [];
  async function open() {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await context.addInitScript(disabled => {
      window.nativeCalls = 0;
      window.AndroidShell = { isDhtAvailable: () => true, startDht() { nativeCalls++; throw Error('Native runtime cannot start on this phone'); } };
      if (disabled) window.RTCPeerConnection = class { constructor() { throw Error('UDP unavailable'); } };
    }, disableRtc);
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(server.url); await page.locator('#boardGrid .cell').last().waitFor();
    await page.evaluate(url => {
      const Native = StrangeChessRandom.Link;
      window.StrangeChessRandom = { ...StrangeChessRandom, Link: class extends Native {
        constructor(options = {}) {
          super({ ...options, discoveryUrls: [url], relayUrls: [url], iceServers: [],
            electionDelay: 50, electionSettle: 180, matchInterval: 100, nodeTimeout: 1000,
            introductionTimeout: 12000, discoveryReleaseDelay: 700, gatherTimeout: 400, fallbackDelay: 300,
            relayOptions: { heartbeatInterval: 200, retryInterval: 100, peerTimeout: 2000 } });
          window.testRandom = this; window.roomEvents = [];
          this.addEventListener('message', event => { const value = JSON.parse(event.data); if (value.type === 'room') roomEvents.push(value); });
        }
      } };
    }, broker.url);
    return page;
  }
  try { await run({ broker, server, browser, open, errors }); }
  finally { await browser.close(); await server.close(); await broker.close(); }
}
async function start(page) { await page.locator('#onlineModeBtn').click(); await page.locator('#randomMatchBtn').click(); }
async function playing(pages) { for (const page of pages) await page.waitForFunction(() => window.mobileGame.hasRoom() && document.querySelector('#roomStatusText').textContent.includes('对局进行中')); }
async function move(page, number, peers) {
  await page.locator('.cell.is-selectable').first().tap(); await page.locator('.cell.is-legal, .cell.is-capture').first().tap();
  for (const peer of peers) await peer.waitForFunction(n => window.roomEvents.at(-1)?.state.moveNumber === n, number);
}
async function sides(a, b) { return (await a.locator('#seatBadge').textContent()).includes('红') ? [a, b] : [b, a]; }

test('normal random button bypasses a failing native runtime, introduces real RTC peers, releases records and keeps playing after the matching node exits', { timeout: 45000 }, async () => {
  await fixture(async ({ open, broker, errors }) => {
    const a = await open(), b = await open(); await start(a); await start(b); await playing([a, b]);
    for (const page of [a, b]) {
      assert.equal(await page.evaluate(() => nativeCalls), 0);
      assert.equal(await page.evaluate(() => testRandom.transport), 'rtc');
      assert.ok((await page.evaluate(() => roomEvents.at(-1).state.pieces)).every(piece => !Object.hasOwn(piece, 'kind') && !Object.hasOwn(piece, 'color')));
    }
    const leader = await a.evaluate(() => testRandom.isCoordinator) ? a : b;
    await leader.waitForFunction(() => testRandom.players.size === 0 && testRandom.introductions.size === 0);
    const [host, guest] = await sides(a, b); await move(host, 1, [a, b]); await move(guest, 2, [a, b]);
    const c = await open(); await start(c);
    await c.waitForFunction(() => Boolean(testRandom.leader) && !testRandom.assignment);
    await leader.evaluate(() => testRandom.stopMatching());
    await move(host, 3, [a, b]); await move(guest, 4, [a, b]);
    assert.deepEqual(await a.evaluate(() => roomEvents.at(-1).state), await b.evaluate(() => roomEvents.at(-1).state));
    const raw = Buffer.concat(broker.published).toString('utf8');
    assert.equal(raw.includes('SC-DIRECT-1:'), false, 'signalling offers and relay secrets are encrypted even from the coordinator');
    assert.equal(raw.includes('"pieces"'), false);
    for (const page of [a, b]) assert.equal(raw.includes(await page.evaluate(() => testRandom.relayKey)), false);
    await c.waitForFunction(() => testRandom.isCoordinator);
    const d = await open(); await start(d); await playing([c, d]);
    assert.ok(await c.evaluate(() => testRandom.assignment.session) !== await a.evaluate(() => testRandom.assignment.session));
    const [nextHost, nextGuest] = await sides(c, d); await move(nextHost, 1, [c, d]); await move(nextGuest, 2, [c, d]);
    assert.deepEqual(errors, []);
  });
});

test('random matching automatically falls back to the existing encrypted game relay when both phones have no working WebRTC', { timeout: 45000 }, async () => {
  await fixture(async ({ open, broker, errors }) => {
    const a = await open(), b = await open(); await start(a); await start(b); await playing([a, b]);
    for (const page of [a, b]) { assert.equal(await page.evaluate(() => nativeCalls), 0); assert.equal(await page.evaluate(() => testRandom.transport), 'relay'); }
    const [host, guest] = await sides(a, b); await move(host, 1, [a, b]); await move(guest, 2, [a, b]);
    assert.deepEqual(await a.evaluate(() => roomEvents.at(-1).state), await b.evaluate(() => roomEvents.at(-1).state));
    const raw = Buffer.concat(broker.published).toString('utf8');
    assert.equal(raw.includes('SC-DIRECT-1:'), false); assert.equal(raw.includes('"pieces"'), false);
    assert.deepEqual(errors, []);
  }, true);
});

test('cancelled random searches close discovery and a startup error is visible beside the matching button', { timeout: 20000 }, async () => {
  await fixture(async ({ open, errors }) => {
    const page = await open(); await start(page); await page.locator('#cancelRandomBtn').waitFor();
    await page.locator('#cancelRandomBtn').click(); assert.equal(await page.evaluate(() => testRandom.ended), true);
    await start(page);
    await page.evaluate(() => testRandom.close('随机匹配启动失败：测试中的明确原因'));
    assert.equal(await page.locator('#randomMatchStatus').isVisible(), true);
    assert.match(await page.locator('#randomMatchStatus').textContent(), /测试中的明确原因/);
    assert.deepEqual(errors, []);
  });
});
