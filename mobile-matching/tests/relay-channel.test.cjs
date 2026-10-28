'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');
const { chromium } = require('playwright-core');
const { startChessServer } = require('../server/server.cjs');
const { pair } = require('./helpers/direct.cjs');

function packet(header, body) {
  const digits = []; let n = body.length;
  do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; digits.push(b); } while (n);
  return Buffer.concat([Buffer.from([header,...digits]),body]);
}
async function broker() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => wss.once('listening',resolve));
  const subscriptions = new Map(), published = [];
  wss.on('connection', ws => {
    ws.on('message', data => {
      const bytes = Buffer.from(data); let size = 0, at = 1, factor = 1, digit;
      do { digit = bytes[at++]; size += (digit & 127) * factor; factor *= 128; } while (digit & 128);
      const body = bytes.subarray(at,at+size), type = bytes[0] >> 4;
      if (type === 1) ws.send(Buffer.from([0x20,2,0,0]));
      if (type === 8) {
        const length = body.readUInt16BE(2), topic = body.subarray(4,4+length).toString(); subscriptions.set(ws,topic);
        ws.send(Buffer.from([0x90,3,body[0],body[1],0]));
      }
      if (type === 3) {
        assert.equal(bytes[0] & 1,0,'encrypted game messages must not be retained');
        published.push(bytes);
        const length = body.readUInt16BE(0), topic = body.subarray(2,2+length).toString();
        for (const [target, subscription] of subscriptions) if (subscription === topic && target.readyState === 1) {
          // An untrusted broker can tamper, duplicate and fragment packets. None
          // of those must let it forge commands or apply the same move twice.
          const corrupted = Buffer.from(body); corrupted[corrupted.length-1] ^= 1;
          target.send(packet(0x30,corrupted));
          target.send(bytes.subarray(0,3)); target.send(bytes.subarray(3)); target.send(bytes);
        }
      }
      if (type === 12) ws.send(Buffer.from([0xd0,0]));
    });
    ws.on('close', () => subscriptions.delete(ws));
  });
  return { url: 'ws://127.0.0.1:' + wss.address().port, published,
    async close() { for (const ws of wss.clients) ws.terminate(); await new Promise(resolve => wss.close(resolve)); } };
}

test('blocked direct ICE falls back to authenticated encrypted relay and rejects broker tampering, replay and wrong keys', { timeout: 40000 }, async () => {
  const mqtt = await broker(), server = await startChessServer({host:'127.0.0.1',port:0,quiet:true});
  const browser = await chromium.launch({channel:'msedge',headless:true}); const contexts = [], errors = [];
  async function open() {
    const context = await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true}); contexts.push(context);
    await context.addInitScript(() => {
      const Native = RTCPeerConnection;
      window.RTCPeerConnection = class extends Native {
        constructor(options) { super({...options,iceServers:[]}); }
        setRemoteDescription(value) { return super.setRemoteDescription({...value,sdp:value.sdp.replace(/^a=candidate:(\S+ \d+ \S+ \d+) \S+ \d+/gm,'a=candidate:$1 192.0.2.1 9')}); }
      };
    });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); await page.goto(server.url);
    await page.evaluate(url => { const Native = StrangeChessDirect.Link; StrangeChessDirect.Link = class extends Native { constructor(options={}) { super({...options,relayUrls:[url],fallbackDelay:100}); } }; },mqtt.url);
    return page;
  }
  try {
    const host = await open(), guest = await open(); await pair(host,guest);
    for (const page of [host,guest]) assert.match(await page.locator('#shareUrl').textContent(),/加密中继/);
    await host.locator('.cell.is-selectable').first().tap(); await host.locator('.cell.is-legal').first().tap();
    for (const page of [host,guest]) await page.waitForFunction(() => document.querySelector('#moveNumber').textContent.includes('第 1 手'));
    await guest.locator('.cell.is-selectable').first().tap(); await guest.locator('.cell.is-legal').first().tap();
    for (const page of [host,guest]) await page.waitForFunction(() => document.querySelector('#moveNumber').textContent.includes('第 2 手'));
    await guest.locator('#quickUndoBtn').tap();
    await host.locator('#onlineRequestDialog').waitFor({ state: 'visible' });
    assert.equal(await host.locator('#onlineRequestTitle').textContent(), '对方申请悔棋');
    for (const page of [host, guest]) assert.equal(await page.locator('#moveNumber').textContent(), '第 2 手');
    await host.locator('#acceptOnlineRequestBtn').tap();
    for (const page of [host, guest]) await page.waitForFunction(() => document.querySelector('#moveNumber').textContent === '第 1 手');
    await guest.locator('.cell.is-selectable').first().tap(); await guest.locator('.cell.is-legal').first().tap();
    for (const page of [host, guest]) await page.waitForFunction(() => document.querySelector('#moveNumber').textContent === '第 2 手');
    await host.locator('#shuffleBtn').tap();
    await guest.locator('#onlineRequestDialog').waitFor({ state: 'visible' });
    assert.equal(await guest.locator('#onlineRequestTitle').textContent(), '对方申请新棋局');
    await guest.locator('#declineOnlineRequestBtn').tap();
    await host.waitForFunction(() => !document.querySelector('#shuffleBtn').disabled);
    for (const page of [host, guest]) assert.equal(await page.locator('#moveNumber').textContent(), '第 2 手');
    assert.equal(server.manager.rooms.size,0);
    assert.equal(Buffer.concat(mqtt.published).toString('utf8').includes('"pieces"'),false);
    await guest.locator('#onlineModeBtn').tap(); await guest.locator('#leaveRoomBtn').tap(); await host.waitForFunction(() => !window.mobileGame.hasRoom());
    const auth = await host.evaluate(async url => {
      const key = StrangeChessRelay.newKey(), other = StrangeChessRelay.newKey();
      const a = new StrangeChessRelay.Channel('wrong-key-auth-check-123',key,true,{urls:[url]});
      const b = new StrangeChessRelay.Channel('wrong-key-auth-check-123',other,false,{urls:[url]});
      let delivered = 0; b.addEventListener('message',()=>delivered++);
      await Promise.all([a.open(),b.open()]); await a.send({type:'private-check'});
      await new Promise(resolve => setTimeout(resolve,200)); a.close(); b.close(); return delivered;
    },mqtt.url);
    assert.equal(auth,0,'a different invitation key must not decrypt or authenticate a message'); assert.deepEqual(errors,[]);
  } finally { await Promise.all(contexts.map(c=>c.close())); await browser.close(); await server.close(); await mqtt.close(); }
});
