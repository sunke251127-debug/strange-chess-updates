'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { chromium } = require('playwright-core');
const { pair } = require('../tests/helpers/direct.cjs');

test('delivered APK recovers both real public-relay connections and continues the original game without another invitation', { timeout: 70000 }, async () => {
  const root = path.resolve(__dirname, '..'), android = path.join(root, 'android');
  const cfg = JSON.parse(fs.readFileSync(path.join(android, '.local/toolchain.json'), 'utf8').replace(/^\uFEFF/, ''));
  const info = JSON.parse(fs.readFileSync(path.join(root, 'release/android-build-info.json'), 'utf8'));
  assert.ok(info.versionCode >= 10508);
  assert.equal(info.signerSha256, 'ce9a58357f5126eb3d7856387a07f8b89c89309930138a48e78a46914f50fee0');
  const classes = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-apk-recovery-'));
  const compiled = spawnSync(path.join(cfg.javaBin, 'javac.exe'), ['-encoding', 'UTF-8', '--release', '8', '-d', classes,
    path.join(android, 'java/cn/strangechess/mobile/LocalRoutes.java'), path.join(android, 'java/cn/strangechess/mobile/LocalServer.java'), path.join(android, 'tests/ApkZipAssetsHarness.java')], { encoding: 'utf8', windowsHide: true });
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const child = spawn(path.join(cfg.javaBin, 'java.exe'), ['-cp', classes, 'cn.strangechess.mobile.ApkZipAssetsHarness', path.join(root, 'release', info.file)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const contexts = [], errors = [], pages = []; let browser;
  try {
    const origin = await new Promise((resolve, reject) => {
      let output = ''; const timer = setTimeout(() => reject(new Error('APK resource server did not start')), 5000);
      child.stdout.on('data', data => { output += data; const m = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (m) { clearTimeout(timer); resolve(m[0]); } });
      child.once('error', reject);
    });
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    async function open() {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); contexts.push(context);
      await context.addInitScript(version => {
        window.AndroidShell = { getVersion: () => version, getServer: () => '', setServer() {}, checkUpdate() {}, getUpdateState: () => '{"status":"idle"}', installUpdate() {} };
        window.RTCPeerConnection = class { constructor() { throw new Error('No RTC path in packaged recovery check'); } };
        window.relaySockets = [];
        const Native = WebSocket;
        window.WebSocket = class extends Native { constructor(url, protocols) { super(url, protocols); relaySockets.push(this); } };
      }, info.versionName);
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      const page = await context.newPage(); pages.push(page); page.on('pageerror', error => errors.push(error.message)); await page.goto(origin + '/index.html');
      await page.evaluate(() => {
        const Native = StrangeChessDirect.Link;
        StrangeChessDirect.Link = class extends Native {
          constructor(options) {
            super(options); window.testLink = this; window.recoveredViews = []; window.recoveryStates = [];
            this.addEventListener('message', event => { const value = JSON.parse(event.data); if (value.type === 'room') recoveredViews.push(value); });
            this.addEventListener('state', event => recoveryStates.push(event.detail));
          }
        };
      });
      return page;
    }
    const host = await open(), guest = await open(); await pair(host, guest, true);
    const move = async (page, n) => {
      await page.locator('.cell.is-selectable').first().tap(); await page.locator('.cell.is-legal, .cell.is-capture').first().tap();
      for (const target of [host, guest]) await target.waitForFunction(n => recoveredViews.at(-1)?.state.moveNumber === n, n);
    };
    await move(host, 1); await move(guest, 2);
    const before = await host.evaluate(() => ({ view: recoveredViews.at(-1), token: testLink.guestSeat.token }));
    const checkpoints = [];
    for (const page of [host, guest]) checkpoints.push(await page.evaluate(() => {
      const at = recoveryStates.length, sockets = relaySockets.length;
      // A graceful WebSocket close can leave one broker path in CLOSING while
      // the other has already reconnected. Inject transport errors so both
      // active paths are retired immediately, then reconnect to the real nodes.
      for (const ws of relaySockets) if (ws.readyState < 2) ws.dispatchEvent(new Event('error'));
      return { at, sockets };
    }));
    for (const [i, page] of [host, guest].entries()) {
      await page.waitForFunction(at => recoveryStates.slice(at).includes('reconnecting'), checkpoints[i].at);
      await page.waitForFunction(count => relaySockets.length > count && testLink.relay.peerConnected && testLink.readyState === 1 && document.querySelector('#roomStatusText').textContent.includes('对局进行中'), checkpoints[i].sockets);
      assert.equal(await page.evaluate(() => testLink.ended || !mobileGame.hasRoom()), false);
    }
    const restored = await host.evaluate(() => ({ view: recoveredViews.at(-1), token: testLink.guestSeat.token }));
    assert.equal(restored.view.roomCode, before.view.roomCode); assert.equal(restored.token, before.token);
    assert.deepEqual(restored.view.state, before.view.state);
    await move(host, 3); await move(guest, 4);
    assert.deepEqual(await host.evaluate(() => recoveredViews.at(-1).state), await guest.evaluate(() => recoveredViews.at(-1).state));
    assert.equal(await host.evaluate(() => testLink.room.gameCount), 1);
    await host.waitForFunction(() => !document.querySelector('.piece.flip-running'));
    await host.screenshot({ path: path.join(root, 'screenshots', `apk-${info.versionName}-recovered-relay.png`) });
    assert.deepEqual(errors, []);
    await guest.locator('#toolsBtn').tap(); await guest.locator('#leaveRoomBtn').tap(); await host.waitForFunction(() => !mobileGame.hasRoom());
    console.log('Actual signed APK ' + info.versionName + ': both public WSS transports reconnected, same room/seat/board preserved, four moves synchronized without reinviting.');
  } catch (error) {
    for (const [i, page] of pages.entries()) console.log('APK failure peer ' + i, JSON.stringify(await page.evaluate(() => ({
      states: window.recoveryStates, ended: window.testLink?.ended, ready: window.testLink?.readyState,
      role: window.testLink?.host, transport: window.testLink?.transport,
      relayClosed: window.testLink?.relay?.closed, peer: window.testLink?.relay?.peerConnected,
      sockets: window.relaySockets?.map(ws => ({ url: ws.url, state: ws.readyState })),
      managedSockets: [...(window.testLink?.relay?.sockets || [])].map(ws => ws.readyState),
      hasRecovery: typeof window.testLink?.relay?.schedule, pending: window.testLink?.relay?.unconfirmed?.size,
      received: window.testLink?.relay?.received, sequence: window.testLink?.relay?.sequence,
      views: window.recoveredViews?.map(v => ({ move: v.state.moveNumber, paused: v.paused })),
      status: document.querySelector('#roomStatusText').textContent, badge: document.querySelector('#connBadge').textContent,
      message: document.querySelector('#onlineFormMessage').textContent
    }))));
    throw error;
  } finally { await Promise.all(contexts.map(c => c.close())); if (browser) await browser.close(); child.stdin.end('\n'); }
});
