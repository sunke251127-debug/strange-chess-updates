'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync, spawn } = require('node:child_process');
const { chromium } = require('playwright-core');
const ANDROID = path.resolve(__dirname, '..'), ROOT = path.resolve(ANDROID, '..');
const config = JSON.parse(fs.readFileSync(path.join(ANDROID, '.local/toolchain.json'), 'utf8').replace(/^\uFEFF/, ''));
const java = name => path.join(config.javaBin, name + '.exe');
const BUILD_INFO = JSON.parse(fs.readFileSync(path.join(ROOT, 'release/android-build-info.json'), 'utf8'));
const apk = path.join(ROOT, 'release', BUILD_INFO.file);
function run(exe, args) {
  const result = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr); return result.stdout + result.stderr;
}
function compileHarness() {
  const classes = fs.mkdtempSync(path.join(process.env.LOCALAPPDATA, 'StrangeChessMobileBuild/zip-test-'));
  run(java('javac'), ['-encoding', 'UTF-8', '--release', '8', '-d', classes,
    path.join(ANDROID, 'java/cn/strangechess/mobile/LocalRoutes.java'), path.join(ANDROID, 'java/cn/strangechess/mobile/LocalServer.java'), path.join(__dirname, 'ApkZipAssetsHarness.java')]);
  return classes;
}
test('the signed matching APK contains exact forward-slash asset names readable by Android without host filesystem normalization', () => {
  const classes = compileHarness();
  assert.match(run(java('java'), ['-cp', classes, 'cn.strangechess.mobile.ApkZipAssetsHarness', apk, 'verify']), /asset paths verified/);
  const info = BUILD_INFO;
  assert.equal(info.packageId, 'cn.strangechess.mobile.matching', 'installs beside, not over, the original edition');
  assert.ok(info.versionCode >= 10700, 'matching edition has its own higher version code');
  assert.equal(info.signerSha256, 'ce9a58357f5126eb3d7856387a07f8b89c89309930138a48e78a46914f50fee0', 'retain the installed publisher signature');
  assert.equal(info.file, '根本就没有这样的象棋-安卓及鸿蒙4.2.apk');
  assert.equal(info.versionName, '1.7.6');
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'release')).filter(name => name.endsWith('.apk')), [info.file], 'one fixed-name APK only');
});
test('actual APK ZIP asset streams preserve local play, show the plain name and open online play without focusing an input', { timeout: 30000 }, async () => {
  const classes = compileHarness();
  const child = spawn(java('java'), ['-cp', classes, 'cn.strangechess.mobile.ApkZipAssetsHarness', apk], { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
  let browser;
  try {
    const origin = await new Promise((resolve, reject) => {
      let output = ''; const timer = setTimeout(() => reject(new Error('ZIP asset server did not start')), 5000);
      child.stdout.on('data', data => { output += data; const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    const response = await fetch(origin + '/index.html'); assert.equal(response.status, 200);
    assert.match(await response.text(), /boardGrid/);
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const errors = [];
    await context.addInitScript(({ version, official }) => {
      let savedServer = official;
      window.AndroidShell = { getVersion: () => version, getServer: () => savedServer, setServer: value => { savedServer = value; }, checkUpdate() {}, getUpdateState: () => '{"status":"idle","message":"本地棋盘已就绪"}', toggleFullscreen() {}, installUpdate() {} };
    }, { version: BUILD_INFO.versionName, official: 'https://github.com/sunke251127-debug/strange-chess-updates' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/index.html');
    assert.equal(await page.locator('#boardGrid .cell').count(), 90);
    assert.equal(await page.title(), '根本就没有这样的象棋');
    assert.equal(await page.locator('.brand-title-row h1').textContent(), '根本就没有这样的象棋');
    assert.equal(await page.locator('.edition-badge').count(), 0);
    assert.equal(await page.locator('#updateSource').inputValue(), 'https://github.com/sunke251127-debug/strange-chess-updates', 'default GitHub repository path must stay complete');
    await page.locator('.cell.is-selectable').first().tap(); await page.locator('.cell.is-legal, .cell.is-capture').first().tap();
    await page.waitForFunction(() => document.querySelector('#moveNumber').textContent.includes('第 1 手'));
    await page.reload(); await page.waitForFunction(() => document.querySelector('#moveNumber').textContent.includes('第 1 手'));
    await page.evaluate(() => {
      window.editableFocusEvents = [];
      document.addEventListener('focusin', event => {
        if (event.target.matches('input, textarea, [contenteditable="true"]')) window.editableFocusEvents.push(event.target.id);
      });
    });
    async function openOnline() {
      await page.evaluate(() => { window.editableFocusEvents = []; });
      await page.locator('#onlineModeBtn').tap();
      // Let both the click handler and deferred focus callbacks finish.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)))));
      assert.equal(await page.locator('#onlineModeBtn').getAttribute('aria-selected'), 'true');
      assert.equal(await page.locator('#mobilePanel').evaluate(panel => panel.classList.contains('is-open')), true);
      assert.deepEqual(await page.evaluate(() => window.editableFocusEvents), [], 'switching modes must not activate an editable field');
      assert.equal(await page.evaluate(() => document.activeElement.matches('input, textarea, [contenteditable="true"]')), false);
    }
    await openOnline();
    await page.locator('#inviteInput').tap();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'inviteInput', 'an explicit input tap must still focus normally');
    await page.keyboard.insertText('手动输入测试');
    assert.equal(await page.locator('#inviteInput').inputValue(), '手动输入测试');
    await page.locator('#localModeBtn').tap();
    assert.equal(await page.locator('#localModeBtn').getAttribute('aria-selected'), 'true');
    await openOnline();
    await page.screenshot({ path: path.join(ROOT, 'screenshots/apk-' + BUILD_INFO.versionName + '-matching.png'), fullPage: false });
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); child.stdin.end('\n'); }
});
