'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { chromium } = require('playwright-core');
const { browserRoom } = require('../server/browser-room.cjs');
const { startChessServer } = require('../server/server.cjs');
const { faultBroker } = require('./helpers/fault-broker.cjs');

function runtime() {
  class PendingIce extends EventTarget {
    constructor() { super(); this.iceGatheringState = 'gathering'; this.added = []; }
    createDataChannel() { return Object.assign(new EventTarget(), { close() {} }); }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' }; }
    async createAnswer() { return { type: 'answer', sdp: 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' }; }
    async setLocalDescription(value) { this.localDescription = value; }
    async setRemoteDescription(value) { this.remoteDescription = value; }
    async addIceCandidate(value) { this.added.push(value.candidate); }
    close() {}
  }
  const root = vm.createContext({ EventTarget, Event, MessageEvent, CustomEvent, TextEncoder, TextDecoder, btoa, atob,
    crypto: webcrypto, setTimeout, clearTimeout, setInterval, clearInterval, RTCPeerConnection: PendingIce });
  for (const file of ['src/game-engine.js', 'src/system-random.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), root);
  vm.runInContext(browserRoom(), root);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/peer-link.js'), 'utf8'), root);
  return root;
}

test('incremental ICE offers and answers finish while gathering is still pending, including candidates arriving before SDP', { timeout: 2000 }, async () => {
  const root = runtime(), options = { trickleIce: true, gatherTimeout: 10000 };
  const host = new root.StrangeChessDirect.Link({ ...options }), guest = new root.StrangeChessDirect.Link({ ...options });
  try {
    const candidate = { candidate: 'candidate:1 1 UDP 2122260223 127.0.0.1 12345 typ host', sdpMid: '0', sdpMLineIndex: 0 };
    await guest.addRemoteCandidate(candidate);
    assert.equal(guest.remoteCandidates.length, 1);
    const offer = await host.offer(), answer = await guest.accept(offer);
    assert.equal(host.pc.iceGatheringState, 'gathering'); assert.equal(guest.pc.iceGatheringState, 'gathering');
    assert.deepEqual(Array.from(guest.pc.added), [candidate.candidate]);
    await host.accept(answer);
    await host.addRemoteCandidate(candidate); assert.deepEqual(Array.from(host.pc.added), [candidate.candidate]);
    await host.addRemoteCandidate({ candidate: 'bad' }); assert.equal(host.pc.added.length, 1);
    assert.equal(guest.remoteCandidates.length, 0);
  } finally { host.close(); guest.close(); }
});

test('the host queues the public snapshot to the peer before running its own rendering listener', () => {
  const root = runtime(), link = new root.StrangeChessDirect.Link();
  link.room = new root.StrangeChessRooms.GameRoom('ABCDEF'); link.room.addPlayer('host'); link.room.addPlayer('guest');
  const order = [];
  link.remote = value => { order.push('remote'); assert.ok(value.state.pieces.every(p => !Object.hasOwn(p, 'kind'))); };
  link.addEventListener('message', () => order.push('render'));
  link.broadcast(); assert.deepEqual(order, ['remote', 'render']); link.close();
});

test('random matching connects real RTC peers without waiting for the 10-second ICE collection deadline', { timeout: 20000 }, async () => {
  const broker = await faultBroker(), server = await startChessServer({ host: '127.0.0.1', port: 0, quiet: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const errors = [];
  async function open() {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await context.addInitScript(() => {
      const Native = RTCPeerConnection;
      window.RTCPeerConnection = class extends Native {
        constructor(options) { super({ ...options, iceServers: [] }); }
        get iceGatheringState() { return 'gathering'; }
      };
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto(server.url);
    await page.evaluate(url => {
      const Direct = StrangeChessDirect.Link, Native = StrangeChessRandom.Link;
      const gather = Direct.prototype.gather;
      window.gatherCalls = 0;
      Direct.prototype.gather = function () { gatherCalls++; return gather.call(this); };
      window.StrangeChessRandom = { ...StrangeChessRandom, Link: class extends Native {
        constructor(options = {}) {
          super({ ...options, discoveryUrls: [url], relayUrls: [url], electionDelay: 50, electionSettle: 150, matchInterval: 100, fallbackDelay: 5000 });
          window.link = this; window.connectionTiming = {};
          this.addEventListener('matchstatus', event => { if (event.detail.phase === 'introducing') connectionTiming.start = performance.now(); });
          this.addEventListener('state', event => { if (event.detail === 'connected') connectionTiming.end = performance.now(); });
        }
      } };
    }, broker.url);
    return page;
  }
  try {
    const a = await open(), b = await open();
    for (const page of [a, b]) { await page.locator('#onlineModeBtn').tap(); await page.locator('#randomMatchBtn').tap(); }
    const timing = [];
    for (const page of [a, b]) {
      await page.waitForFunction(() => mobileGame.hasRoom() && link.started, null, { timeout: 6000 });
      assert.equal(await page.evaluate(() => link.transport), 'rtc');
      assert.equal(await page.evaluate(() => gatherCalls), 0);
      assert.equal(await page.evaluate(() => link.options.trickleIce), true);
      const ms = await page.evaluate(() => connectionTiming.end - connectionTiming.start);
      assert.ok(ms >= 0 && ms < 6000, 'connection introduction took ' + ms + 'ms'); timing.push(Math.round(ms));
    }
    console.log('Local incremental ICE introduction (ms): ' + timing.join(', '));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); await broker.close(); }
});
