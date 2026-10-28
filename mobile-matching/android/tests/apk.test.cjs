'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, spawn } = require('node:child_process');
const { chromium } = require('playwright-core');
const { startChessServer } = require('../../server/server.cjs');
const { localIce, pair } = require('../../tests/helpers/direct.cjs');
const ANDROID = path.resolve(__dirname, '..'), ROOT = path.resolve(ANDROID, '..');
const config = JSON.parse(fs.readFileSync(path.join(ANDROID, '.local/toolchain.json'), 'utf8').replace(/^\uFEFF/, ''));
const BUILD_INFO = JSON.parse(fs.readFileSync(path.join(ROOT, 'release/android-build-info.json'), 'utf8'));
const apk = path.join(ROOT, 'release', BUILD_INFO.file);
function run(exe, args, options = {}) {
  const r = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, ...options });
  assert.equal(r.status, 0, r.stdout + r.stderr); return r.stdout + r.stderr;
}
const java = name => path.join(config.javaBin, name + '.exe');

test('signed lightweight matching APK has the original publisher identity, no native DHT runtime and exact current assets', () => {
  const info = BUILD_INFO;
  const hash = crypto.createHash('sha256').update(fs.readFileSync(apk)).digest('hex');
  assert.equal(hash, info.sha256); assert.equal(fs.statSync(apk).size, info.bytes);
  assert.ok(info.bytes < 64 * 1024 * 1024, 'APK must contain the offline model within 64MiB: ' + info.bytes);
  assert.equal(info.offlineModel.simulations, 1024);
  assert.equal(info.edition, 'matching'); assert.equal(info.packageId, 'cn.strangechess.mobile.matching');
  assert.equal(info.nativeLibraries, false); assert.equal(info.webviewOnly, true);
  assert.equal(info.versionName, '1.7.6'); assert.equal(info.versionCode, 10706);
  assert.notEqual(info.packageId, 'cn.strangechess.mobile', 'matching edition must not share the original update identity');
  assert.equal(info.signerSha256, 'ce9a58357f5126eb3d7856387a07f8b89c89309930138a48e78a46914f50fee0');
  const signature = run(java('java'), ['-jar', path.join(config.buildTools, 'lib/apksigner.jar'), 'verify', '--min-sdk-version', '23', '--verbose', '--print-certs', apk]);
  assert.match(signature, /Verified using v1 scheme.*true/); assert.match(signature, /Verified using v2 scheme.*true/);
  assert.match(signature, /Verified using v3 scheme.*true/); assert.ok(signature.includes(info.signerSha256));
  const manifest = run(path.join(config.buildTools, 'aapt2.exe'), ['dump', 'badging', apk]);
  assert.match(manifest, /package: name='cn.strangechess.mobile.matching'/);
  assert.match(manifest, /versionCode='10706'/); assert.match(manifest, /versionName='1\.7\.6'/);
  assert.match(manifest, /application-label:'这样的象棋'/);
  assert.match(manifest, /minSdkVersion:'26'/); assert.match(manifest, /targetSdkVersion:'35'/);
  assert.match(manifest, /launchable-activity: name='cn.strangechess.mobile.MainActivity'/);
  const xmltree = run(path.join(config.buildTools, 'aapt2.exe'), ['dump', 'xmltree', '--file', 'AndroidManifest.xml', apk]);
  assert.match(xmltree, /cn\.strangechess\.mobile\.matching\.updates/);
  assert.match(xmltree, /cn\.strangechess\.mobile\.UpdateProvider/);
  const entries = run(java('jar'), ['tf', apk]).split(/\r?\n/).filter(Boolean);
  assert.ok(entries.includes('classes.dex'));
  assert.equal(entries.some(entry => entry.startsWith('lib/')), false, 'no native ABI directories');
  assert.equal(entries.some(entry => entry.endsWith('.so')), false, 'no JNI shared libraries');
  assert.equal(entries.some(entry => entry.startsWith('assets/dht/')), false, 'no Bare DHT bundle');
  assert.equal(entries.some(entry => entry.includes('dht-link.js')), false, 'legacy native bridge is not shipped');
  assert.ok(entries.includes('assets/www/src/random-match.js'));
  assert.ok(entries.includes('assets/www/src/relay-channel.js'));
  assert.ok(entries.includes('assets/www/android-shell.js'));
  for (const file of ['model.onnx', 'model.json', 'ort.wasm.min.js', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']) assert.ok(entries.includes('assets/www/ai/' + file));
  assert.ok(entries.includes('assets/www/ai-worker.js'));
  const apks = fs.readdirSync(path.join(ROOT, 'release')).filter(name => name.endsWith('.apk'));
  assert.deepEqual(apks, [BUILD_INFO.file], 'only one deliverable APK is kept');
  run(path.join(config.buildTools, 'zipalign.exe'), ['-c', '4', apk]);
  const unpack = fs.mkdtempSync(path.join(process.env.LOCALAPPDATA, 'StrangeChessMobileBuild/verify-'));
  run(java('jar'), ['xf', apk], { cwd: unpack });
  for (const name of ['game-engine.js', 'check-detector.js', 'invite.js', 'random-match.js', 'peer-link.js', 'relay-channel.js', 'system-random.js']) {
    assert.deepEqual(fs.readFileSync(path.join(unpack, 'assets/www/src', name)), fs.readFileSync(path.join(ROOT, 'src', name)), name + ' differs from source');
  }
  assert.equal(fs.readFileSync(path.join(unpack, 'assets/www/src/room-model.js'), 'utf8'), require('../../server/browser-room.cjs').browserRoom());
  const index = fs.readFileSync(path.join(unpack, 'assets/www/index.html'), 'utf8');
  assert.ok(index.includes('src/random-match.js')); assert.equal(index.includes('dht-link.js'), false);
  const activity = fs.readFileSync(path.join(ANDROID, 'java/cn/strangechess/mobile/MainActivity.java'), 'utf8');
  assert.equal(activity.includes('DhtBridge'), false, 'MainActivity must not start the native DHT bridge');
  assert.equal(activity.includes('startDht'), false, 'AndroidShell must not expose a native matching stub');
  const dex = fs.readFileSync(path.join(unpack, 'classes.dex'));
  for (const marker of ['DhtBridge', 'to/holepunch/bare/kit', 'libbare-kit', 'chess-dht.bundle']) assert.equal(dex.includes(Buffer.from(marker)), false, 'DEX still references ' + marker);
});

test('compiled Java local-asset router and HTTPS update origin restrictions execute successfully on JVM', () => {
  const out = fs.mkdtempSync(path.join(process.env.LOCALAPPDATA, 'StrangeChessMobileBuild/java-test-'));
  run(java('javac'), ['-encoding', 'UTF-8', '--release', '8', '-d', out,
    path.join(ANDROID, 'java/cn/strangechess/mobile/LocalRoutes.java'), path.join(__dirname, 'LocalRoutesTest.java')]);
  const output = run(java('java'), ['-cp', out, 'cn.strangechess.mobile.LocalRoutesTest']);
  assert.match(output, /checks passed/);
});

test('the signed APK entry boots offline, preserves saves, starts new games and connects two native entries by real WebRTC', { timeout: 45000 }, async () => {
  const unpack = fs.mkdtempSync(path.join(process.env.LOCALAPPDATA, 'StrangeChessMobileBuild/browser-test-'));
  run(java('jar'), ['xf', apk], { cwd: unpack });
  const compiled = path.join(unpack, 'java'); fs.mkdirSync(compiled);
  run(java('javac'), ['-encoding', 'UTF-8', '--release', '8', '-d', compiled,
    path.join(ANDROID, 'java/cn/strangechess/mobile/LocalRoutes.java'), path.join(ANDROID, 'java/cn/strangechess/mobile/LocalServer.java'), path.join(__dirname, 'LocalServerHarness.java')]);
  const localProcess = spawn(java('java'), ['-cp', compiled, 'cn.strangechess.mobile.LocalServerHarness', path.join(unpack, 'assets')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const localOrigin = await new Promise((resolve, reject) => {
    let text = ''; const timer = setTimeout(() => reject(new Error('native Java server timeout')), 5000);
    localProcess.stdout.on('data', data => { text += data; const match = text.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    localProcess.once('error', reject);
  });
  assert.equal((await fetch(localOrigin + '/server/server.cjs')).status, 404);
  assert.equal((await fetch(localOrigin + '/app.js', { method: 'POST' })).status, 405);
  assert.equal((await fetch(localOrigin + '/app.js', { method: 'HEAD' })).status, 200);
  const server = await startChessServer({ host: '127.0.0.1', port: 0, quiet: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const contexts = [], errors = [];
  let fullscreenCalls = 0;
  async function open(offline = false) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); contexts.push(context);
    await localIce(context);
    await context.exposeBinding('recordFullscreen', () => { fullscreenCalls++; });
    await context.addInitScript(backend => {
      let savedServer = backend;
      window.AndroidShell = {
        getVersion: () => '1.7.6', getServer: () => savedServer, setServer: s => { savedServer = s; },
        getUpdateState: () => JSON.stringify({ status: 'current', message: '当前安装包已就绪' }), checkUpdate() {}, installUpdate() {}, toggleFullscreen: () => window.recordFullscreen()
      };
    }, server.url);
    // Disconnect external networking while retaining the app's own native loopback server.
    if (offline) await context.route('**/*', route => new URL(route.request().url()).origin === localOrigin ? route.continue() : route.abort());
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto(localOrigin + '/index.html');
    await page.locator('#boardGrid .cell').last().waitFor(); return { page, context };
  }
  try {
    const { page: local, context } = await open(true);
    await local.locator('.cell.is-selectable').first().tap(); await local.locator('.cell.is-legal, .cell.is-capture').first().tap();
    await local.waitForFunction(() => document.querySelector('#moveNumber').textContent.includes('第 1 手'));
    await local.reload(); await local.waitForFunction(() => document.querySelector('#moveNumber').textContent.includes('第 1 手'));
    assert.equal(await local.locator('#fullscreenBtn').count(), 0);
    await local.evaluate(() => window.AndroidShell.toggleFullscreen()); assert.equal(fullscreenCalls, 1);
    assert.equal(await local.locator('#shuffleBtn').textContent(), '新棋局');
    local.once('dialog', dialog => dialog.dismiss()); await local.locator('#shuffleBtn').tap();
    assert.ok((await local.locator('#moveNumber').textContent()).includes('第 1 手'));
    local.once('dialog', dialog => dialog.accept()); await local.locator('#shuffleBtn').tap();
    assert.equal(await local.locator('.piece.face-down').count(), 32);
    assert.equal(await local.locator('.capture-tray .mini-piece').count(), 0);
    await local.locator('#toolsBtn').click();
    assert.equal(await local.locator('#toolsBtn').textContent(), '设置');
    assert.equal(await local.locator('#mobilePanelTitle').textContent(), '设置');
    assert.equal(await local.locator('#onlineCard').isVisible(), false);
    assert.equal(await local.locator('#extraTools > summary').textContent(), '更新');
    await local.locator('#extraTools > summary').tap();
    assert.equal(await local.locator('#webUpdateCheckBtn').isVisible(), true);
    assert.equal(await local.locator('#installBtn, #installHelp').count(), 0);
    assert.equal(await local.locator('#extraTools #undoBtn').count(), 0);
    const hasWorkers = await local.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length); assert.equal(hasWorkers, 0);
    await context.close();
    const a = (await open()).page, b = (await open()).page;
    for (const p of [a, b]) assert.equal(await p.locator('#findMatchBtn, #createRoomBtn, #joinRoomBtn, #roomCodeInput, #serverUrl').count(), 0);
    await pair(a,b,true);
    async function perspective(page, color) {
      assert.equal(await page.locator('#boardGrid').getAttribute('data-perspective'), color);
      const home = await page.locator(`.cell[data-x="4"][data-y="${color === 'red' ? 9 : 0}"]`).boundingBox();
      const away = await page.locator(`.cell[data-x="4"][data-y="${color === 'red' ? 0 : 9}"]`).boundingBox();
      assert.ok(home.y > away.y, color + ' must see their own home row below');
    }
    await perspective(a, 'red'); await perspective(b, 'black');
    assert.equal(server.manager.rooms.size, 0);
    await a.locator('.cell.is-selectable').first().click(); await a.locator('.cell.is-legal, .cell.is-capture').first().click();
    for (const p of [a,b]) await p.waitForFunction(() => document.querySelector('#moveNumber').textContent.includes('第 1 手'));
    assert.equal(await a.locator('#shuffleBtn').isDisabled(), false, 'new games are available by mutual consent');
    await b.locator('.cell.is-selectable').first().click(); await b.locator('.cell.is-legal, .cell.is-capture').first().click();
    for (const p of [a,b]) await p.waitForFunction(() => document.querySelector('#moveNumber').textContent.includes('第 2 手'));
    async function atMove(number) {
      for (const p of [a, b]) await p.waitForFunction(n => document.querySelector('#moveNumber').textContent === `第 ${n} 手`, number);
    }
    async function request(requester, responder, button, title) {
      await requester.locator(button).tap();
      await responder.locator('#onlineRequestDialog').waitFor({ state: 'visible' });
      assert.equal(await responder.locator('#onlineRequestTitle').textContent(), title);
      assert.equal(await requester.locator('#onlineRequestDialog').isVisible(), false);
    }
    await request(a, b, '#quickUndoBtn', '对方申请悔棋');
    await atMove(2);
    await b.locator('#declineOnlineRequestBtn').tap();
    await a.waitForFunction(() => !document.querySelector('#quickUndoBtn').disabled);
    await atMove(2);
    // Refusal keeps the red turn playable on the exact same game.
    await a.locator('.cell.is-selectable').first().tap(); await a.locator('.cell.is-legal, .cell.is-capture').first().tap();
    await atMove(3);
    await request(b, a, '#quickUndoBtn', '对方申请悔棋');
    await a.locator('#acceptOnlineRequestBtn').tap();
    await atMove(2);
    for (const p of [a, b]) assert.equal(await p.locator('#turnText').textContent(), '红方行棋');
    await request(a, b, '#shuffleBtn', '对方申请新棋局');
    await atMove(2);
    await b.locator('#declineOnlineRequestBtn').tap();
    await b.waitForFunction(() => !document.querySelector('#shuffleBtn').disabled);
    await atMove(2);
    await request(b, a, '#shuffleBtn', '对方申请新棋局');
    await a.screenshot({ path: path.join(ROOT, 'screenshots/apk-' + BUILD_INFO.versionName + '-consent.png'), animations: 'disabled' });
    await a.locator('#acceptOnlineRequestBtn').tap();
    await atMove(0);
    for (const p of [a, b]) {
      assert.equal(await p.locator('.piece.face-down').count(), 32);
      assert.equal(await p.locator('.capture-tray .mini-piece').count(), 0);
      assert.equal(await p.locator('#quickUndoBtn').isDisabled(), true, 'a new game cannot undo into the old one');
    }
    await perspective(a, 'black'); await perspective(b, 'red');
    await b.locator('.cell.is-selectable').first().tap(); await b.locator('.cell.is-legal, .cell.is-capture').first().tap(); await atMove(1);
    await a.locator('.cell.is-selectable').first().tap(); await a.locator('.cell.is-legal, .cell.is-capture').first().tap(); await atMove(2);
    for (const p of [a, b]) assert.equal(await p.locator('.piece-glyph').first().evaluate(glyph => getComputedStyle(glyph).transform), 'none');
    await a.screenshot({ path: path.join(ROOT, 'screenshots/apk-' + BUILD_INFO.versionName + '-black-view.png'), animations: 'disabled' });
    assert.equal(server.manager.rooms.size, 0);
    assert.deepEqual(errors, []);
  } finally { await Promise.all(contexts.map(c => c.close())); await browser.close(); await server.close(); localProcess.stdin.end('\n'); }
});
