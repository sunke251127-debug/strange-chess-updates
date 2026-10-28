'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { startChessServer } = require('../server/server.cjs');
const { localIce, pair } = require('./helpers/direct.cjs');

test('mobile entry offers only friend direct play, preserves local saves, cancels invitations and synchronizes two peers', { timeout: 45000 }, async () => {
  const server = await startChessServer({ host: '127.0.0.1', port: 0, quiet: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const contexts = [], errors = [], sockets = [];
  async function open() {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    contexts.push(context); await localIce(context);
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); page.on('websocket', ws => sockets.push(ws.url()));
    await page.goto(server.url + '?room=ABCDEF'); return page;
  }
  try {
    const host = await open(), guest = await open();
    await host.locator('.cell.is-selectable').first().tap(); await host.locator('.cell.is-legal').first().tap();
    const localSave = await host.evaluate(() => localStorage.getItem('strange-chess-offline-v1'));
    await host.locator('#onlineModeBtn').tap();
    assert.equal(await host.locator('#shuffleBtn').isDisabled(), true);
    assert.equal(await host.locator('#quickUndoBtn').isDisabled(), true);
    assert.equal(await host.locator('#createRoomBtn, #findMatchBtn, #cancelMatchBtn, #joinRoomBtn, #roomCodeInput, #roomCodeDisplay, #copyRoomBtn, #advancedConnect, #serverUrl, #internetPanel, #fullscreenBtn').count(), 0);
    assert.equal(await host.locator('#directCreateBtn').isVisible(), true);
    // Old server invitations must not open a socket or create a server room.
    await host.locator('#inviteInput').fill(server.url + '?room=ABCDEF'); await host.locator('#joinInviteBtn').tap();
    await host.locator('#onlineFormMessage').filter({ hasText: '没有找到完整直连邀请' }).waitFor();
    assert.equal(server.manager.rooms.size, 0); assert.deepEqual(sockets, []);
    await host.locator('#directCreateBtn').tap();
    await host.waitForFunction(() => document.querySelector('#directInviteOutput').value.startsWith('SC-DIRECT-1:'));
    assert.equal(await host.locator('#directCreateBtn').isDisabled(), true);
    await host.locator('#cancelDirectBtn').tap();
    assert.equal(await host.locator('#directInvitePanel').isVisible(), false);
    await host.locator('#localModeBtn').tap();
    assert.equal(await host.evaluate(() => localStorage.getItem('strange-chess-offline-v1')), localSave);
    assert.ok((await host.locator('#moveNumber').textContent()).includes('第 1 手'));
    assert.equal(await host.locator('#shuffleBtn').isDisabled(), false);
    await pair(host, guest);
    for (const page of [host, guest]) {
      assert.equal(await page.locator('#shuffleBtn').isDisabled(), false, 'connected players can request a new game');
      assert.equal(await page.locator('#localModeBtn').isDisabled(), true);
    }
    await host.locator('.cell.is-selectable').first().tap(); await host.locator('.cell.is-legal').first().tap();
    for (const page of [host, guest]) await page.waitForFunction(() => document.querySelector('#moveNumber').textContent.includes('第 1 手'));
    await guest.locator('.cell.is-selectable').first().tap(); await guest.locator('.cell.is-legal').first().tap();
    for (const page of [host, guest]) await page.waitForFunction(() => document.querySelector('#moveNumber').textContent.includes('第 2 手'));
    assert.equal(server.manager.rooms.size, 0); assert.deepEqual(sockets, []);
    await guest.locator('#onlineModeBtn').tap(); await guest.locator('#leaveRoomBtn').tap();
    await host.waitForFunction(() => !window.mobileGame.hasRoom());
    await host.locator('#localModeBtn').tap();
    assert.equal(await host.evaluate(() => localStorage.getItem('strange-chess-offline-v1')), localSave);
    assert.deepEqual(errors, []);
  } finally { await Promise.all(contexts.map(c => c.close())); await browser.close(); await server.close(); }
});
