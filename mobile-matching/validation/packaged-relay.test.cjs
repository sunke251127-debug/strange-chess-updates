'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { chromium } = require('playwright-core');
const E = require('../src/game-engine.js');
const { pair } = require('../tests/helpers/direct.cjs');

test('signed APK ZIP entry renders centered vectors offline and synchronizes over public relay with WebRTC unavailable', { timeout: 65000 }, async () => {
  const root = path.resolve(__dirname,'..'), android = path.join(root,'android');
  const cfg = JSON.parse(fs.readFileSync(path.join(android,'.local/toolchain.json'),'utf8').replace(/^\uFEFF/,''));
  const info = JSON.parse(fs.readFileSync(path.join(root,'release/android-build-info.json'),'utf8'));
  assert.ok(info.versionCode >= 10507); assert.equal(info.signerSha256,'ce9a58357f5126eb3d7856387a07f8b89c89309930138a48e78a46914f50fee0');
  const apk = path.join(root,'release',info.file), classes = fs.mkdtempSync(path.join(os.tmpdir(),'chess-packaged-relay-'));
  const javac = spawnSync(path.join(cfg.javaBin,'javac.exe'),['-encoding','UTF-8','--release','8','-d',classes,
    path.join(android,'java/cn/strangechess/mobile/LocalRoutes.java'), path.join(android,'java/cn/strangechess/mobile/LocalServer.java'), path.join(android,'tests/ApkZipAssetsHarness.java')],{encoding:'utf8',windowsHide:true});
  assert.equal(javac.status,0,javac.stdout + javac.stderr);
  const child = spawn(path.join(cfg.javaBin,'java.exe'),['-cp',classes,'cn.strangechess.mobile.ApkZipAssetsHarness',apk],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const contexts = [], errors = [], sockets = []; let browser;
  try {
    const origin = await new Promise((resolve,reject) => {
      let text = ''; const timer = setTimeout(() => reject(new Error('APK ZIP entry did not start')),5000);
      child.stdout.on('data',data => { text += data; const m = text.match(/http:\/\/127\.0\.0\.1:\d+/); if (m) { clearTimeout(timer); resolve(m[0]); } }); child.once('error',reject);
    });
    browser = await chromium.launch({channel:'msedge',headless:true});
    const fixture = E.createGame(() => .5); fixture.pieces.forEach(p=>{p.faceUp=true;});
    async function open() {
      const context = await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2}); contexts.push(context);
      await context.addInitScript(({state,version}) => {
        if (!localStorage.getItem('strange-chess-offline-v1')) localStorage.setItem('strange-chess-offline-v1',JSON.stringify({state}));
        window.AndroidShell = {getVersion:()=>version,getServer:()=>'',setServer(){},checkUpdate(){},getUpdateState:()=>'{"status":"idle","message":"本地棋盘已就绪"}',installUpdate(){}};
        window.RTCPeerConnection = function(){throw new Error('WebRTC unavailable for real public fallback test');};
        CanvasRenderingContext2D.prototype.measureText = () => { throw new Error('System font metrics unavailable'); };
        window.packedViews=[]; const dispatch = EventTarget.prototype.dispatchEvent;
        EventTarget.prototype.dispatchEvent=function(event){if(event.type==='message'&&typeof event.data==='string'){try{const value=JSON.parse(event.data);if(value.type==='room')window.packedViews.push(value);}catch{}}return dispatch.call(this,event);};
      },{state:fixture,version:info.versionName});
      // All HTTP assets must come from the actual APK. WSS is deliberately
      // available for the real external fallback connection below.
      await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
      const page = await context.newPage(); page.on('pageerror',e=>errors.push(e.message)); page.on('websocket',socket=>sockets.push(socket.url()));
      await page.goto(origin+'/index.html'); await page.locator('.piece-glyph-outline').last().waitFor(); return page;
    }
    const host = await open(), guest = await open();
    for (const [width,height] of [[390,844],[844,390]]) {
      await host.setViewportSize({width,height});
      const centers = await host.locator('.piece-glyph').evaluateAll(nodes=>nodes.map(g=>{const svg=g.querySelector('svg'),b=svg.querySelector('path').getBBox();return{text:g.textContent,x:b.x+b.width/2,y:b.y+b.height/2};}));
      assert.equal(centers.length,32); assert.equal(new Set(centers.map(c=>c.text)).size,14);
      for (const c of centers) assert.ok(Math.abs(c.x-500)<.01&&Math.abs(c.y-500)<.01,JSON.stringify(c));
      await host.screenshot({path:path.join(root,`screenshots/apk-${info.versionName}-vectors-${width}x${height}.png`)});
    }
    await host.setViewportSize({width:390,height:844});
    for (const page of [host,guest]) { await page.locator('#shuffleBtn').tap(); await page.waitForFunction(()=>document.querySelectorAll('.piece.face-down').length===32); }
    await pair(host,guest,true);
    for (const page of [host,guest]) {
      assert.match(await page.locator('#shareUrl').textContent(),/加密中继/);
      assert.ok(await page.evaluate(()=>window.packedViews.at(-1).state.pieces.every(p=>!Object.hasOwn(p,'color')&&!Object.hasOwn(p,'kind'))));
    }
    await host.locator('.cell.is-selectable').first().tap(); await host.locator('.cell.is-legal').first().tap();
    for (const page of [host,guest]) await page.waitForFunction(()=>document.querySelector('#moveNumber').textContent.includes('第 1 手'));
    await guest.locator('.cell.is-selectable').first().tap(); await guest.locator('.cell.is-legal').first().tap();
    for (const page of [host,guest]) await page.waitForFunction(()=>document.querySelector('#moveNumber').textContent.includes('第 2 手'));
    assert.deepEqual(await host.evaluate(()=>window.packedViews.at(-1).state),await guest.evaluate(()=>window.packedViews.at(-1).state));
    await host.waitForFunction(()=>!document.querySelector('.piece.flip-running'));
    await host.screenshot({path:path.join(root,`screenshots/apk-${info.versionName}-public-relay.png`)});
    assert.ok(sockets.length>=2); assert.ok(sockets.every(url=>url.startsWith('wss://broker.emqx.io:8084/')||url.startsWith('wss://test.mosquitto.org:8081/')));
    await guest.locator('#toolsBtn').tap(); await guest.locator('#leaveRoomBtn').tap(); await host.waitForFunction(()=>!window.mobileGame.hasRoom());
    assert.deepEqual(errors,[]);
    console.log('Actual signed APK '+info.versionName+': 14 fixed vector glyphs centered; two packaged entries played through public encrypted WSS with RTC unavailable.');
  } finally { await Promise.all(contexts.map(c=>c.close())); if(browser)await browser.close(); child.stdin.end('\n'); }
});
