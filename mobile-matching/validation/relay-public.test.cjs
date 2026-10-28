'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { startChessServer } = require('../server/server.cjs');
const { pair } = require('../tests/helpers/direct.cjs');

test('two real browsers use public encrypted relays when WebRTC is completely unavailable', { timeout: 65000 }, async () => {
  const server = await startChessServer({ host: '127.0.0.1', port: 0, quiet: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const contexts = [], errors = [], urls = [], sent = [];
  async function open() {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); contexts.push(context);
    await context.addInitScript(() => {
      window.RTCPeerConnection = function () { throw new Error('UDP / WebRTC disabled for cross-network relay validation'); };
      window.publicViews = [];
      const dispatch = EventTarget.prototype.dispatchEvent;
      EventTarget.prototype.dispatchEvent = function (event) { if (event.type === 'message' && typeof event.data === 'string') { try { const v = JSON.parse(event.data); if (v.type === 'room') window.publicViews.push(v); } catch {} } return dispatch.call(this,event); };
    });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    page.on('websocket', socket => { urls.push(socket.url()); socket.on('framesent', event => sent.push(Buffer.from(event.payload))); });
    await page.goto(server.url); return page;
  }
  try {
    const host = await open(), guest = await open(); await pair(host,guest);
    assert.equal(server.manager.rooms.size, 0);
    for (const page of [host,guest]) {
      assert.match(await page.locator('#shareUrl').textContent(), /加密中继/);
      const state = await page.evaluate(() => window.publicViews.at(-1).state);
      assert.equal(state.pieces.length,32); assert.ok(state.pieces.every(p => !Object.hasOwn(p,'kind') && !Object.hasOwn(p,'color')));
    }
    await host.locator('.cell.is-selectable').first().tap(); await host.locator('.cell.is-legal').first().tap();
    for (const page of [host,guest]) await page.waitForFunction(() => document.querySelector('#moveNumber').textContent.includes('第 1 手'));
    assert.deepEqual(await host.evaluate(() => window.publicViews.at(-1).state), await guest.evaluate(() => window.publicViews.at(-1).state));
    await guest.locator('.cell.is-selectable').first().tap(); await guest.locator('.cell.is-legal').first().tap();
    for (const page of [host,guest]) await page.waitForFunction(() => document.querySelector('#moveNumber').textContent.includes('第 2 手'));
    const bytes = Buffer.concat(sent).toString('utf8');
    for (const token of ['"pieces"','"fromX"','"lastMove"','"relayHello"','"kind"']) assert.equal(bytes.includes(token),false,'public broker must receive encrypted payloads only');
    assert.ok(urls.some(url => url.startsWith('wss://broker.emqx.io:8084/')));
    assert.ok(urls.every(url => url.startsWith('wss://broker.emqx.io:8084/') || url.startsWith('wss://test.mosquitto.org:8081/')));
    await guest.locator('#toolsBtn').tap(); await guest.locator('#leaveRoomBtn').tap();
    await host.waitForFunction(() => !window.mobileGame.hasRoom());
    assert.deepEqual(errors, []);
    console.log('Public relay path verified: WebRTC unavailable, two-way moves synced, no plaintext board data, clean leave.');
  } finally { await Promise.all(contexts.map(c => c.close())); await browser.close(); await server.close(); }
});
