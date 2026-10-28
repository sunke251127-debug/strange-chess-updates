'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const { startChessServer } = require('../server/server.cjs');
test('phone and tablet layouts keep the whole board on screen and touch moves work', { timeout: 45000 }, async () => {
  const server = await startChessServer({ host: '127.0.0.1', port: 0, quiet: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const results = [];
  const errors = [];
  try {
    for (const [width, height] of [[320,640],[360,800],[390,844],[412,915],[844,390],[800,1280]]) {
      const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      await page.goto(server.url); await page.locator('#boardGrid .cell').last().waitFor();
      const geometry = await page.evaluate(() => {
        const board = document.querySelector('#board').getBoundingClientRect();
        const frame = document.querySelector('.board-frame').getBoundingClientRect();
        return { x: board.x, y: board.y, width: board.width, height: board.height, frameWidth: frame.width,
          bottom: board.bottom, cells: document.querySelectorAll('.cell').length, scrollWidth: document.documentElement.scrollWidth };
      });
      results.push({ viewportWidth: width, viewportHeight: height, ...geometry });
      const shot = path.join(__dirname, '../screenshots', `mobile-${width}x${height}.png`);
      await page.screenshot({ path: shot });
      assert.equal(geometry.cells, 90);
      assert.ok(geometry.x >= 0 && geometry.y >= 0 && geometry.bottom <= height, JSON.stringify(results.at(-1)));
      assert.ok(Math.abs(geometry.width / geometry.height - .9) < .002);
      assert.ok(geometry.scrollWidth <= width);
      if (width >= 360 && width <= 412) assert.ok(geometry.frameWidth / width >= .94, 'portrait width ' + geometry.frameWidth / width);
      if (width > height) assert.ok(geometry.height / height >= .85, 'landscape board should fill height');
      await page.locator('.cell.is-selectable').first().tap();
      await page.locator('.cell.is-legal, .cell.is-capture').first().tap();
      await page.waitForFunction(() => document.querySelector('#moveNumber').textContent.includes('第 1 手'));
      await page.locator('#toolsBtn').tap(); await page.locator('#closePanelBtn').tap();
      await context.close();
    }
    assert.deepEqual(errors, []);
  } finally {
    const report = path.join(__dirname, '../artifacts/layout-report.json');
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(report, JSON.stringify({ results, errors }, null, 2));
    await browser.close(); await server.close();
  }
});
