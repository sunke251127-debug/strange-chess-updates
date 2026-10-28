'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { startChessServer } = require('../server/server.cjs');
test('two users exchange real WebRTC invitations, play privately without a game WebSocket server, and leave/cancel safely', { timeout: 60000 }, async () => {
  const server = await startChessServer({ host: '127.0.0.1', port: 0, quiet: true });
  const browser = await chromium.launch({ channel:'msedge', headless:true });
  const contexts = [], errors = [], sockets = [];
  async function open() {
    const context = await browser.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true }); contexts.push(context);
    await context.addInitScript(() => {
      // Host-only ICE in this local test: data still travels over an actual RTC channel.
      const Native = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends Native { constructor(options) { super({ ...options, iceServers: [] }); } };
      window.peerStates = [];
      const dispatch = EventTarget.prototype.dispatchEvent;
      EventTarget.prototype.dispatchEvent = function (event) {
        if (event.type === 'message' && typeof event.data === 'string') {
          try { const value = JSON.parse(event.data); if (value.type === 'room') window.peerStates.push(value); } catch {}
        }
        return dispatch.call(this,event);
      };
    });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); page.on('websocket', socket => sockets.push(socket.url()));
    await page.goto(server.url); await page.locator('#onlineModeBtn').click(); return page;
  }
  try {
    const host = await open(), guest = await open();
    await host.locator('#directCreateBtn').click();
    await host.waitForFunction(() => document.querySelector('#directInviteOutput').value.startsWith('SC-DIRECT-1:'));
    const offer = await host.locator('#directInviteOutput').inputValue();
    await guest.locator('#inviteInput').fill(offer); await guest.locator('#joinInviteBtn').click();
    await guest.waitForFunction(() => document.querySelector('#directInviteOutput').value.startsWith('SC-DIRECT-1:'));
    const answer = await guest.locator('#directInviteOutput').inputValue();
    await host.locator('#inviteInput').fill(answer); await host.locator('#joinInviteBtn').click();
    for (const page of [host,guest]) await page.waitForFunction(() => document.querySelector('#roomStatusText').textContent.includes('对局进行中'));
    assert.equal(server.manager.rooms.size, 0); assert.deepEqual(sockets, []);
    assert.equal(await host.evaluate(() => window.peerStates.at(-1).roomCode), await guest.evaluate(() => window.peerStates.at(-1).roomCode));
    for (const page of [host, guest]) assert.equal(await page.locator('#createRoomBtn, #findMatchBtn, #joinRoomBtn, #serverUrl, #roomCodeDisplay').count(), 0);
    const state = await guest.evaluate(() => window.peerStates.at(-1));
    assert.ok(state.direct); assert.equal(state.state.pieces.length,32);
    assert.ok(state.state.pieces.every(p => !Object.hasOwn(p,'kind') && !Object.hasOwn(p,'color')));
    await host.locator('.cell.is-selectable').first().tap(); await host.locator('.cell.is-legal, .cell.is-capture').first().tap();
    for (const page of [host,guest]) await page.waitForFunction(() => document.querySelector('#moveNumber').textContent.includes('第 1 手'));
    const afterHost = await host.evaluate(() => window.peerStates.at(-1).state);
    const afterGuest = await guest.evaluate(() => window.peerStates.at(-1).state);
    assert.deepEqual(afterHost,afterGuest); assert.equal(afterHost.turn,'black');
    await guest.locator('.cell.is-selectable').first().tap(); await guest.locator('.cell.is-legal, .cell.is-capture').first().tap();
    for (const page of [host,guest]) await page.waitForFunction(() => document.querySelector('#moveNumber').textContent.includes('第 2 手'));
    await guest.locator('#onlineModeBtn').click();
    guest.on('dialog', dialog => dialog.accept()); await guest.locator('#leaveRoomBtn').click();
    await host.waitForFunction(() => !window.mobileGame.hasRoom());
    const solo = await open(); await solo.locator('#directCreateBtn').click();
    await solo.waitForFunction(() => document.querySelector('#directInviteOutput').value.startsWith('SC-DIRECT-1:'));
    await solo.locator('#cancelDirectBtn').click(); assert.equal(await solo.locator('#directInvitePanel').isVisible(), false);
    assert.deepEqual(errors, []);
  } finally { await Promise.all(contexts.map(c => c.close())); await browser.close(); await server.close(); }
});
