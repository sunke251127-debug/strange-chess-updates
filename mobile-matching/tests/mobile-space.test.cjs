'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright-core');
const E = require('../src/game-engine.js');
const { startChessServer } = require('../server/server.cjs');

function exposedBoard() {
  const state = E.createGame(() => .5);
  for (const piece of state.pieces) piece.faceUp = true;
  return state;
}
function fullTrays() {
  const state = exposedBoard();
  state.captured = state.pieces.filter(p => p.kind !== 'king').map(p => ({ ...p, capturedBy: E.opposite(p.color) }));
  state.pieces = state.pieces.filter(p => p.kind === 'king');
  return state;
}

test('phone entry removes move details, keeps all glyphs inside the inner ring and shows both full captured rows', { timeout: 30000 }, async () => {
  const server = await startChessServer({ host: '127.0.0.1', port: 0, quiet: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const errors = [];
  try {
    for (const [width, height] of [[320,640], [390,844], [844,390]]) {
      const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true });
      const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
      await page.addInitScript(state => { if (!localStorage.getItem('strange-chess-offline-v1')) localStorage.setItem('strange-chess-offline-v1', JSON.stringify({ state })); }, exposedBoard());
      await page.goto(server.url); await page.locator('.piece-glyph').last().waitFor();
      assert.equal(await page.locator('#feedbackBar, #historyList, .history-card, #fullscreenBtn').count(), 0);
      assert.equal(await page.locator('#shuffleBtn').textContent(), '新棋局');
      assert.equal(await page.locator('#shuffleBtn').isVisible(), true);
      const glyphs = await page.evaluate(() => [...document.querySelectorAll('.piece-glyph')].map(glyph => {
        const piece = glyph.closest('.piece'), p = piece.getBoundingClientRect(), g = glyph.getBoundingClientRect();
        const ring = getComputedStyle(piece, '::before');
        const radius = (piece.clientWidth - 2 * parseFloat(ring.left) - 2 * parseFloat(ring.borderLeftWidth)) / 2;
        const farthest = Math.max(...[g.left, g.right].flatMap(x => [g.top, g.bottom].map(y => Math.hypot(x - (p.left + p.width / 2), y - (p.top + p.height / 2)))));
        return { text: glyph.textContent, clearance: radius - farthest, font: parseFloat(getComputedStyle(glyph).fontSize), diameter: p.width, overflow: getComputedStyle(glyph.parentElement).overflow };
      }));
      assert.equal(glyphs.length, 32);
      assert.equal(new Set(glyphs.map(g => g.text)).size, 13, 'check all characters with one shared cannon glyph');
      for (const g of glyphs) {
        assert.ok(g.clearance >= .5, `${width}x${height}: ${JSON.stringify(g)}`);
        assert.equal(g.overflow, 'visible', 'rounded front must not clip character strokes');
        assert.ok(g.font < g.diameter * .52);
      }
      await page.screenshot({ path: path.join(__dirname, `../screenshots/space-glyphs-${width}x${height}.png`) });
      // Fill both rows to their maximum, then verify the last piece is reachable.
      await page.evaluate(state => localStorage.setItem('strange-chess-offline-v1', JSON.stringify({ state })), fullTrays());
      await page.reload(); await page.locator('#capturedBlack .mini-piece').last().waitFor();
      assert.equal(await page.locator('#capturedRed .mini-piece').count(), 15);
      assert.equal(await page.locator('#capturedBlack .mini-piece').count(), 15);
      const layout = await page.evaluate(() => {
        const column = document.querySelector('.board-column');
        const frame = column.querySelector('.board-frame').getBoundingClientRect();
        const card = column.querySelector('.capture-card').getBoundingClientRect();
        const toolbar = document.querySelector('.mobile-toolbar').getBoundingClientRect();
        return { afterBoard: [...column.children].slice([...column.children].findIndex(e => e.classList.contains('board-frame')) + 1).map(e => e.className), frameLeft: frame.left, frameRight: frame.right, frameBottom: frame.bottom, top: card.top, left: card.left, right: card.right, bottom: card.bottom, scrollWidth: document.documentElement.scrollWidth, toolbarTop: toolbar.top,
          rows: [...document.querySelectorAll('.capture-tray')].map(tray => { tray.scrollLeft = tray.scrollWidth; const t = tray.getBoundingClientRect(), last = tray.lastElementChild.getBoundingClientRect(); return { scroll: tray.scrollLeft, scrollWidth: tray.scrollWidth, width: t.width, lastRight: last.right, right: t.right, top: t.top, bottom: t.bottom }; }) };
      });
      assert.deepEqual(layout.afterBoard, ['card capture-card']);
      assert.ok(layout.frameLeft >= 0 && layout.left >= 0 && layout.frameRight <= width && layout.right <= width && layout.scrollWidth <= width, JSON.stringify(layout));
      assert.ok(layout.top >= layout.frameBottom && layout.bottom <= height, JSON.stringify(layout));
      if (width < height) assert.ok(layout.bottom <= layout.toolbarTop, 'captured rows must not be behind the toolbar');
      for (const row of layout.rows) { assert.ok(row.top >= layout.top && row.bottom <= layout.bottom); if (row.scrollWidth > row.width + 1) assert.ok(row.scroll > 0, JSON.stringify(row)); assert.ok(row.lastRight <= row.right + 1, JSON.stringify(row)); }
      await page.screenshot({ path: path.join(__dirname, `../screenshots/space-trays-${width}x${height}.png`) });
      await page.locator('#shuffleBtn').tap();
      await page.waitForFunction(() => document.querySelectorAll('.piece.face-down').length === 32);
      assert.equal(await page.locator('.capture-tray .mini-piece').count(), 0);
      await context.close();
    }
    // Actual play and restore must work after deleting the old DOM targets.
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto(server.url); await page.locator('.cell.is-selectable').first().tap(); await page.locator('.cell.is-legal').first().tap();
    await page.waitForFunction(() => document.querySelector('#moveNumber').textContent.includes('第 1 手'));
    await page.reload(); await page.waitForFunction(() => document.querySelector('#moveNumber').textContent.includes('第 1 手'));
    await page.locator('#quickUndoBtn').tap(); await page.waitForFunction(() => document.querySelector('#moveNumber').textContent.includes('第 0 手'));
    await page.locator('.cell.is-selectable').first().tap(); await page.locator('.cell.is-legal').first().tap();
    const saved = await page.evaluate(() => localStorage.getItem('strange-chess-offline-v1'));
    page.once('dialog', dialog => dialog.dismiss()); await page.locator('#shuffleBtn').tap();
    assert.equal(await page.evaluate(() => localStorage.getItem('strange-chess-offline-v1')), saved);
    page.once('dialog', dialog => dialog.accept()); await page.locator('#shuffleBtn').tap();
    await page.waitForFunction(() => document.querySelector('#moveNumber').textContent.includes('第 0 手'));
    assert.equal(await page.locator('.piece.face-down').count(), 32);
    await page.reload(); assert.equal(await page.locator('.piece.face-down').count(), 32);
    await page.locator('#quickUndoBtn').tap(); assert.ok((await page.locator('#moveNumber').textContent()).includes('第 0 手'));
    assert.equal(await page.locator('#feedbackBar, .history-card').count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await browser.close(); await server.close(); }
});
