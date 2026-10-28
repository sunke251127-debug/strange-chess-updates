'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright-core');
const {startChessServer}=require('../server/server.cjs');
const reference=require('./fixtures/offline-model-reference.json');
const ROOT=path.resolve(__dirname,'..');
async function launch(nativeSaved=null){
  const server=await startChessServer({host:'127.0.0.1',port:0,quiet:true});
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const origin=new URL(server.url).origin,external=[],errors=[];
  await context.addInitScript(saved=>{
    // APK has packaged assets, not a service worker. A real native bridge also
    // persists solo saves independently of the current loopback origin.
    window.nativeSaves=saved;
    window.AndroidShell=saved?{getGameSave:key=>window.nativeSaves[key]||'',setGameSave:(key,value)=>{window.nativeSaves[key]=value;}}:{};
  },nativeSaved);
  await context.route('**/*',route=>{
    if(new URL(route.request().url()).origin===origin)return route.continue();
    external.push(route.request().url());return route.abort();
  });
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(server.url);
  return {page,context,external,errors,origin,close:async()=>{await browser.close();await server.close();}};
}
test('actual packaged WASM reproduces PyTorch policy and both value heads at batch sizes 1 and 5',{timeout:120000},async()=>{
  const run=await launch();
  try{
    const page=run.page;
    await page.addScriptTag({url:run.origin+'/ai/ort.wasm.min.js'});
    const result=await page.evaluate(async({reference,origin})=>{
      ort.env.wasm.numThreads=1;ort.env.wasm.proxy=false;ort.env.wasm.wasmPaths=origin+'/ai/';
      const session=await ort.InferenceSession.create(origin+'/ai/model.onnx',{executionProviders:['wasm'],graphOptimizationLevel:'all'});
      const report=[];
      for(const n of [1,5]){
        const input=new Float32Array(n*3960);for(let i=0;i<n;i++)input.set(StrangeChessAI.encode(reference.observations[i]),i*3960);
        const tensor=new ort.Tensor('float32',input,[n,44,10,9]);
        const output=await session.run({observations:tensor});
        const errors={batch:n};
        for(const name of ['policy','value','process_value']){
          const expected=reference[name].slice(0,n).flat(),actual=output[name].data;
          if(actual.length!==expected.length)throw Error('Wrong '+name+' shape');
          let error=0;for(let i=0;i<actual.length;i++)error=Math.max(error,Math.abs(actual[i]-expected[i]));
          errors[name]=error;output[name].dispose();
        }
        tensor.dispose();report.push(errors);
      }
      await session.release();return report;
    },{reference,origin:run.origin});
    for(const row of result)for(const name of ['policy','value','process_value'])assert.ok(row[name]<0.0001,JSON.stringify(row));
    fs.mkdirSync(path.join(ROOT,'artifacts'),{recursive:true});
    fs.writeFileSync(path.join(ROOT,'artifacts/offline-model-parity.json'),JSON.stringify(result,null,2));
    assert.deepEqual(run.errors,[]);assert.deepEqual(run.external,[]);
  }finally{await run.close();}
});
test('native solo preferences restore into a fresh web origin and receive undo saves',{timeout:30000},async()=>{
  const E=require('../src/game-engine.js'),R=require('../src/ai-rules.js');
  let state=R.enable(E.createGame(()=>.37),8,3);const undoStack=[];
  for(let i=0;i<2;i++){
    undoStack.push(state);const action=R.legalActions(state)[0],from=Math.floor(action/90),to=action%90;
    state=R.move(state,from%9,Math.floor(from/9),to%9,Math.floor(to/9)).state;
  }
  const native={'strange-chess-mode-v1':'solo','strange-chess-solo-v1':JSON.stringify({state,undoStack,moveLog:[],humanColor:'red'})};
  const first=await launch(native);let saved,oldOrigin;
  try{
    assert.equal(await first.page.locator('#soloModeBtn').getAttribute('aria-selected'),'true');
    assert.equal(await first.page.locator('#moveNumber').textContent(),'第 2 手');
    await first.page.locator('#quickUndoBtn').tap();
    saved=await first.page.evaluate(()=>window.nativeSaves);oldOrigin=first.origin;
    assert.equal(JSON.parse(saved['strange-chess-solo-v1']).state.moveNumber,0);
  }finally{await first.close();}
  const second=await launch(saved);
  try{
    assert.notEqual(second.origin,oldOrigin);
    assert.equal(await second.page.locator('#soloModeBtn').getAttribute('aria-selected'),'true');
    assert.equal(await second.page.locator('#moveNumber').textContent(),'第 0 手');
  }finally{await second.close();}
});
test('real historical model plays 256-search moves locally; solo saves, undo, black view and cancellation preserve other modes',{timeout:240000},async()=>{
  const run=await launch();
  try{
    const page=run.page;
    // Preserve a real two-player game independently of the new solo save.
    await page.locator('.cell.is-selectable').first().tap();await page.locator('.cell.is-legal,.cell.is-capture').first().tap();
    const original=await page.evaluate(()=>localStorage.getItem('strange-chess-offline-v1'));
    await page.locator('#soloModeBtn').tap();await page.locator('#startSoloBtn').tap();
    await page.waitForFunction(()=>document.querySelector('#aiStatus').dataset.phase==='ready',null,{timeout:60000});
    assert.equal(await page.locator('#aiProgress').getAttribute('max'),'256');
    assert.match(await page.locator('#modeLabel').textContent(),/每手256次/);
    await page.locator('.cell.is-selectable').first().tap();await page.locator('.cell.is-legal,.cell.is-capture').first().tap();
    await page.waitForFunction(()=>document.querySelector('#aiStatus').dataset.phase==='thinking');
    assert.equal(await page.locator('.cell.is-selectable').count(),0,'human cannot move for the model');
    await page.waitForFunction(()=>document.querySelector('#moveNumber').textContent==='第 2 手',null,{timeout:120000});
    assert.equal(await page.locator('#aiStatus').getAttribute('data-completed'),'256');
    assert.equal(await page.locator('#aiStatus').getAttribute('data-model'),'saved-20261028-120845-round50');
    const completed=await page.locator('#aiStatusText').textContent();
    await page.screenshot({path:path.join(ROOT,'screenshots/offline-model-red.png')});
    await page.locator('#quickUndoBtn').tap();
    assert.equal(await page.locator('#moveNumber').textContent(),'第 0 手');
    assert.equal(await page.evaluate(()=>localStorage.getItem('strange-chess-offline-v1')),original);
    await page.locator('#soloModeBtn').tap();await page.locator('input[name="soloColor"][value="black"]').check();await page.locator('#startSoloBtn').tap();
    await page.waitForFunction(()=>document.querySelector('#aiStatus').dataset.phase==='thinking');
    assert.equal(await page.locator('#boardGrid').getAttribute('data-perspective'),'black');
    await page.locator('#localModeBtn').tap();
    assert.equal(await page.locator('#moveNumber').textContent(),'第 1 手');
    await page.waitForTimeout(1200);
    assert.equal(await page.locator('#moveNumber').textContent(),'第 1 手','cancelled worker cannot play into two-player mode');
    await page.locator('#soloModeBtn').tap();await page.locator('#startSoloBtn').tap();
    await page.waitForFunction(()=>document.querySelector('#moveNumber').textContent==='第 1 手'&&document.querySelector('#aiStatus').dataset.completed==='256',null,{timeout:120000});
    assert.equal(await page.locator('#boardGrid').getAttribute('data-perspective'),'black');
    assert.equal(await page.locator('#turnText').textContent(),'黑方行棋');
    assert.equal(await page.locator('#quickUndoBtn').isDisabled(),true,'opening model move cannot undo a human move that never happened');
    await page.screenshot({path:path.join(ROOT,'screenshots/offline-model-black.png')});
    const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('strange-chess-solo-v1')));
    assert.equal(saved.humanColor,'black');assert.equal(saved.state.moveNumber,1);
    await page.reload();
    await page.waitForFunction(()=>document.querySelector('#aiStatus').dataset.phase==='ready',null,{timeout:60000});
    assert.equal(await page.locator('#soloModeBtn').getAttribute('aria-selected'),'true');
    assert.equal(await page.locator('#moveNumber').textContent(),'第 1 手');
    assert.equal(await page.locator('#boardGrid').getAttribute('data-perspective'),'black');
    await page.locator('#onlineModeBtn').tap();
    assert.equal(await page.locator('#onlineModeBtn').getAttribute('aria-selected'),'true');
    assert.equal(await page.evaluate(()=>document.activeElement.matches('input,textarea')),false);
    assert.deepEqual(run.errors,[]);assert.deepEqual(run.external,[]);
    fs.writeFileSync(path.join(ROOT,'artifacts/offline-model-ui.json'),JSON.stringify({completed,red:true,black:true,cancelled:true,separateSaves:true,restored:true,externalRequests:run.external,errors:run.errors},null,2));
  }finally{await run.close();}
});
