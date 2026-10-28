'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright-core');
const E = require('../src/game-engine.js');
const { startChessServer } = require('../server/server.cjs');
const { localIce, directFixture, pair } = require('./helpers/direct.cjs');
function fixture() {
  const state = E.createGame(() => .5);
  const moving = state.pieces.find(p => p.x===0 && p.y===6); moving.color='black'; moving.kind='rook';
  const target = state.pieces.find(p => p.x===0 && p.y===9); target.color='red'; target.kind='advisor';
  const removed = state.pieces.filter(p => p.x===1 && (p.y===0 || p.y===9));
  state.pieces = state.pieces.filter(p => !removed.includes(p));
  state.captured = removed.map((p,i) => ({...p, color:i===0?'black':'red', kind:'horse', faceUp:true, capturedBy:i===0?'red':'black'}));
  return state;
}
test('compact glyphs, single smooth reveal, visible captured trays and simple online entry work on mobile', {timeout:45000}, async () => {
  const server = await startChessServer({host:'127.0.0.1',port:0,quiet:true,initialStateFactory:fixture});
  const browser = await chromium.launch({channel:'msedge',headless:true});
  try {
    for (const [width,height] of [[360,800],[390,844],[844,390]]) {
      const context = await browser.newContext({viewport:{width,height},isMobile:true,hasTouch:true});
      await context.addInitScript(state => localStorage.setItem('strange-chess-offline-v1',JSON.stringify({state,undoStack:[],moveLog:[]})),fixture());
      const page = await context.newPage(); await page.goto(server.url);
      await page.waitForFunction(() => document.querySelectorAll('.cell').length===90);
      const tray = await page.evaluate(() => {
        const board=document.querySelector('.board-frame').getBoundingClientRect(), card=document.querySelector('.capture-card').getBoundingClientRect();
        return {bottom:card.bottom,top:card.top,boardBottom:board.bottom,red:document.querySelectorAll('#capturedRed .mini-piece').length,black:document.querySelectorAll('#capturedBlack .mini-piece').length};
      });
      assert.ok(tray.top>=tray.boardBottom-1); assert.ok(tray.bottom<=height); assert.equal(tray.red,1); assert.equal(tray.black,1);
      await page.evaluate(() => { window.flipStarts=0; document.querySelector('#boardGrid').addEventListener('animationstart',e=>{if(e.animationName==='mobile-piece-flip') window.flipStarts++;}); });
      await page.locator('.cell[data-x="0"][data-y="6"]').tap(); await page.locator('.cell[data-x="0"][data-y="5"]').tap();
      await page.waitForFunction(() => document.querySelector('.cell[data-x="0"][data-y="5"] .piece.flip-running'));
      await page.evaluate(() => {window.flipNode=document.querySelector('.cell[data-x="0"][data-y="5"] .piece');});
      await page.locator('.cell[data-x="0"][data-y="5"]').tap();
      assert.equal(await page.evaluate(() => window.flipNode===document.querySelector('.cell[data-x="0"][data-y="5"] .piece')),true);
      await page.waitForFunction(() => !document.querySelector('.piece.flip-running'));
      assert.equal(await page.evaluate(()=>window.flipStarts),1,'selection must not restart reveal');
      const bounds = await page.evaluate(() => {
        const el=document.querySelector('.cell[data-x="0"][data-y="5"] .piece'); const p=el.getBoundingClientRect(); const glyph=el.querySelector('.piece-glyph'), g=glyph.getBoundingClientRect();
        const tag=document.querySelector('.cell[data-x="0"][data-y="5"] .move-tag').getBoundingClientRect();
        return {left:g.left-p.left,right:p.right-g.right,top:g.top-p.top,bottom:p.bottom-g.bottom,font:parseFloat(getComputedStyle(glyph).fontSize),diameter:p.width,tagWidth:tag.width,tagFont:parseFloat(getComputedStyle(document.querySelector('.cell[data-x="0"][data-y="5"] .move-tag')).fontSize),transform:getComputedStyle(el).transform};
      });
      assert.ok(Math.min(bounds.left,bounds.right,bounds.top,bounds.bottom)>2,JSON.stringify(bounds));
      assert.ok(bounds.font<bounds.diameter*.65); assert.ok(bounds.tagWidth<=12 && bounds.tagFont<=9);
      await page.locator('.cell[data-x="0"][data-y="9"]').tap();
      await page.waitForFunction(()=>document.querySelectorAll('#capturedRed .mini-piece').length===2);
      await page.screenshot({path:path.join(__dirname,`../screenshots/polish-${width}x${height}.png`)});
      await page.locator('#onlineModeBtn').tap();
      assert.equal(await page.locator('#onlineModeBtn').getAttribute('aria-selected'),'true');
      assert.equal(await page.locator('#extraTools').getAttribute('open'),null);
      assert.equal(await page.locator('#advancedConnect').count(),0);
      assert.equal(await page.locator('#directCreateBtn').isVisible(),true);
      assert.equal(await page.locator('#findMatchBtn, #createRoomBtn, #joinRoomBtn, #serverUrl').count(),0);
      if(width===390) await page.screenshot({path:path.join(__dirname,'../screenshots/online-1.5.5.png')});
      await context.close();
    }
    const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'}); await context.addInitScript(state=>localStorage.setItem('strange-chess-offline-v1',JSON.stringify({state})),fixture());
    const page=await context.newPage(); await page.goto(server.url); await page.locator('.cell[data-x="0"][data-y="6"]').click(); await page.locator('.cell[data-x="0"][data-y="5"]').click();
    assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.cell[data-x="0"][data-y="5"] .piece')).animationName),'none');
    await context.close();
    const hostContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    const guestContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    await localIce(hostContext); await localIce(guestContext);
    const host=await hostContext.newPage(); await host.goto(server.url); await directFixture(host, fixture());
    const guest=await guestContext.newPage(); await guest.goto(server.url);
    await pair(host,guest);
    assert.equal(server.manager.rooms.size,0);
    await host.locator('.cell[data-x="0"][data-y="6"]').click(); await host.locator('.cell[data-x="0"][data-y="5"]').click();
    await guest.waitForFunction(()=>document.querySelector('#moveNumber').textContent.includes('第 1 手'));
    await guest.locator('.cell[data-x="0"][data-y="5"]').click(); await guest.locator('.cell[data-x="0"][data-y="9"]').click();
    for(const p of [host,guest]) {
      await p.waitForFunction(()=>document.querySelectorAll('#capturedRed .mini-piece').length===2);
      assert.equal(await p.locator('#capturedBlack .mini-piece').count(),1);
      assert.equal(await p.locator('#capturedRed').isVisible(),true);
    }
    await hostContext.close(); await guestContext.close();
  } finally {await browser.close();await server.close();}
});
