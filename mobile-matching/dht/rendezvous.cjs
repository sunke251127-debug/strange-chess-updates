'use strict';

const Hyperswarm = require('hyperswarm');
const DHT = require('hyperdht');
const crypto = require('hypercore-crypto');
const b4a = require('b4a');
const { EventEmitter } = require('bare-events');
const { Matchmaker, MAX_FRAME } = require('./matchmaker.cjs');
const { IntroductionQueue, keyOK, requestOK } = require('./introduction-queue.cjs');

// This permanent logical address is resolved by the public DHT. It is not a
// purchased DNS domain, a reserved public IP, or a promise of public availability.
const SERVICE = 'strange-chess/player-rendezvous/1/concealed-rules-v1';
const TOPIC = crypto.hash(b4a.from(SERVICE));
const hex = bytes => b4a.toString(bytes, 'hex');
const nonce = () => hex(crypto.randomBytes(16));
const rank = (a, b) => a.since - b.since || (a.id < b.id ? -1 : a.id === b.id ? 0 : 1);

class Rendezvous extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.topic = options.topic || TOPIC;
    this.gameKeys = DHT.keyPair();
    this.request = nonce();
    this.waiting = options.coordinatorOnly !== true;
    this.connections = new Set();
    this.queue = new IntroductionQueue({ capacity: options.capacity ?? 100, ttl: options.ticketTimeout ?? 45000 });
    this.isCoordinator = false;
    this.leader = null;
    this.game = null;
    this.ticket = null;
    this.pair = null;
    this.closed = false;
    this.lobbyClosed = false;
    this.refreshing = false;
  }

  event(type, values = {}) { if (!this.closed) this.emit('event', { type, ...values }); }
  get active() { return this.game?.active || null; }
  get pending() { return this.game?.pending || new Map(); }

  start() {
    if (this.swarm || this.closed) throw new Error('匹配已经启动或取消');
    this.swarm = new Hyperswarm({ dht: new DHT(this.options.dht || {}), maxPeers: this.queue.capacity + 12 });
    this.id = hex(this.swarm.keyPair.publicKey);
    this.swarm.on('error', error => this.event('notice', { message: error.message }));
    this.swarm.on('connection', socket => this.attach(socket));
    this.discovery = this.swarm.join(this.topic, { client: true, server: false, limit: 4 });
    this.electionAt = Date.now() + (this.options.electionDelay ?? 2200) + crypto.randomBytes(1)[0];
    this.nextDiscovery = Date.now() + (this.options.discoveryInterval ?? 5000);
    this.timer = setInterval(() => this.tick(), this.options.heartbeatInterval ?? 2000);
    this.event('searching');
    return this;
  }

  descriptor() { return { id: this.id, since: this.since, server: this.isCoordinator }; }
  peer(id) { return [...this.connections].find(peer => peer.id === id && peer.hello && !peer.socket.destroyed); }

  write(peer, value) {
    if (this.closed || this.lobbyClosed || !peer || peer.socket.destroyed) return false;
    try {
      const raw = JSON.stringify(value);
      if (b4a.byteLength(raw) > MAX_FRAME) return false;
      peer.socket.write(raw + '\n'); return true;
    } catch { peer.socket.destroy(); return false; }
  }

  attach(socket) {
    if (this.closed || this.lobbyClosed) { socket.destroy(); return; }
    const id = hex(socket.remotePublicKey);
    if (!keyOK(id) || id === this.id) { socket.destroy(); return; }
    const peer = { socket, id, hello: false, buffer: b4a.alloc(0), lastReply: Date.now(), challenges: new Set(), server: false };
    this.connections.add(peer);
    socket.on('error', () => {});
    socket.on('data', chunk => {
      try {
        peer.buffer = b4a.concat([peer.buffer, chunk]);
        let end;
        while ((end = peer.buffer.indexOf(10)) >= 0) {
          if (end > MAX_FRAME) throw new Error('oversize introduction');
          const raw = peer.buffer.subarray(0, end); peer.buffer = peer.buffer.subarray(end + 1);
          this.receive(peer, JSON.parse(b4a.toString(raw)));
          if (socket.destroyed || this.lobbyClosed) break;
        }
        if (peer.buffer.length > MAX_FRAME) throw new Error('oversize introduction');
      } catch { socket.destroy(); }
    });
    socket.on('close', () => {
      this.connections.delete(peer);
      // A dead waiting socket must not remain available as an opponent. An
      // established game owns a completely different DHT and Noise socket.
      const queued = this.isCoordinator && this.queue.players.get(peer.id);
      if (queued) for (const ticket of this.queue.cancel(peer.id, queued.request)) this.retryTicket(ticket);
      if (this.leader === id) { this.leader = null; this.electionAt = Date.now() + (this.options.electionDelay ?? 2200) + crypto.randomBytes(1)[0]; }
      if (!this.lobbyClosed) this.selectLeader();
    });
    this.write(peer, { kind: 'hello', service: SERVICE, ...this.descriptor() });
  }

  receive(peer, value) {
    if (this.closed || this.lobbyClosed || !value || typeof value.kind !== 'string') return;
    if (value.kind === 'hello') {
      if (peer.hello || value.service !== SERVICE || value.id !== peer.id) { peer.socket.destroy(); return; }
      peer.hello = true; this.readRole(peer, value); this.selectLeader(); return;
    }
    if (!peer.hello) { peer.socket.destroy(); return; }
    if (value.kind === 'role') { this.readRole(peer, value); this.selectLeader(); return; }
    if (value.kind === 'ping' && requestOK(value.nonce)) { this.write(peer, { kind: 'pong', nonce: value.nonce }); return; }
    if (value.kind === 'pong' && peer.challenges.delete(value.nonce)) { peer.lastReply = Date.now(); return; }
    if (value.kind === 'redirect' && keyOK(value.id) && value.id !== this.id) {
      // A referral is only a hint. The new peer must authenticate its own key
      // and announce its role before it can receive a matching request.
      this.swarm.joinPeer(b4a.from(value.id, 'hex')); return;
    }
    if (value.kind === 'join' && this.isCoordinator) {
      const result = this.queue.join(peer.id, value.request, value.gameKey);
      this.write(peer, { kind: 'queued', request: value.request, status: result.status });
      if (result.ticket) {
        const ticket = this.queue.tickets.get(result.ticket);
        if (ticket) this.write(peer, { kind: 'match', ticket: { ...this.queue.publicTicket(ticket), coordinator: this.id } });
      }
      this.pump(); return;
    }
    if (value.kind === 'connected' && this.isCoordinator) {
      if (this.queue.confirm(peer.id, value.request, value.ticket)) this.write(peer, { kind: 'released', ticket: value.ticket });
      return;
    }
    if (value.kind === 'cancel' && this.isCoordinator) {
      for (const ticket of this.queue.cancel(peer.id, value.request)) this.retryTicket(ticket);
      return;
    }
    if (value.kind === 'match' && peer.id === this.leader) { this.acceptTicket(value.ticket); return; }
    if (value.kind === 'retry' && peer.id === this.ticket?.coordinator && value.ticket === this.ticket.id) { this.retry(); return; }
    if (value.kind === 'released' && this.pair && value.ticket === this.ticket?.id && !this.isCoordinator) void this.stopLobby();
    if (value.kind === 'queued' && peer.id === this.leader && value.request === this.request && value.status === 'full') {
      this.deferFull();
    }
  }

  readRole(peer, value) {
    peer.server = value.server === true && Number.isSafeInteger(value.since) && value.since > 0 && value.since <= Date.now() + 60000;
    peer.since = peer.server ? value.since : Number.MAX_SAFE_INTEGER;
  }

  selectLeader() {
    if (this.closed || this.lobbyClosed) return;
    const candidates = [...this.connections].filter(peer => peer.hello && peer.server && !peer.socket.destroyed);
    if (this.isCoordinator) candidates.push({ id: this.id, since: this.since });
    candidates.sort(rank);
    const best = candidates[0];
    if (!best) { this.leader = null; return; }
    if (this.isCoordinator && best.id !== this.id) {
      this.isCoordinator = false;
      for (const peer of this.connections) {
        this.write(peer, { kind: 'redirect', id: best.id });
        this.write(peer, { kind: 'role', ...this.descriptor() });
      }
      this.queue.clear();
      this.refresh({ server: false, client: true });
    }
    if (this.leader !== best.id) {
      this.leader = best.id;
      this.event('coordinator', { id: best.id, self: best.id === this.id, service: SERVICE });
    }
    this.joinQueue();
  }

  promote() {
    if (this.isCoordinator || this.closed || this.lobbyClosed) return;
    this.isCoordinator = true; this.since = Date.now();
    this.readyAt = this.since + (this.options.electionSettle ?? 800);
    for (const peer of this.connections) this.write(peer, { kind: 'role', ...this.descriptor() });
    this.refresh({ server: true, client: true });
    this.event('hosting', { service: SERVICE });
    this.selectLeader();
  }

  joinQueue() {
    if (!this.waiting || this.ticket || !this.leader || this.lobbyClosed || Date.now() < (this.joinAfter || 0)) return;
    const gameKey = hex(this.gameKeys.publicKey);
    if (this.leader === this.id && this.isCoordinator) {
      const result = this.queue.join(this.id, this.request, gameKey);
      if (result.status === 'full') this.deferFull();
      else this.pump();
    } else this.write(this.peer(this.leader), { kind: 'join', request: this.request, gameKey });
  }

  // 100 is the number of unfinished introductions, not an online-player cap.
  // A full coordinator asks waiters to retry later instead of dropping them.
  deferFull() {
    const now = Date.now();
    this.joinAfter = now + (this.options.fullRetryDelay ?? 3000);
    if (now < (this.fullNoticeAt || 0)) return;
    this.fullNoticeAt = now + (this.options.fullNoticeInterval ?? 6000);
    this.event('notice', { message: '当前匹配节点的未完成建连名额已满，正在等待空位后重试。' });
  }

  deliver(id, value) {
    if (id === this.id) {
      if (value.kind === 'match') this.acceptTicket(value.ticket);
      else if (value.kind === 'retry' && value.ticket === this.ticket?.id) this.retry();
    } else this.write(this.peer(id), value);
  }

  pump() {
    if (!this.isCoordinator || Date.now() < this.readyAt) return;
    for (const ticket of this.queue.pair()) {
      const introduction = { ...ticket, coordinator: this.id };
      for (const player of ticket.players) this.deliver(player.id, { kind: 'match', ticket: introduction });
    }
  }

  acceptTicket(ticket) {
    if (!this.waiting || this.ticket || !ticket || !requestOK(ticket.id) || !keyOK(ticket.topic) || !Array.isArray(ticket.players) || ticket.players.length !== 2 || ticket.coordinator !== this.leader) return;
    if (!Number.isSafeInteger(ticket.expires) || ticket.expires <= Date.now() || ticket.expires > Date.now() + 180000) return;
    const own = ticket.players.find(player => player.id === this.id && player.request === this.request && player.gameKey === hex(this.gameKeys.publicKey));
    const other = ticket.players.find(player => player.id !== this.id);
    if (!own || !other || !keyOK(other.id) || !keyOK(other.gameKey) || !requestOK(other.request) || other.gameKey === own.gameKey) return;
    this.ticket = ticket;
    const game = new Matchmaker({ ...this.options, topic: b4a.from(ticket.topic, 'hex'), keyPair: this.gameKeys, allowedPeer: other.gameKey });
    this.game = game;
    game.on('event', event => {
      if (this.closed || this.game !== game) return;
      if (event.type === 'paired') {
        this.waiting = false; this.pair = game.pair; clearTimeout(this.ticketTimer);
        this.confirmIntroduction();
      }
      if (event.type !== 'searching') this.event(event.type, event);
    });
    game.start();
    this.ticketTimer = setTimeout(() => this.retry(), Math.max(1, ticket.expires - Date.now()));
    this.event('introducing');
  }

  confirmIntroduction() {
    if (!this.ticket || !this.pair) return;
    if (this.ticket.coordinator === this.id && this.isCoordinator) this.queue.confirm(this.id, this.request, this.ticket.id);
    else this.write(this.peer(this.ticket.coordinator), { kind: 'connected', request: this.request, ticket: this.ticket.id });
    if (!this.isCoordinator) {
      // The coordinator is not required to acknowledge a completed connection.
      // Its unreachable temporary record also expires independently.
      if (!this.releaseTimer) this.releaseTimer = setTimeout(() => { void this.stopLobby(); }, this.options.releaseDelay ?? 1200);
    }
  }

  retryTicket(ticket) {
    for (const player of ticket.players) this.deliver(player.id, { kind: 'retry', ticket: ticket.id });
  }

  retry() {
    if (this.closed || this.pair || this.game?.pair) return;
    const old = this.game; this.game = null; this.ticket = null;
    clearTimeout(this.ticketTimer);
    if (old) void old.close();
    this.request = nonce(); this.waiting = true;
    this.event('searching'); this.joinQueue();
  }

  refresh(configuration) {
    if (this.lobbyClosed) return;
    if (this.refreshing) { this.queuedRefresh = configuration; return; }
    this.refreshing = true;
    this.discovery.refresh(configuration).catch(error => this.event('notice', { message: error.message })).finally(() => {
      this.refreshing = false;
      if (this.queuedRefresh) { const next = this.queuedRefresh; this.queuedRefresh = null; this.refresh(next); }
    });
  }

  tick() {
    if (this.closed || this.lobbyClosed) return;
    const now = Date.now();
    for (const peer of this.connections) {
      if (now - peer.lastReply > (this.options.peerTimeout ?? 14000)) { peer.socket.destroy(); continue; }
      const challenge = nonce(); peer.challenges.add(challenge);
      while (peer.challenges.size > 4) peer.challenges.delete(peer.challenges.values().next().value);
      this.write(peer, { kind: 'ping', nonce: challenge });
    }
    this.selectLeader();
    if (!this.leader && now >= this.electionAt) this.promote();
    if (now >= this.nextDiscovery) {
      this.nextDiscovery = now + (this.options.discoveryInterval ?? 5000);
      this.refresh({ server: this.isCoordinator, client: true });
    }
    if (this.isCoordinator) {
      for (const ticket of this.queue.expire()) this.retryTicket(ticket);
      this.pump();
    }
    if (this.pair && this.ticket && !this.lobbyClosed) this.confirmIntroduction();
  }

  send(body) { if (!this.game || this.closed) throw new Error('连接暂不可用'); this.game.send(body); }

  async wake() {
    if (this.closed) return;
    if (!this.lobbyClosed) { await this.swarm.resume(); this.refresh({ server: this.isCoordinator, client: true }); }
    if (this.game) await this.game.swarm.resume();
  }

  async stopLobby() {
    if (this.lobbyClosing) return this.lobbyClosing;
    this.lobbyClosed = true;
    clearInterval(this.timer); clearTimeout(this.releaseTimer);
    this.queue.clear();
    this.lobbyClosing = this.swarm ? this.swarm.destroy() : Promise.resolve();
    await this.lobbyClosing;
    this.connections.clear(); this.isCoordinator = false; this.leader = null;
  }

  close() {
    if (!this.closing) this.closing = this.closeOnce();
    return this.closing;
  }

  async closeOnce() {
    if (this.closed) return;
    if (this.leader && this.leader !== this.id) this.write(this.peer(this.leader), { kind: 'cancel', request: this.request });
    this.closed = true; clearTimeout(this.ticketTimer); clearTimeout(this.releaseTimer);
    await Promise.all([this.stopLobby(), this.game?.close()]);
  }
}

module.exports = { Rendezvous, SERVICE, TOPIC };
