'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn,spawnSync}=require('node:child_process');
const {chromium}=require('playwright-core');
const ROOT=path.resolve(__dirname,'../..'),ANDROID=path.join(ROOT,'android');
const tools=JSON.parse(fs.readFileSync(path.join(ANDROID,'.local/toolchain.json'),'utf8').replace(/^\uFEFF/,''));
const info=require('../../release/android-build-info.json'),model=require('../../assets/ai/model.json');
const apk=path.join(ROOT,'release',info.file);
test('actual signed APK ZIP and Java loopback server run the complete local model for a 256-search move with external requests blocked',{timeout:180000},async()=>{
  const java=name=>path.join(tools.javaBin,name+'.exe');
  const classes=fs.mkdtempSync(path.join(process.env.LOCALAPPDATA,'StrangeChessMobileBuild/offline-apk-test-'));
  const compiled=spawnSync(java('javac'),['-encoding','UTF-8','--release','8','-d',classes,
    path.join(ANDROID,'java/cn/strangechess/mobile/LocalRoutes.java'),path.join(ANDROID,'java/cn/strangechess/mobile/LocalServer.java'),path.join(__dirname,'ApkZipAssetsHarness.java')],{encoding:'utf8',windowsHide:true});
  assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
  const child=spawn(java('java'),['-cp',classes,'cn.strangechess.mobile.ApkZipAssetsHarness',apk],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let browser;
  try{
    const origin=await new Promise((resolve,reject)=>{
      let output='';const timer=setTimeout(()=>reject(Error('Java asset server timeout')),10000);
      child.stdout.on('data',data=>{output+=data;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});
      child.once('error',reject);
    });
    const modelResponse=await fetch(origin+'/ai/model.onnx');assert.equal(modelResponse.status,200);
    const bytes=Buffer.from(await modelResponse.arrayBuffer());assert.equal(bytes.length,model.bytes);assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),model.sha256);
    const wasm=await fetch(origin+'/ai/ort-wasm-simd-threaded.wasm');assert.equal(wasm.status,200);assert.match(wasm.headers.get('content-type'),/^application\/wasm/);
    await wasm.arrayBuffer();
    assert.equal((await fetch(origin+'/ai/../android-password.txt')).status,404);
    browser=await chromium.launch({channel:'msedge',headless:true});
    const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),external=[],errors=[];
    await context.addInitScript(()=>{window.AndroidShell={getVersion:()=>'1.7.7',getServer:()=>'',setServer(){},checkUpdate(){},getUpdateState:()=>'{"status":"idle","message":"本地模型已内置"}',installUpdate(){}};});
    await context.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();external.push(route.request().url());return route.abort();});
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin+'/index.html');
    await page.locator('#soloModeBtn').tap();await page.locator('input[name="soloColor"][value="black"]').check();await page.locator('#startSoloBtn').tap();
    await page.waitForFunction(()=>['thinking','error'].includes(document.querySelector('#aiStatus').dataset.phase),null,{timeout:60000}).catch(async error=>{
      throw Error(error.message+' '+JSON.stringify({errors,phase:await page.locator('#aiStatus').getAttribute('data-phase'),text:await page.locator('#aiStatusText').textContent(),modules:await page.evaluate(()=>[typeof StrangeChessAI,typeof StrangeChessAIRules,typeof StrangeChessLocalModel])}));
    });
    assert.notEqual(await page.locator('#aiStatus').getAttribute('data-phase'),'error',await page.locator('#aiStatusText').textContent());
    await page.locator('#toolsBtn').tap();assert.equal(await page.locator('#mobilePanel').isVisible(),true,'the board UI stays responsive during real WASM search');
    await page.locator('#closePanelBtn').tap();
    await page.waitForFunction(()=>document.querySelector('#aiStatus').dataset.completed==='256',null,{timeout:120000});
    assert.equal(await page.locator('#moveNumber').textContent(),'第 1 手');
    assert.equal(await page.locator('#turnText').textContent(),'黑方行棋');
    assert.equal(await page.locator('#aiStatus').getAttribute('data-model'),model.id);
    assert.equal(await page.locator('#aiProgress').getAttribute('max'),'256');
    assert.match(await page.locator('#modeLabel').textContent(),/每手256次/);
    assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
    await page.screenshot({path:path.join(ROOT,'screenshots/apk-1.7.7-offline.png')});
    const report={apk:info.sha256,model:model.sha256,modelId:model.id,simulations:256,javaZipAssets:true,externalRequests:external,errors,status:await page.locator('#aiStatusText').textContent(),physicalDevice:false};
    fs.writeFileSync(path.join(ROOT,'artifacts/offline-apk.json'),JSON.stringify(report,null,2));
  }finally{await browser?.close();child.stdin.end('\n');}
});
