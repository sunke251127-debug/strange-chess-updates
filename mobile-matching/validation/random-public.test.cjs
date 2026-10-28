'use strict';
// Opt-in public-network check for the new WebView matching path. It uses the
// default public WSS brokers and a random service id, so it never meets a real
// player or reuses a fixed lobby.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { chromium } = require('playwright-core');
const { startChessServer } = require('../server/server.cjs');

test('public WSS discovery pairs two pages on an isolated service id and carries bidirectional moves', { timeout: 120000 }, async () => {
  const service = 'strange-chess/validation-' + crypto.randomBytes(12).toString('hex');
  const server = await startChessServer({ host: '127.0.0.1', port: 0, quiet: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const contexts = [], errors = [];
  async function open() {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); contexts.push(context);
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(server.url); await page.locator('#boardGrid .cell').last().waitFor();
    await page.evaluate(serviceId => {
      const Native = StrangeChessRandom.Link;
      window.StrangeChessRandom = { ...StrangeChessRandom, Link: class extends Native {
        constructor(options = {}) {
          super({ ...options, service: serviceId, electionDelay: 700, electionSettle: 800, matchInterval: 500,
            nodeTimeout: 8000, introductionTimeout: 45000, discoveryReleaseDelay: 1000, gatherTimeout: 4000, fallbackDelay: 4500 });
          window.testRandom = this;
        }
      } };
    }, service);
    return page;
  }
  async function move(page, number, peers) {
    await page.locator('.cell.is-selectable').first().tap(); await page.locator('.cell.is-legal, .cell.is-capture').first().tap();
    for (const peer of peers) await peer.waitForFunction(n => document.querySelector('#moveNumber').textContent.includes('第 ' + n + ' 手'), number);
  }
  try {
    const a = await open(), b = await open();
    await a.locator('#onlineModeBtn').click(); await a.locator('#randomMatchBtn').click();
    await b.locator('#onlineModeBtn').click(); await b.locator('#randomMatchBtn').click();
    for (const page of [a, b]) await page.waitForFunction(() => window.mobileGame.hasRoom() && document.querySelector('#roomStatusText').textContent.includes('对局进行中'), null, { timeout: 95000 });
    for (const page of [a, b]) assert.ok(['rtc', 'relay'].includes(await page.evaluate(() => testRandom.transport)), 'a real independent transport must be active');
    const host = (await a.locator('#seatBadge').textContent()).includes('红') ? a : b;
    const guest = host === a ? b : a;
    await move(host, 1, [a, b]); await move(guest, 2, [a, b]);
    assert.deepEqual(await a.evaluate(() => window.mobileGame.hasRoom()), true);
    assert.deepEqual(errors, []);
  } finally {
    await Promise.all(contexts.map(context => context.close()));
    await browser.close(); await server.close();
  }
});
