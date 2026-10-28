'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright-core');
const E = require('../src/game-engine.js');
const { startChessServer } = require('../server/server.cjs');

test('fixed glyph outlines remain centered without any system font or canvas text metrics', { timeout: 30000 }, async () => {
  const state = E.createGame(() => .5); state.pieces.forEach(p => { p.faceUp = true; });
  const server = await startChessServer({ host: '127.0.0.1', port: 0, quiet: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const errors = [];
  try {
    for (const [width, height] of [[320,640],[390,844],[844,390]]) {
      const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, reducedMotion: 'reduce' });
      await context.addInitScript(state => {
        localStorage.setItem('strange-chess-offline-v1', JSON.stringify({ state }));
        CanvasRenderingContext2D.prototype.measureText = () => { throw new Error('Font metrics unavailable on this WebView'); };
      }, state);
      const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); await page.goto(server.url);
      await page.locator('.piece-glyph-outline').last().waitFor();
      const before = await page.locator('.piece-glyph').evaluateAll(nodes => nodes.map(n => n.innerHTML));
      for (const family of ['sans-serif', 'monospace', '"Missing Android font", serif']) {
        await page.evaluate(family => document.querySelectorAll('.piece-glyph').forEach(g => { g.style.fontFamily = family; g.style.lineHeight = '2.8'; g.style.letterSpacing = '7px'; }), family);
        const rows = await page.locator('.piece-glyph').evaluateAll(nodes => nodes.map(g => {
          const svg = g.querySelector('svg'), p = svg.querySelector('path'); const b = p.getBBox();
          const circle = g.closest('.piece').getBoundingClientRect(), s = svg.getBoundingClientRect();
          return { symbol: g.textContent, x: Math.abs((b.x + b.width / 2) - 500), y: Math.abs((b.y + b.height / 2) - 500), dx: Math.abs(s.x + s.width / 2 - circle.x - circle.width / 2), dy: Math.abs(s.y + s.height / 2 - circle.y - circle.height / 2), width: b.width, height: b.height };
        }));
        assert.equal(rows.length, 32); assert.equal(new Set(rows.map(r => r.symbol)).size, 13, 'both cannon colors use 炮');
        for (const r of rows) { assert.ok(r.x < .01 && r.y < .01, JSON.stringify(r)); assert.ok(r.dx <= .1 && r.dy <= .1, JSON.stringify(r)); assert.ok(Math.max(r.width, r.height) < 881); }
        assert.deepEqual(await page.locator('.piece-glyph').evaluateAll(nodes => nodes.map(n => n.innerHTML)), before, 'system font changes must never re-position glyph outlines');
      }
      await page.locator('.cell.is-selectable').first().tap();
      await page.screenshot({ path: path.join(__dirname, `../screenshots/vector-glyphs-${width}x${height}.png`) });
      await context.close();
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); }
});
