'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { startChessServer } = require('../server/server.cjs');
const { localIce } = require('./helpers/direct.cjs');

async function waitController(page) {
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
}
async function build(page) {
  return page.evaluate(() => new Promise(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = event => { resolve(event.data.build); channel.port1.close(); };
    navigator.serviceWorker.controller.postMessage({ type: 'BUILD' }, [channel.port2]);
  }));
}
async function changePage(page, overrides, server, number) {
  overrides['/mobile.js'] = fs.readFileSync(path.join(__dirname, '../renderer/mobile.js'), 'utf8') + '\nwindow.bundleMarker = ' + number + ';\n';
  server.reloadAssets();
  await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update(); });
}
test('PWA installs an atomic offline bundle; failed updates preserve it and successful updates wait for every active tab', { timeout: 60000 }, async () => {
  const overrides = {};
  const server = await startChessServer({ host: '127.0.0.1', port: 0, quiet: true, assetOverrides: overrides });
  let broken = false;
  const proxy = http.createServer((req, res) => {
    if (broken && req.url.startsWith('/icon-512.png?build=')) { res.writeHead(503); res.end('simulated network interruption'); return; }
    const upstream = http.request(new URL(req.url, server.url), { method: req.method, headers: req.headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  proxy.on('upgrade', (req, socket, head) => {
    const upstream = http.request(new URL(req.url, server.url), { headers: req.headers });
    upstream.on('upgrade', (res, remote, bytes) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(res.headers).map(([k,v]) => k + ': ' + v).join('\r\n') + '\r\n\r\n');
      if (bytes.length) socket.write(bytes); if (head.length) remote.write(head);
      socket.pipe(remote).pipe(socket); socket.on('error', () => remote.destroy()); remote.on('error', () => socket.destroy());
    });
    upstream.on('error', () => socket.destroy()); upstream.end();
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${proxy.address().port}/`;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await localIce(context);
  const evidence = {};
  try {
    const page = await context.newPage(); await page.goto(origin); await waitController(page);
    const firstBuild = await build(page); evidence.firstBuild = firstBuild;
    const manifestResponse = await page.request.get(origin + 'manifest.webmanifest');
    const manifest = await manifestResponse.json(); assert.equal(manifest.display, 'standalone'); assert.equal(manifest.scope, '/');
    await page.locator('.cell.is-selectable').first().tap(); await page.locator('.cell.is-legal, .cell.is-capture').first().tap();
    const saved = await page.evaluate(() => localStorage.getItem('strange-chess-offline-v1'));
    assert.ok(JSON.parse(saved).state.moveNumber === 1);
    await context.setOffline(true); await page.reload();
    await page.waitForFunction(() => document.querySelector('#moveNumber').textContent.includes('第 1 手'));
    await page.locator('.cell.is-selectable').first().tap(); await page.locator('.cell.is-legal, .cell.is-capture').first().tap();
    await page.waitForFunction(() => document.querySelector('#moveNumber').textContent.includes('第 2 手'));
    evidence.offlineMove = true;
    const updatedSave = await page.evaluate(() => localStorage.getItem('strange-chess-offline-v1'));
    await context.setOffline(false);
    // First update fails while downloading one required icon. Old cache still works.
    broken = true; await changePage(page, overrides, server, 2);
    await page.waitForFunction(async () => {
      const reg = await navigator.serviceWorker.getRegistration(); return !reg.installing && !reg.waiting;
    });
    assert.equal(await build(page), firstBuild);
    await context.setOffline(true); await page.reload();
    assert.equal(await build(page), firstBuild);
    assert.equal(await page.evaluate(() => localStorage.getItem('strange-chess-offline-v1')), updatedSave);
    evidence.failedUpdatePreservedOld = true;
    await context.setOffline(false); broken = false;
    // A second active tab holds a direct invitation: updates must preserve it.
    const other = await context.newPage(); await other.goto(origin); await waitController(other);
    await other.locator('#onlineModeBtn').click(); await other.locator('#directCreateBtn').click();
    await other.waitForFunction(() => document.querySelector('#directInviteOutput').value.startsWith('SC-DIRECT-1:'));
    const pendingInvite = await other.locator('#directInviteOutput').inputValue();
    await page.evaluate(() => { window.noReloadMarker = 'still here'; });
    await changePage(page, overrides, server, 3);
    await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration()).waiting));
    assert.equal(await build(page), firstBuild); assert.equal(await build(other), firstBuild);
    assert.equal(await page.evaluate(() => window.noReloadMarker), 'still here');
    assert.equal(await other.locator('#directInviteOutput').inputValue(), pendingInvite);
    evidence.activeDirectTabUnchanged = true;
    await other.locator('#cancelDirectBtn').click();
    assert.equal(await other.locator('#directInvitePanel').isVisible(), false);
    // Closing every old tab lets the browser activate the complete new version.
    await other.close(); await page.close();
    // Allow the browser's queued activation task to run with zero clients.
    // An immediate new client may otherwise attach to the old controller.
    await new Promise(resolve => setTimeout(resolve, 500));
    const next = await context.newPage(); await next.goto(origin); await waitController(next);
    await next.waitForFunction(() => window.bundleMarker === 3);
    evidence.newBuild = await build(next); assert.notEqual(evidence.newBuild, firstBuild);
    assert.equal(await next.evaluate(() => localStorage.getItem('strange-chess-offline-v1')), updatedSave);
    await context.setOffline(true); await next.reload();
    await next.waitForFunction(() => window.bundleMarker === 3);
    evidence.newVersionOffline = true;
    const keys = await next.evaluate(async () => {
      const all = []; for (const name of await caches.keys()) { const c = await caches.open(name); for (const r of await c.keys()) all.push(new URL(r.url).pathname); } return all;
    });
    assert.equal(keys.some(key => key.startsWith('/api/') || key === '/ws'), false);
    evidence.noSessionDataCached = true;
  } finally {
    const report = path.join(__dirname, '../artifacts/pwa-report.json');
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(report, JSON.stringify(evidence, null, 2));
    await context.close(); await browser.close(); proxy.closeAllConnections();
    await new Promise(resolve => proxy.close(resolve)); await server.close();
  }
});
