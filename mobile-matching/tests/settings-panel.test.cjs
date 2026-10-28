'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright-core');
const E = require('../src/game-engine.js');
const { startChessServer } = require('../server/server.cjs');

test('red and black cannon names and move records both use the fire-radical 炮', () => {
  for (const color of ['red', 'black']) assert.equal(E.NAMES[color].cannon, '炮');
  const piece = (id, kind, color, x, y) => ({ id, kind, color, x, y, faceUp: true, slotKind: kind, slotColor: color });
  const state = { version: 1, pieces: [piece(1, 'cannon', 'black', 0, 0), piece(2, 'pawn', 'red', 0, 1), piece(3, 'rook', 'red', 0, 2), piece(4, 'king', 'red', 4, 9), piece(5, 'king', 'black', 4, 0)],
    turn: 'black', winner: null, endReason: null, moveNumber: 0, captured: [], lastMove: null };
  const move = E.move(state, 0, 0, 0, 2);
  assert.equal(move.ok, true); assert.equal(move.state.lastMove.pieceName, '炮');
  assert.equal(move.state.captured.length, 1); assert.equal(move.state.turn, 'red');
});

test('settings contains only updates, online play is separate, cannon glyphs match, and update actions still work', { timeout: 30000 }, async () => {
  const state = E.createGame(() => .5); state.pieces.forEach(piece => { piece.faceUp = true; });
  const server = await startChessServer({ host: '127.0.0.1', port: 0, quiet: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await context.addInitScript(state => {
      localStorage.setItem('strange-chess-offline-v1', JSON.stringify({ state }));
      window.checkCalls = 0; window.installCalls = 0; window.updateReady = false;
      window.AndroidShell = {
        getVersion: () => 'test', getServer: () => 'https://github.com/sunke251127-debug/strange-chess-updates', setServer() {},
        getUpdateState: () => JSON.stringify({ status: updateReady ? 'ready' : 'current', message: updateReady ? '更新已就绪' : '当前已是最新版' }),
        checkUpdate: () => { checkCalls++; }, installUpdate: () => { installCalls++; }
      };
    }, state);
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto(server.url);
    await page.addScriptTag({ path: path.join(__dirname, '../android/android-shell.js') });
    assert.equal(await page.locator('.piece-glyph-outline title').filter({ hasText: /^炮$/ }).count(), 4);
    assert.equal(await page.locator('.piece-glyph-outline title').filter({ hasText: /^砲$/ }).count(), 0);
    assert.equal(await page.evaluate(() => {
      const old = StrangeChessGlyphs.create('砲'), current = StrangeChessGlyphs.create('炮');
      return old.querySelector('path').getAttribute('d') === current.querySelector('path').getAttribute('d') && old.querySelector('title').textContent === '炮';
    }), true, 'old stored labels also render the corrected cannon');
    assert.equal(await page.locator('#toolsBtn').textContent(), '设置');
    await page.locator('#toolsBtn').tap();
    assert.equal(await page.locator('#mobilePanelTitle').textContent(), '设置');
    assert.equal(await page.locator('#onlineCard').isVisible(), false);
    assert.equal(await page.locator('#extraTools > summary').textContent(), '更新');
    await page.locator('#extraTools > summary').tap();
    assert.equal(await page.locator('#webUpdateCheckBtn').isVisible(), true);
    assert.equal(await page.locator('#installBtn, #installHelp').count(), 0);
    assert.equal(await page.locator('#extraTools #undoBtn, #extraTools #directCreateBtn, #extraTools #randomMatchBtn').count(), 0);
    const before = await page.evaluate(() => checkCalls);
    await page.locator('#webUpdateCheckBtn').tap(); assert.equal(await page.evaluate(() => checkCalls), before + 1);
    await page.evaluate(() => { updateReady = true; }); await page.locator('#webUpdateCheckBtn').tap();
    await page.locator('#apkInstallBtn').tap(); assert.equal(await page.evaluate(() => installCalls), 1);
    await page.screenshot({ path: path.join(__dirname, '../screenshots/settings-update-only.png'), animations: 'disabled' });
    await page.locator('#onlineModeBtn').tap();
    assert.equal(await page.locator('#mobilePanelTitle').textContent(), '联机对战');
    assert.equal(await page.locator('#onlineCard').isVisible(), true); assert.equal(await page.locator('#extraTools').isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement.matches('input,textarea')), false);
    await page.locator('#toolsBtn').tap();
    assert.equal(await page.locator('#onlineCard').isVisible(), false);
    assert.equal(await page.locator('#extraTools').isVisible(), true);
    assert.equal(await page.locator('#onlineModeBtn').getAttribute('aria-selected'), 'true', 'opening settings must not change game mode');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); }
});
