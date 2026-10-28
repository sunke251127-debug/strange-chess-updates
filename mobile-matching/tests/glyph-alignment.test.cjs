'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const E = require('../src/game-engine.js');
const { startChessServer } = require('../server/server.cjs');

function exposedBoard() {
  const state = E.createGame(() => .5);
  for (const piece of state.pieces) piece.faceUp = true;
  return state;
}
function launchOptions() {
  const options = { headless: true, args: ['--noerrdialogs'] };
  if (process.env.CODEX_ROUTER_BROWSER) options.executablePath = process.env.CODEX_ROUTER_BROWSER;
  else options.channel = 'msedge';
  return options;
}

// Screenshot the rendered board, hide only the glyphs, screenshot again and
// compare. The diff is the real painted character ink (plus its shadow), not a
// DOM box. Its centre must sit on the piece centre, otherwise a glyph that is
// visually high/low/left/right will fail even when its span is technically
// centered.
async function inkOffsets(page, dpr) {
  const pieces = await page.evaluate(() => [...document.querySelectorAll('.cell')]
    .filter(cell => cell.querySelector('.piece-glyph'))
    .map(cell => {
      const piece = cell.querySelector('.piece').getBoundingClientRect();
      return { symbol: cell.querySelector('.piece-glyph').textContent,
        cx: piece.x + piece.width / 2, cy: piece.y + piece.height / 2, width: piece.width };
    }));
  assert.ok(pieces.length > 0, 'board must render at least one face-up piece');
  const shown = await page.screenshot();
  await page.evaluate(() => document.querySelectorAll('.piece-glyph').forEach(glyph => { glyph.style.visibility = 'hidden'; }));
  const hidden = await page.screenshot();
  await page.evaluate(() => document.querySelectorAll('.piece-glyph').forEach(glyph => { glyph.style.visibility = ''; }));
  return page.evaluate(async ({ shown, hidden, pieces, dpr }) => {
    const load = async src => {
      const image = new Image(); image.src = src; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      return { canvas, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data };
    };
    const a = await load(shown), b = await load(hidden);
    return pieces.map(piece => {
      const cx = piece.cx * dpr, cy = piece.cy * dpr, radius = piece.width * .5 * dpr;
      const x0 = Math.max(0, Math.floor(cx - radius)), x1 = Math.min(a.canvas.width - 1, Math.ceil(cx + radius));
      const y0 = Math.max(0, Math.floor(cy - radius)), y1 = Math.min(a.canvas.height - 1, Math.ceil(cy + radius));
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, count = 0;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        if (Math.hypot(x + .5 - cx, y + .5 - cy) > radius) continue;
        const i = (y * a.canvas.width + x) * 4;
        const delta = Math.abs(a.pixels[i] - b.pixels[i]) +
          Math.abs(a.pixels[i + 1] - b.pixels[i + 1]) + Math.abs(a.pixels[i + 2] - b.pixels[i + 2]);
        if (delta > 24) {
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y); count++;
        }
      }
      return { symbol: piece.symbol, count,
        x: ((minX + maxX) / 2 - cx) / dpr, y: ((minY + maxY) / 2 - cy) / dpr };
    });
  }, { shown: 'data:image/png;base64,' + shown.toString('base64'), hidden: 'data:image/png;base64,' + hidden.toString('base64'), pieces, dpr });
}

function assertCentered(rows, label) {
  assert.ok(rows.length > 0, label + ': no glyphs measured');
  for (const row of rows) {
    assert.ok(row.count > 0, `${label}: no ink found for ${row.symbol}`);
    assert.ok(Math.abs(row.x) <= 1.1, `${label}: ${row.symbol} ink is horizontally off-centre by ${row.x.toFixed(2)}px`);
    assert.ok(Math.abs(row.y) <= 1.1, `${label}: ${row.symbol} ink is vertically off-centre by ${row.y.toFixed(2)}px`);
  }
}

test('every red/black glyph paints centred in portrait and landscape, including selected and just-revealed faces', { timeout: 60000 }, async () => {
  const server = await startChessServer({ host: '127.0.0.1', port: 0, quiet: true });
  const browser = await chromium.launch(launchOptions());
  try {
    for (const [width, height] of [[390, 844], [844, 390]]) {
      const dpr = 2;
      const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: dpr, reducedMotion: 'reduce' });
      await context.addInitScript(state => localStorage.setItem('strange-chess-offline-v1', JSON.stringify({ state })), exposedBoard());
      const page = await context.newPage(); await page.goto(server.url);
      await page.waitForFunction(() => document.querySelectorAll('.piece-glyph').length === 32);
      await page.waitForTimeout(80);
      const normal = await inkOffsets(page, dpr);
      assert.equal(new Set(normal.map(row => row.symbol)).size, 13, 'all character shapes including the shared cannon glyph must be present');
      assertCentered(normal, `${width}x${height} settled`);

      await page.locator('.cell.is-selectable').first().tap();
      await page.waitForTimeout(260); // the piece lift transition is 140ms
      assertCentered(await inkOffsets(page, dpr), `${width}x${height} selected`);

      // A fresh all-face-down game: after the first move, inspect the piece that
      // has just finished its flip animation (the actual settled face).
      await page.evaluate(state => localStorage.setItem('strange-chess-offline-v1', JSON.stringify({ state })), E.createGame(() => .5));
      await page.reload();
      await page.waitForFunction(() => document.querySelectorAll('.cell.is-selectable').length > 0);
      await page.locator('.cell.is-selectable').first().tap();
      await page.locator('.cell.is-legal').first().tap();
      await page.waitForFunction(() => document.querySelector('#moveNumber').textContent.includes('第 1 手'));
      await page.waitForFunction(() => !document.querySelector('.piece.flip-running'));
      await page.waitForTimeout(120);
      const revealed = await inkOffsets(page, dpr);
      assert.ok(revealed.length >= 1, 'a revealed face must exist after the first move');
      assertCentered(revealed, `${width}x${height} just-revealed`);
      await context.close();
    }
  } finally { await browser.close(); await server.close(); }
});
