(function (root) {
  'use strict';
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  const BROKERS = Object.freeze(['wss://broker.emqx.io:8084/mqtt', 'wss://test.mosquitto.org:8081/mqtt']);
  function concat(...arrays) { const out = new Uint8Array(arrays.reduce((n,a) => n + a.length, 0)); let at = 0; for (const a of arrays) { out.set(a,at); at += a.length; } return out; }
  function string(value) { const bytes = encoder.encode(value); return concat(Uint8Array.of(bytes.length >> 8, bytes.length & 255), bytes); }
  function packet(header, body) { const size = []; let n = body.length; do { let digit = n % 128; n = Math.floor(n / 128); if (n) digit |= 128; size.push(digit); } while (n); return concat(Uint8Array.of(header, ...size), body); }
  function newKey() { const bytes = crypto.getRandomValues(new Uint8Array(32)); return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
  function keyBytes(value) { if (!/^[A-Za-z0-9_-]{43}$/.test(value || '')) throw new Error('中继邀请密钥无效'); return Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/') + '='), c => c.charCodeAt(0)); }
  class Channel extends EventTarget {
    constructor(id, key, host, options = {}) {
      super(); this.id = id; this.host = host; this.options = options; this.closed = false;
      this.sender = host ? 'host' : 'guest'; this.other = host ? 'guest' : 'host';
      this.inTopic = 'strange-chess/secure-v1/' + id + '/' + this.sender;
      this.outTopic = 'strange-chess/secure-v1/' + id + '/' + this.other;
      this.key = crypto.subtle.importKey('raw', keyBytes(key), 'AES-GCM', false, ['encrypt','decrypt']);
      this.sockets = new Set(); this.allSockets = new Set(); this.sequence = 0; this.received = 0;
      this.unconfirmed = new Map(); this.incoming = new Map();
      this.sendQueue = Promise.resolve(); this.receiveQueue = Promise.resolve();
      this.slots = []; this.aborters = new Map(); this.challenges = new Map();
      this.peerConnected = false; this.lastPeerAt = 0; this.lastProbeAt = 0;
      this.wake = () => {
        if (root.document?.hidden || this.closed) return;
        for (const slot of this.slots) if (!slot.socket) { clearTimeout(slot.retry); slot.retry = null; slot.attempt = 0; this.dial(slot); }
        this.probe();
      };
    }
    open() {
      if (this.ready) return this.ready;
      if (this.closed) return Promise.reject(new Error('加密连接已关闭'));
      const urls = [...new Set(this.options.urls || BROKERS)];
      if (!urls.length) return Promise.reject(new Error('没有可用中继地址'));
      this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
      this.slots = urls.map(url => ({ url, socket: null, attempt: 0, retry: null }));
      for (const slot of this.slots) this.dial(slot);
      root.addEventListener?.('online', this.wake);
      root.addEventListener?.('pageshow', this.wake);
      root.addEventListener?.('strangechessresume', this.wake);
      root.document?.addEventListener('visibilitychange', this.wake);
      this.retry = setInterval(() => {
        if (this.closed) return;
        if (this.sockets.size && this.lastPeerAt && Date.now() - this.lastPeerAt > (this.options.peerTimeout ?? 25000)) this.peerState(false);
        if (Date.now() - this.lastProbeAt >= (this.options.heartbeatInterval ?? 5000)) this.probe();
        // A missing ACK is a recoverable network interruption, not an end to the
        // match. Keep the encrypted sequence until the same peer acknowledges it.
        for (const item of this.unconfirmed.values()) this.publish(item.bytes);
      }, this.options.retryInterval ?? 1000);
      return this.ready;
    }
    peerState(connected) {
      this.peerConnected = connected;
      const detail = connected ? 'connected' : 'reconnecting';
      if (this.reportedState === detail) return;
      this.reportedState = detail;
      this.dispatchEvent(new CustomEvent('state', { detail }));
    }
    schedule(slot) {
      if (this.closed || slot.retry || slot.socket) return;
      const base = Math.min(this.options.reconnectMax ?? 15000, (this.options.reconnectBase ?? 1000) * 2 ** Math.min(slot.attempt++, 8));
      const delay = base + root.SystemRandom.integer(Math.max(1, Math.ceil(base / 5)));
      slot.retry = setTimeout(() => { slot.retry = null; this.dial(slot); }, delay);
    }
    dial(slot) {
      if (this.closed || slot.socket) return;
      this.connect(slot).then(() => {
        if (this.closed) return;
        slot.attempt = 0; this.resolveReady(); this.dispatchEvent(new Event('open'));
        for (const item of this.unconfirmed.values()) this.publish(item.bytes);
        void this.control({ ack: this.received }); this.probe();
      }).catch(() => this.schedule(slot));
    }
    probe() {
      if (this.closed || !this.sockets.size) return;
      const nonce = root.SystemRandom.id(20); this.lastProbeAt = Date.now();
      this.challenges.set(nonce, this.lastProbeAt);
      while (this.challenges.size > 4) this.challenges.delete(this.challenges.keys().next().value);
      void this.control({ ping: nonce });
    }
    async control(value) {
      try { const bytes = await this.encrypt(value); if (!this.closed) this.publish(bytes); } catch { /* A reconnect will send a fresh probe/ACK. */ }
    }
    connect(slot) {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(slot.url, ['mqtt']); ws.binaryType = 'arraybuffer'; this.allSockets.add(ws); slot.socket = ws;
        let buffer = new Uint8Array(), subscribed = false, complete = false, disposed = false, lastPong = Date.now();
        const fail = () => { if (!complete) { complete = true; reject(new Error('中继连接失败')); } };
        let ping;
        const retire = () => {
          if (disposed) return; disposed = true;
          clearTimeout(timer); clearInterval(ping); this.sockets.delete(ws); this.allSockets.delete(ws); this.aborters.delete(ws);
          if (slot.socket === ws) slot.socket = null;
          fail();
          if (!this.sockets.size) { this.lastPeerAt = 0; this.peerState(false); }
          this.schedule(slot);
        };
        const abort = () => { retire(); try { ws.close(); } catch {} };
        const timer = setTimeout(abort, this.options.timeout ?? 9000);
        this.aborters.set(ws, abort);
        ws.addEventListener('open', () => {
          if (this.closed || disposed) { abort(); return; }
          ws.send(packet(0x10, concat(string('MQTT'), Uint8Array.of(4, 2, 0, 30), string('sc_' + root.SystemRandom.id(20)))));
        });
        ws.addEventListener('message', event => {
          if (this.closed || disposed || !(event.data instanceof ArrayBuffer)) return;
          buffer = concat(buffer, new Uint8Array(event.data));
          if (buffer.length > 131072) { abort(); return; }
          while (buffer.length >= 2) {
            let size = 0, factor = 1, at = 1, digit;
            do { if (at >= buffer.length) return; digit = buffer[at++]; size += (digit & 127) * factor; factor *= 128; if (at > 5 || size > 131072) { abort(); return; } } while (digit & 128);
            if (buffer.length < at + size) return;
            const header = buffer[0], body = buffer.slice(at, at + size); buffer = buffer.slice(at + size);
            const type = header >> 4;
            if (type === 2) {
              if (body.length !== 2 || body[1] !== 0) { abort(); return; }
              ws.send(packet(0x82, concat(Uint8Array.of(0,1), string(this.inTopic), Uint8Array.of(0))));
            } else if (type === 9) {
              if (body.length < 3 || body[0] !== 0 || body[1] !== 1 || body[2] >= 128) { abort(); return; }
              if (!subscribed) {
                subscribed = true; complete = true; clearTimeout(timer); this.sockets.add(ws);
                lastPong = Date.now(); if (!this.lastPeerAt) this.lastPeerAt = lastPong;
                ping = setInterval(() => {
                  if (Date.now() - lastPong > (this.options.pongTimeout ?? 25000)) { abort(); return; }
                  try { if (ws.readyState === 1) ws.send(Uint8Array.of(0xc0,0)); } catch { abort(); }
                }, this.options.pingInterval ?? 10000);
                resolve(ws);
              }
            } else if (type === 13 && body.length === 0) {
              lastPong = Date.now();
            } else if (type === 3 && subscribed && !(header & 1)) {
              if (body.length < 2) continue;
              const length = (body[0] << 8) | body[1];
              if (body.length < length + 2 || decoder.decode(body.slice(2, length + 2)) !== this.inTopic) continue;
              let start = length + 2;
              const qos = (header >> 1) & 3;
              if (qos) { if (body.length < start + 2) continue; const ack = body.slice(start,start+2); start += 2; if (qos === 1) ws.send(packet(0x40,ack)); else continue; }
              const encrypted = body.slice(start);
              this.receiveQueue = this.receiveQueue.then(() => this.decrypt(encrypted)).catch(() => {});
            }
          }
        });
        ws.addEventListener('error', abort);
        ws.addEventListener('close', retire);
      });
    }
    send(message) {
      this.sendQueue = this.sendQueue.catch(() => {}).then(async () => {
        await this.open(); if (this.closed) throw new Error('加密连接已关闭');
        if (this.unconfirmed.size >= 128) throw new Error('消息正在恢复中，请稍后再试');
        const sequence = this.sequence + 1;
        const bytes = await this.encrypt({ sequence, message });
        this.sequence = sequence; this.unconfirmed.set(sequence, { bytes }); this.publish(bytes);
      });
      return this.sendQueue;
    }
    publish(bytes) {
      for (const ws of this.sockets) if (ws.readyState === 1) {
        try { ws.send(bytes); } catch { this.aborters.get(ws)?.(); }
      }
    }
    async encrypt(value) {
      const plain = encoder.encode(JSON.stringify({ v: 1, sender: this.sender, ...value }));
      if (plain.length > 65536) throw new Error('中继消息过长');
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(this.id + ':' + this.sender) }, await this.key, plain));
      return packet(0x30, concat(string(this.outTopic), Uint8Array.of(1), iv, encrypted));
    }
    async decrypt(payload) {
      if (this.closed || payload.length < 30 || payload.length > 65600 || payload[0] !== 1) return;
      const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: payload.slice(1,13), additionalData: encoder.encode(this.id + ':' + this.other) }, await this.key, payload.slice(13));
      if (this.closed) return;
      const value = JSON.parse(decoder.decode(data));
      if (value.v !== 1 || value.sender !== this.other) return;
      if (typeof value.ping === 'string' && /^[A-Za-z0-9_-]{20}$/.test(value.ping)) { void this.control({ pong: value.ping }); return; }
      if (typeof value.pong === 'string') {
        const sentAt = this.challenges.get(value.pong);
        if (sentAt !== undefined && Date.now() - sentAt <= (this.options.peerTimeout ?? 25000) && this.sockets.size) {
          this.challenges.delete(value.pong); this.lastPeerAt = Date.now(); this.peerState(true);
        }
        return;
      }
      if (Number.isSafeInteger(value.ack) && value.ack >= 0 && value.ack <= this.sequence) {
        for (const sequence of this.unconfirmed.keys()) if (sequence <= value.ack) this.unconfirmed.delete(sequence);
        return;
      }
      if (!Number.isSafeInteger(value.sequence) || value.sequence < 1 || value.sequence > this.received + 128 || !value.message || typeof value.message !== 'object') return;
      if (value.sequence > this.received) this.incoming.set(value.sequence, value.message);
      while (this.incoming.has(this.received + 1)) {
        const message = this.incoming.get(++this.received); this.incoming.delete(this.received);
        this.dispatchEvent(new MessageEvent('message', { data: message }));
      }
      await this.control({ ack: this.received });
    }
    close() {
      if (this.closed) return; this.closed = true; clearInterval(this.retry); this.rejectReady?.(new Error('加密连接已关闭'));
      root.removeEventListener?.('online', this.wake); root.removeEventListener?.('pageshow', this.wake); root.removeEventListener?.('strangechessresume', this.wake);
      root.document?.removeEventListener('visibilitychange', this.wake);
      for (const slot of this.slots) clearTimeout(slot.retry);
      for (const ws of this.allSockets) { try { ws.close(); } catch {} }
      this.sockets.clear(); this.allSockets.clear(); this.aborters.clear(); this.unconfirmed.clear(); this.incoming.clear(); this.challenges.clear();
    }
  }
  root.StrangeChessRelay = Object.freeze({ Channel, newKey, validKey: value => /^[A-Za-z0-9_-]{43}$/.test(value || '') });
})(globalThis);
