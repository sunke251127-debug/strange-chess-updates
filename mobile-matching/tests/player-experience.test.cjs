'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const E = require('../src/game-engine.js');
const { GameRoom } = require('../server/game-room.cjs');
const { startChessServer } = require('../server/server.cjs');
const { localIce, pair } = require('./helpers/direct.cjs');

test('players exchange colors after each agreed new game, while refusal, undo and reconnect retain colors', () => {
  const room = new GameRoom('ABCDEF', { firstColor: E.BLACK });
  const a = room.addPlayer('host'), b = room.addPlayer('guest');
  assert.equal(a.color, 'black'); assert.equal(b.color, 'red');
  for (let round = 1; round <= 4; round++) {
    const colors = room.publicView().players.map(p => p.color);
    assert.deepEqual(colors, round % 2 ? ['black', 'red'] : ['red', 'black']);
    assert.equal(room.publicView().round, round);
    const moving = room.game.pieces.find(p => E.owner(p) === 'red' && E.legalMoves(room.game, p.x, p.y).length);
    const to = E.legalMoves(room.game, moving.x, moving.y)[0];
    const redSeat = colors.indexOf('red');
    assert.throws(() => room.move(1 - redSeat, moving.x, moving.y, to.x, to.y), { code: 'NOT_YOUR_TURN' });
    room.move(redSeat, moving.x, moving.y, to.x, to.y);
    const undo = room.requestUndo(0); room.respondUndo(1, true, undo.id);
    assert.deepEqual(room.publicView().players.map(p => p.color), colors);
    const declined = room.requestRestart(0); room.respondRestart(1, false, declined.id);
    assert.deepEqual(room.publicView().players.map(p => p.color), colors);
    room.disconnect('guest'); assert.equal(room.reconnect('guest', b.token).color, colors[1]);
    const request = room.requestRestart(0); room.respondRestart(1, true, request.id);
  }
});

test('both players see their own side below, repeated selection reuses rule work, and rematch changes the first mover', { timeout: 45000 }, async () => {
  const server = await startChessServer({ host: '127.0.0.1', port: 0, quiet: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const errors = [];
  async function open() {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); await localIce(context);
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); await page.goto(server.url); return page;
  }
  async function view(page, color) {
    assert.equal(await page.locator('#boardGrid').getAttribute('data-perspective'), color);
    const geometry = await page.evaluate(color => {
      const own = document.querySelector(`.cell[data-x="0"][data-y="${color === 'red' ? 9 : 0}"]`).getBoundingClientRect();
      const far = document.querySelector(`.cell[data-x="0"][data-y="${color === 'red' ? 0 : 9}"]`).getBoundingClientRect();
      return { own: own.y, far: far.y, transform: getComputedStyle(document.querySelector('#boardGrid')).transform };
    }, color);
    assert.ok(geometry.own > geometry.far); assert.equal(geometry.transform, 'none');
  }
  async function selectionCost(page) {
    await page.evaluate(() => {
      window.ruleCalls = 0;
      const original = StrangeChess.legalMoves;
      StrangeChess.legalMoves = (...args) => { ruleCalls++; return original(...args); };
    });
    for (let i = 0; i < 6; i++) await page.locator('.cell.is-selectable').nth(i % 2).tap();
    const calls = await page.evaluate(() => ruleCalls);
    assert.ok(calls <= 1, 'six selections repeated expensive move generation ' + calls + ' times');
    return calls;
  }
  async function move(page, peers, number) {
    await page.locator('.cell.is-selectable').first().tap();
    if (!await page.locator('.cell.is-legal, .cell.is-capture').count()) await page.locator('.cell.is-selectable').first().tap();
    await page.locator('.cell.is-legal, .cell.is-capture').first().tap();
    for (const peer of peers) await peer.waitForFunction(n => document.querySelector('#moveNumber').textContent === `第 ${n} 手`, number);
  }
  try {
    const a = await open(), b = await open(); await pair(a, b);
    await view(a, 'red'); await view(b, 'black');
    const hostCalls = await selectionCost(a); await move(a, [a, b], 1);
    const guestCalls = await selectionCost(b); await move(b, [a, b], 2);
    console.log('Rule recomputations for six selections: host=' + hostCalls + ', guest=' + guestCalls);
    for (let round = 2; round <= 3; round++) {
      await a.locator('#shuffleBtn').tap(); await b.locator('#onlineRequestDialog').waitFor({ state: 'visible' });
      await b.locator('#acceptOnlineRequestBtn').tap();
      const first = round % 2 ? a : b, second = first === a ? b : a;
      for (const page of [a, b]) await page.waitForFunction(() => document.querySelector('#moveNumber').textContent === '第 0 手');
      await view(first, 'red'); await view(second, 'black');
      assert.match(await first.locator('#modeLabel').textContent(), /红方/);
      assert.match(await second.locator('#modeLabel').textContent(), /黑方/);
      await move(first, [a, b], 1); await move(second, [a, b], 2);
    }
    assert.equal(await a.evaluate(() => localStorage.getItem('strange-chess-next-color-v1')), 'black');
    assert.equal(await b.evaluate(() => localStorage.getItem('strange-chess-next-color-v1')), 'red');
    await b.locator('#onlineModeBtn').tap(); await b.locator('#leaveRoomBtn').tap();
    for (const page of [a, b]) await page.waitForFunction(() => !mobileGame.hasRoom());
    // A stays the connection host, but the same pair swaps colors in a fresh connection too.
    await pair(a, b); await view(a, 'black'); await view(b, 'red');
    await move(b, [a, b], 1); await move(a, [a, b], 2);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); }
});
