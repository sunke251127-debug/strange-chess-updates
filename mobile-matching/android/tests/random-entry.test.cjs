'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { chromium } = require('playwright-core');
const { faultBroker } = require('../../tests/helpers/fault-broker.cjs');
const ANDROID = path.resolve(__dirname, '..'), ROOT = path.resolve(ANDROID, '..');
const BUILD_INFO = JSON.parse(fs.readFileSync(path.join(ROOT, 'release/android-build-info.json'), 'utf8'));
const config = JSON.parse(fs.readFileSync(path.join(ANDROID, '.local/toolchain.json'), 'utf8').replace(/^\uFEFF/, ''));
const java = name => path.join(config.javaBin, name + '.exe');
const apk = path.join(ROOT, 'release', BUILD_INFO.file);

async function harness(run, disableRtc = false) {
  const classes = fs.mkdtempSync(path.join(os.tmpdir(), 'ChessRandomApk-'));
  const compiled = spawnSync(java('javac'), ['-encoding', 'UTF-8', '--release', '8', '-d', classes,
    path.join(ANDROID, 'java/cn/strangechess/mobile/LocalRoutes.java'), path.join(ANDROID, 'java/cn/strangechess/mobile/LocalServer.java'),
    path.join(__dirname, 'ApkZipAssetsHarness.java')], { encoding: 'utf8', windowsHide: true });
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const assetServer = spawn(java('java'), ['-cp', classes, 'cn.strangechess.mobile.ApkZipAssetsHarness', apk], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const broker = await faultBroker();
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const contexts = [], errors = [];
  const origin = await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(new Error('APK ZIP asset server timeout')), 5000);
    assetServer.stdout.on('data', data => { output += data; const found = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (found) { clearTimeout(timer); resolve(found[0]); } });
    assetServer.once('error', error => { clearTimeout(timer); reject(error); });
  });
  async function open() {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); contexts.push(context);
    await context.addInitScript(({ version, disabled }) => {
      window.nativeCalls = 0;
      window.AndroidShell = {
        getVersion: () => version, getServer: () => '', setServer() {}, checkUpdate() {}, installUpdate() {},
        getUpdateState: () => '{"status":"idle","message":"本地棋盘已就绪"}', toggleFullscreen() {},
        isDhtAvailable: () => true,
        startDht() { window.nativeCalls++; throw Error('Native runtime cannot start on this phone'); }
      };
      if (disabled) window.RTCPeerConnection = class { constructor() { throw Error('UDP unavailable'); } };
    }, { version: BUILD_INFO.versionName, disabled: disableRtc });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/index.html'); await page.locator('#boardGrid .cell').last().waitFor();
    await page.evaluate(url => {
      const Native = StrangeChessRandom.Link;
      window.StrangeChessRandom = { ...StrangeChessRandom, Link: class extends Native {
        constructor(options = {}) {
          super({ ...options, discoveryUrls: [url], relayUrls: [url], iceServers: [],
            electionDelay: 50, electionSettle: 180, matchInterval: 100, nodeTimeout: 1000,
            introductionTimeout: 12000, discoveryReleaseDelay: 700, gatherTimeout: 400, fallbackDelay: 300,
            relayOptions: { heartbeatInterval: 200, retryInterval: 100, peerTimeout: 2000 } });
          window.testRandom = this; window.roomEvents = [];
          this.addEventListener('message', event => { const value = JSON.parse(event.data); if (value.type === 'room') roomEvents.push(value); });
        }
      } };
    }, broker.url);
    return page;
  }
  try { await run({ open, broker, errors, origin }); }
  finally { await Promise.all(contexts.map(context => context.close())); await browser.close(); await broker.close(); assetServer.stdin.end('\n'); }
}
async function start(page) { await page.locator('#onlineModeBtn').click(); await page.locator('#randomMatchBtn').click(); }
async function playing(pages) { for (const page of pages) await page.waitForFunction(() => window.mobileGame.hasRoom() && document.querySelector('#roomStatusText').textContent.includes('对局进行中')); }
async function move(page, number, peers) {
  await page.locator('.cell.is-selectable').first().tap(); await page.locator('.cell.is-legal, .cell.is-capture').first().tap();
  for (const peer of peers) await peer.waitForFunction(n => window.roomEvents.at(-1)?.state.moveNumber === n, number);
}
async function sides(a, b) { return (await a.locator('#seatBadge').textContent()).includes('红') ? [a, b] : [b, a]; }

test('signed APK resources pair through the normal random button without any native matching call and survive the coordinator leaving', { timeout: 60000 }, async () => {
  await harness(async ({ open, broker, errors }) => {
    const a = await open(); await start(a);
    await a.waitForFunction(() => testRandom.isCoordinator, null, { timeout: 8000 });
    await a.waitForFunction(() => !document.querySelector('#randomMatchStatus').hidden && /匹配服务|匹配节点/.test(document.querySelector('#randomMatchStatus').textContent));
    await a.setViewportSize({ width: 320, height: 640 });
    await a.screenshot({ path: path.join(ROOT, 'screenshots/apk-' + BUILD_INFO.versionName + '-random-320x640.png') });
    await a.setViewportSize({ width: 390, height: 844 });
    const b = await open(); await start(b); await playing([a, b]);
    for (const page of [a, b]) {
      assert.equal(await page.evaluate(() => nativeCalls), 0, 'the normal random button must not call the native bridge');
      assert.equal(await page.evaluate(() => testRandom.transport), 'rtc');
      assert.ok((await page.evaluate(() => roomEvents.at(-1).state.pieces)).every(piece => !Object.hasOwn(piece, 'kind') && !Object.hasOwn(piece, 'color')));
    }
    const leader = await a.evaluate(() => testRandom.isCoordinator) ? a : b;
    await leader.waitForFunction(() => testRandom.players.size === 0 && testRandom.introductions.size === 0);
    const [host, guest] = await sides(a, b); await move(host, 1, [a, b]); await move(guest, 2, [a, b]);
    await a.screenshot({ path: path.join(ROOT, 'screenshots/apk-' + BUILD_INFO.versionName + '-random-game.png') });
    await leader.evaluate(() => testRandom.stopMatching());
    await move(host, 3, [a, b]); await move(guest, 4, [a, b]);
    assert.deepEqual(await a.evaluate(() => roomEvents.at(-1).state), await b.evaluate(() => roomEvents.at(-1).state));
    const raw = Buffer.concat(broker.published).toString('utf8');
    assert.equal(raw.includes('SC-DIRECT-1:'), false, 'signalling offers are encrypted from the public channel');
    assert.equal(raw.includes('"pieces"'), false);
    for (const page of [a, b]) assert.equal(raw.includes(await page.evaluate(() => testRandom.relayKey)), false);

    const c = await open(); await start(c);
    await c.waitForFunction(() => testRandom.isCoordinator, null, { timeout: 8000 });
    const d = await open(); await start(d); await playing([c, d]);
    assert.notEqual(await c.evaluate(() => testRandom.assignment.session), await a.evaluate(() => testRandom.assignment.session));
    const [nextHost, nextGuest] = await sides(c, d); await move(nextHost, 1, [c, d]); await move(nextGuest, 2, [c, d]);

    const e = await open(); await start(e); await e.locator('#cancelRandomBtn').waitFor();
    await e.locator('#cancelRandomBtn').click();
    assert.equal(await e.evaluate(() => testRandom.ended), true);
    assert.match(await e.locator('#onlineFormMessage').textContent(), /已取消匹配/);
    await start(e);
    await e.evaluate(() => testRandom.close('随机匹配启动失败：测试中的明确原因'));
    assert.equal(await e.locator('#randomMatchStatus').isVisible(), true);
    assert.match(await e.locator('#randomMatchStatus').textContent(), /测试中的明确原因/);
    assert.deepEqual(errors, []);
  });
});

test('signed APK resources fall back to the encrypted relay through the normal random button when WebRTC is unavailable', { timeout: 45000 }, async () => {
  await harness(async ({ open, broker, errors }) => {
    const a = await open(), b = await open(); await start(a); await start(b); await playing([a, b]);
    for (const page of [a, b]) { assert.equal(await page.evaluate(() => nativeCalls), 0); assert.equal(await page.evaluate(() => testRandom.transport), 'relay'); }
    const [host, guest] = await sides(a, b); await move(host, 1, [a, b]); await move(guest, 2, [a, b]);
    assert.deepEqual(await a.evaluate(() => roomEvents.at(-1).state), await b.evaluate(() => roomEvents.at(-1).state));
    const raw = Buffer.concat(broker.published).toString('utf8');
    assert.equal(raw.includes('SC-DIRECT-1:'), false); assert.equal(raw.includes('"pieces"'), false);
    assert.deepEqual(errors, []);
  }, true);
});
