'use strict';

// The same implementation runs under Node (verification) and Bare Kit (Android).
const Hyperswarm = require('hyperswarm');
const DHT = require('hyperdht');
const crypto = require('hypercore-crypto');
const b4a = require('b4a');
const { EventEmitter } = require('bare-events');

const PROTOCOL = 'strange-chess/dht-match/1';
const TOPIC = crypto.hash(b4a.from(PROTOCOL + '/concealed-rules-v1'));
const MAX_FRAME = 65536;
const hex = bytes => b4a.toString(bytes, 'hex');
const nonce = () => hex(crypto.randomBytes(16));

class Matchmaker extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.topic = options.topic || TOPIC;
    this.connections = new Set();
    this.reservation = null;
    this.pair = null;
    this.active = null;
    this.closed = false;
    this.sent = 0;
    this.received = 0;
    this.pending = new Map();
  }

  event(type, values = {}) { if (!this.closed) this.emit('event', { type, ...values }); }

  start() {
    if (this.swarm || this.closed) throw new Error('匹配已经启动或取消');
    const dht = new DHT(this.options.dht || {});
    this.swarm = new Hyperswarm({ dht, maxPeers: 8, keyPair: this.options.keyPair });
    this.id = hex(this.swarm.keyPair.publicKey);
    this.swarm.on('error', error => this.event('notice', { message: error.message }));
    this.swarm.on('connection', socket => this.attach(socket));
    this.discovery = this.swarm.join(this.topic, { server: true, client: true, limit: 8 });
    this.discovery.flushed().catch(error => this.event('notice', { message: error.message }));
    this.nextDiscovery = Date.now() + (this.options.discoveryInterval || 10000);
    this.timer = setInterval(() => this.tick(), this.options.heartbeatInterval || 4000);
    this.event('searching');
    return this;
  }

  write(peer, value) {
    if (this.closed || peer.socket.destroyed) return false;
    try {
      const raw = JSON.stringify(value);
      if (b4a.byteLength(raw) > MAX_FRAME) throw new Error('联机消息过大');
      peer.socket.write(raw + '\n');
      return true;
    } catch { peer.socket.destroy(); return false; }
  }

  attach(socket) {
    const remote = hex(socket.remotePublicKey);
    if (this.closed || remote === this.id || (this.options.allowedPeer && remote !== this.options.allowedPeer) || (this.pair && remote !== this.pair.peer)) { socket.destroy(); return; }
    const peer = { socket, id: remote, buffer: b4a.alloc(0), hello: false, lastReply: Date.now(), challenges: new Set(), created: Date.now() };
    this.connections.add(peer);
    socket.on('error', () => {});
    socket.on('data', chunk => {
      try {
        peer.buffer = b4a.concat([peer.buffer, chunk]);
        let end;
        while ((end = peer.buffer.indexOf(10)) >= 0) {
          if (end > MAX_FRAME) throw new Error('oversize frame');
          const raw = b4a.toString(peer.buffer.subarray(0, end));
          peer.buffer = peer.buffer.subarray(end + 1);
          this.receive(peer, JSON.parse(raw));
          if (socket.destroyed || this.closed) break;
        }
        if (peer.buffer.length > MAX_FRAME) throw new Error('oversize frame');
      } catch { socket.destroy(); }
    });
    socket.on('close', () => {
      this.connections.delete(peer);
      // Keep the authenticated reservation until its deadline. If the final
      // handshake packet was lost, the same peer can finish it after reconnect.
      if (this.active === peer) {
        this.active = null;
        this.event('disconnected');
      }
      this.pump();
    });
    const reservedSession = this.reservation?.peer.id === remote ? this.reservation.session : '';
    this.write(peer, { kind: 'hello', protocol: PROTOCOL, session: this.pair?.session || reservedSession });
  }

  releaseReservation() {
    clearTimeout(this.reserveTimer);
    this.reservation = null;
  }

  reserve(peer, session) {
    this.reservation = { peer, session };
    this.reserveTimer = setTimeout(() => {
      if (!this.closed && this.reservation?.session === session) {
        this.releaseReservation();
        peer.cooldown = Date.now() + 300;
        this.pump();
      }
    }, this.options.reservationTimeout || 12000);
  }

  pump() {
    if (this.closed || this.pair || this.reservation) return;
    const candidates = [...this.connections].filter(peer => peer.hello && !peer.socket.destroyed && this.id < peer.id && !(peer.cooldown > Date.now()));
    // Candidate selection is local; the authenticated handshake prevents double matches.
    const peer = candidates[crypto.randomBytes(1)[0] % (candidates.length || 1)];
    if (!peer) return;
    const session = nonce();
    this.reserve(peer, session);
    this.write(peer, { kind: 'offer', session });
  }

  receive(peer, value) {
    if (!value || typeof value !== 'object' || typeof value.kind !== 'string') return;
    if (value.kind === 'hello') {
      if (peer.hello || value.protocol !== PROTOCOL) { peer.socket.destroy(); return; }
      peer.hello = true;
      if (this.pair) {
        if (peer.id !== this.pair.peer || value.session !== this.pair.session) { peer.socket.destroy(); return; }
        this.connected(peer, true);
      } else if (value.session) {
        if (this.reservation?.peer.id !== peer.id || this.reservation.session !== value.session) { peer.socket.destroy(); return; }
        this.pair = { peer: peer.id, session: value.session, host: this.id < peer.id };
        this.connected(peer, false);
      }
      else this.pump();
      return;
    }
    if (!peer.hello) { peer.socket.destroy(); return; }
    if (value.kind === 'offer') {
      if (this.pair || this.reservation || peer.id >= this.id || !/^[a-f0-9]{32}$/.test(value.session || '')) {
        this.write(peer, { kind: 'busy', session: value.session }); return;
      }
      this.reserve(peer, value.session);
      this.write(peer, { kind: 'accept', session: value.session }); return;
    }
    if (value.kind === 'busy') {
      if (this.reservation?.peer === peer && this.reservation.session === value.session) {
        this.releaseReservation(); peer.cooldown = Date.now() + 400 + crypto.randomBytes(1)[0]; this.pump();
      }
      return;
    }
    const reserved = this.reservation?.peer === peer && this.reservation.session === value.session;
    if (value.kind === 'accept' && reserved && this.id < peer.id) {
      this.write(peer, { kind: 'commit', session: value.session }); return;
    }
    if (value.kind === 'commit' && reserved && peer.id < this.id) {
      this.pair = { peer: peer.id, session: value.session, host: false };
      this.write(peer, { kind: 'ready', session: value.session });
      this.connected(peer, false); return;
    }
    if (value.kind === 'ready' && reserved && this.id < peer.id) {
      this.pair = { peer: peer.id, session: value.session, host: true };
      this.connected(peer, false); return;
    }
    if (this.active !== peer || !this.pair || value.session !== this.pair.session) return;
    if (value.kind === 'data') {
      if (!Number.isSafeInteger(value.seq) || value.seq < 1 || value.seq > this.received + 1) { peer.socket.destroy(); return; }
      if (value.seq === this.received + 1) {
        this.received = value.seq;
        this.event('data', { body: value.body });
      }
      this.write(peer, { kind: 'ack', session: this.pair.session, seq: value.seq });
    } else if (value.kind === 'ack' && Number.isSafeInteger(value.seq)) {
      this.pending.delete(value.seq);
    } else if (value.kind === 'ping' && /^[a-f0-9]{32}$/.test(value.nonce || '')) {
      this.write(peer, { kind: 'pong', session: this.pair.session, nonce: value.nonce });
    } else if (value.kind === 'pong' && peer.challenges.delete(value.nonce)) {
      peer.lastReply = Date.now();
    } else if (value.kind === 'leave') {
      this.event('left');
      void this.close();
    }
  }

  connected(peer, reconnected) {
    if (this.active && this.active !== peer) { this.active.socket.destroy(); }
    this.releaseReservation();
    this.active = peer;
    peer.lastReply = Date.now();
    if (!reconnected) {
      void this.swarm.leave(this.topic).catch(() => {});
      this.swarm.joinPeer(b4a.from(this.pair.peer, 'hex'));
      for (const other of this.connections) if (other !== peer) other.socket.destroy();
    }
    this.event(reconnected ? 'reconnected' : 'paired', { ...this.pair });
    for (const value of this.pending.values()) this.write(peer, value);
  }

  send(body) {
    if (!this.pair || this.closed) throw new Error('连接暂不可用');
    if (this.pending.size >= 32) throw new Error('等待对方确认，暂时不能继续发送');
    const value = { kind: 'data', session: this.pair.session, seq: this.sent + 1, body };
    if (b4a.byteLength(JSON.stringify(value)) > MAX_FRAME) throw new Error('联机消息过大');
    this.sent++;
    this.pending.set(value.seq, value);
    // Java/WebView may observe the close a little later than the native socket.
    // Accept this bounded send and replay it to the locked peer after reconnect.
    if (this.active) this.write(this.active, value);
  }

  tick() {
    if (this.closed) return;
    const now = Date.now();
    // Hyperswarm's default topic refresh is measured in minutes. A live waiting
    // room must query again when two phones announce at nearly the same time.
    if (!this.pair && !this.refreshing && now >= this.nextDiscovery) {
      this.refreshing = true;
      this.nextDiscovery = now + (this.options.discoveryInterval || 10000) + crypto.randomBytes(1)[0] * 10;
      this.discovery.refresh().catch(error => this.event('notice', { message: error.message })).finally(() => { this.refreshing = false; });
    }
    for (const peer of this.connections) {
      if (!peer.hello && now - peer.created > 15000) peer.socket.destroy();
    }
    const peer = this.active;
    if (!peer) { this.pump(); return; }
    if (now - peer.lastReply > (this.options.peerTimeout || 16000)) { peer.socket.destroy(); return; }
    const challenge = nonce(); peer.challenges.add(challenge);
    while (peer.challenges.size > 4) peer.challenges.delete(peer.challenges.values().next().value);
    this.write(peer, { kind: 'ping', session: this.pair.session, nonce: challenge });
    for (const value of this.pending.values()) this.write(peer, value);
  }

  close() {
    if (!this.closing) this.closing = this.closeOnce();
    return this.closing;
  }

  async closeOnce() {
    if (this.closed) return;
    if (this.active && this.pair) this.write(this.active, { kind: 'leave', session: this.pair.session });
    this.closed = true;
    clearInterval(this.timer); this.releaseReservation();
    this.pending.clear();
    for (const peer of this.connections) peer.socket.destroy();
    this.connections.clear();
    if (this.swarm) await this.swarm.destroy();
  }
}

module.exports = { Matchmaker, PROTOCOL, TOPIC, MAX_FRAME };
