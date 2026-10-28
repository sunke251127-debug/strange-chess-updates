(function (root) {
  'use strict';
  const SERVICE = 'strange-chess/player-match-lite-v1/concealed';
  const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
  const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const bytes = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - text.length % 4) % 4)), c => c.charCodeAt(0));
  const concat = (...parts) => { const value = new Uint8Array(parts.reduce((n, part) => n + part.length, 0)); let at = 0; for (const part of parts) { value.set(part, at); at += part.length; } return value; };
  const mqttString = text => { const value = encoder.encode(text); return concat(Uint8Array.of(value.length >> 8, value.length & 255), value); };
  function publishPacket(topic, value) {
    const body = concat(mqttString(topic), encoder.encode(JSON.stringify(value))), size = [];
    if (body.length > 65536) throw new Error('匹配消息过长');
    let n = body.length; do { let digit = n % 128; n = Math.floor(n / 128); if (n) digit |= 128; size.push(digit); } while (n);
    return concat(Uint8Array.of(0x30, ...size), body);
  }
  async function identity(publicKey) { return b64(await crypto.subtle.digest('SHA-256', bytes(publicKey))); }
  const valid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,100}$/.test(value);

  // Reuse the proven WSS reconnect, MQTT framing and keepalive transport. This
  // topic only contains ephemeral discovery metadata and encrypted signalling;
  // the public transport key is deliberately not a game encryption key.
  class DiscoveryBus extends root.StrangeChessRelay.Channel {
    constructor(service, options) {
      super('public-matching', 'A'.repeat(43), false, options);
      this.inTopic = this.outTopic = service;
    }
    probe() {}
    async control() {}
    async send(value) { await this.open(); if (!this.closed) this.publish(publishPacket(this.outTopic, value)); }
    async decrypt(payload) {
      if (this.closed || payload.length > 64000) return;
      let value; try { value = JSON.parse(decoder.decode(payload)); } catch { return; }
      if (value && value.v === 1 && typeof value.kind === 'string') this.dispatchEvent(new MessageEvent('message', { data: value }));
    }
  }

  class Link extends root.StrangeChessDirect.Link {
    constructor(options = {}) {
      super(options); this.randomMatch = true; this.matchPhase = 'idle'; this.matchNotice = '';
      this.nodes = new Map(); this.players = new Map(); this.introductions = new Map();
      this.publicSequence = 0; this.signalSequence = 0; this.seenSignals = new Set();
      this.cachedSignals = new Map();
      this.matchRequest = root.SystemRandom.id(24); this.discoveryClosed = false; this.receiveChain = Promise.resolve();
      this.addEventListener('state', event => { if (event.detail === 'connected' && this.started) this.confirmIntroduction(); });
    }
    static available() { return Boolean(root.crypto?.subtle && root.WebSocket && root.StrangeChessRelay && root.StrangeChessDirect); }
    phase(phase, message) {
      this.matchPhase = phase; this.matchNotice = message;
      this.dispatchEvent(new CustomEvent('matchstatus', { detail: { phase, message } }));
    }
    start() {
      if (this.beginning || this.ended) throw new Error('匹配已经启动或取消');
      if (!Link.available()) throw new Error('当前系统缺少安全联机组件，请更新系统 WebView');
      this.phase('searching', '正在连接公共发现入口，可以随时取消。'); this.state('searching');
      this.beginning = this.begin().catch(error => { if (!this.ended) this.close('随机匹配启动失败：' + error.message); });
    }
    async begin() {
      this.identityKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
      this.publicKey = b64(await crypto.subtle.exportKey('raw', this.identityKeys.publicKey));
      this.matchId = await identity(this.publicKey);
      if (this.ended) return;
      this.bus = new DiscoveryBus(this.options.service || SERVICE, { ...this.options.discoveryOptions, urls: this.options.discoveryUrls });
      this.bus.addEventListener('message', event => { this.receiveChain = this.receiveChain.then(() => this.receiveDiscovery(event.data)).catch(() => {}); });
      this.bus.addEventListener('open', () => this.tick());
      this.bus.addEventListener('state', () => { if (!this.ended && !this.discoveryClosed && !this.bus.sockets.size) this.phase('searching', '公共匹配入口暂时不可达，正在自动重试；也可以取消后使用好友直连。'); });
      this.electionAt = Date.now() + (this.options.electionDelay ?? 1800) + root.SystemRandom.integer(300);
      this.matchTimer = setInterval(() => this.tick(), this.options.matchInterval ?? 1000);
      await this.bus.open();
      if (!this.ended) this.tick();
    }
    publish(kind, fields = {}) {
      if (!this.bus || this.ended || this.discoveryClosed) return;
      void this.bus.send({ v: 1, kind, from: this.matchId, pub: this.publicKey, seq: ++this.publicSequence, ...fields }).catch(() => {});
    }
    async receiveDiscovery(value) {
      if (this.ended || this.discoveryClosed || !valid(value.from) || value.from === this.matchId || !valid(value.pub) || !Number.isSafeInteger(value.seq) || value.seq < 1) return;
      if (await identity(value.pub) !== value.from) return;
      const previous = this.nodes.get(value.from);
      if (previous && value.seq <= previous.seq) return;
      if (!previous && this.nodes.size >= 512) return;
      const node = { ...previous, id: value.from, pub: value.pub, seq: value.seq, seen: Date.now() };
      this.nodes.set(value.from, node);
      if (value.kind === 'hello') {
        node.server = value.server === true && Number.isSafeInteger(value.since) && value.since > 0 && value.since <= Date.now() + 60000;
        node.since = value.since; this.elect();
      } else if (value.kind === 'join' && this.isCoordinator && value.to === this.matchId && valid(value.request)) {
        this.enqueue({ id: value.from, pub: value.pub, request: value.request, trickle: value.trickle === true }); this.pump();
      } else if (value.kind === 'assignment' && value.to === this.matchId && value.from === this.leader) {
        await this.acceptAssignment(value);
      } else if (value.kind === 'signal' && value.to === this.matchId && value.session === this.assignment?.session && value.from === this.opponent?.id) {
        await this.receiveSignal(value);
      } else if (value.kind === 'connected' && this.isCoordinator && value.to === this.matchId) {
        this.release(value.from, value.request, value.session);
      } else if (value.kind === 'cancel' && this.isCoordinator && value.to === this.matchId) {
        const player = this.players.get(value.from); if (player?.request === value.request && !player.session) this.players.delete(value.from);
      } else if (value.kind === 'full' && value.to === this.matchId && value.from === this.leader) {
        this.phase('waiting', '当前匹配节点的建连名额已满，正在等待空位。');
      }
    }
    elect() {
      const now = Date.now(), candidates = [];
      for (const [id, node] of this.nodes) { if (now - node.seen > (this.options.nodeTimeout ?? 9000)) this.nodes.delete(id); else if (node.server) candidates.push(node); }
      if (this.isCoordinator) candidates.push({ id: this.matchId, since: this.since });
      candidates.sort((a, b) => a.since - b.since || (a.id < b.id ? -1 : 1));
      let leader = candidates[0]?.id;
      if (!leader && this.bus?.sockets.size && now >= this.electionAt) {
        this.isCoordinator = true; this.since = now; this.readyAt = now + (this.options.electionSettle ?? 800); leader = this.matchId;
      }
      if (this.isCoordinator && leader !== this.matchId) { this.isCoordinator = false; this.players.clear(); this.introductions.clear(); }
      if (this.leader !== leader) {
        this.leader = leader;
        if (!this.assignment) this.phase(leader === this.matchId ? 'hosting' : 'waiting', leader === this.matchId ? '你的设备正在临时提供匹配服务，等待对手加入。' : '已找到匹配节点，正在等待在线对手。');
      }
    }
    enqueue(player) {
      const existing = this.players.get(player.id);
      if (existing) { if (existing.request === player.request) existing.seen = Date.now(); return; }
      if (this.players.size >= (this.options.capacity ?? 100)) { this.publish('full', { to: player.id }); return; }
      this.players.set(player.id, { ...player, seen: Date.now(), order: Date.now() });
    }
    pump() {
      if (!this.isCoordinator || Date.now() < this.readyAt) return;
      const waiting = [...this.players.values()].filter(player => !player.session);
      while (waiting.length > 1) {
        const members = waiting.splice(0, 2).map(({ id, pub, request, trickle }) => ({ id, pub, request, trickle: trickle === true }));
        const ticket = { session: root.SystemRandom.id(32), members, expires: Date.now() + (this.options.introductionTimeout ?? 45000), confirmed: new Set() };
        for (const member of members) this.players.get(member.id).session = ticket.session;
        this.introductions.set(ticket.session, ticket);
      }
      for (const ticket of this.introductions.values()) {
        if (Date.now() > ticket.expires) { this.introductions.delete(ticket.session); for (const member of ticket.members) this.players.delete(member.id); continue; }
        for (const member of ticket.members) {
          if (ticket.confirmed.has(member.id)) continue;
          const value = { session: ticket.session, members: ticket.members, expires: ticket.expires };
          if (member.id === this.matchId) void this.acceptAssignment({ ...value, from: this.matchId, to: this.matchId }).catch(error => this.close(error.message));
          else this.publish('assignment', { ...value, to: member.id });
        }
      }
    }
    async acceptAssignment(value) {
      if (this.ended || this.discoveryClosed || this.assignment || this.verifyingAssignment || this.started || !valid(value.session) || !Array.isArray(value.members) || value.members.length !== 2 || !Number.isSafeInteger(value.expires) || value.expires <= Date.now() || value.expires > Date.now() + 120000) return;
      const own = value.members.find(member => member.id === this.matchId && member.request === this.matchRequest && member.pub === this.publicKey);
      const other = value.members.find(member => member.id !== this.matchId);
      if (!own || !other || !valid(other.pub)) return;
      this.verifyingAssignment = true;
      let verified = false;
      try { verified = await identity(other.pub) === other.id; }
      finally { this.verifyingAssignment = false; }
      // Crypto runs asynchronously on phones. Cancel/exit may have happened
      // while verification was pending; never revive that abandoned search.
      if (!verified || this.ended || this.discoveryClosed || this.assignment) return;
      this.assignment = value; this.opponent = other;
      this.options.trickleIce = value.members.every(member => member.trickle === true);
      this.options.parallelRelay = this.options.trickleIce;
      this.options.onIceCandidate = candidate => this.sendSignal({ type: 'candidate', candidate });
      this.assignmentTimeout = setTimeout(() => {
        if (!this.ended && !this.started) this.close('对手未完成连接，请重新点击随机联机；也可以使用好友直连。');
      }, Math.max(1, value.expires - Date.now()));
      this.pairKey = crypto.subtle.importKey('raw', bytes(other.pub), { name: 'ECDH', namedCurve: 'P-256' }, false, []).then(publicKey => crypto.subtle.deriveKey({ name: 'ECDH', public: publicKey }, this.identityKeys.privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
      this.phase('introducing', '已找到对手，正在建立双方独立连接。');
      if (this.matchId < other.id) { await this.pairKey; const invite = await super.offer(); if (!this.ended) await this.sendSignal({ type: 'offer', invite }); }
    }
    aad(sender, target) { return encoder.encode(this.assignment.session + ':' + sender + ':' + target); }
    async sendSignal(value) {
      if (this.ended || this.discoveryClosed || !this.assignment || this.cachedSignals.size >= 64) return;
      const iv = crypto.getRandomValues(new Uint8Array(12)), seq = ++this.signalSequence;
      const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: this.aad(this.matchId, this.opponent.id) }, await this.pairKey, encoder.encode(JSON.stringify({ seq, ...value })));
      if (this.ended || this.discoveryClosed || this.cachedSignals.size >= 64) return;
      this.cachedSignal = { to: this.opponent.id, session: this.assignment.session, iv: b64(iv), data: b64(data) };
      this.cachedSignals.set(seq, this.cachedSignal);
      this.publish('signal', this.cachedSignal);
    }
    async receiveSignal(value) {
      let payload;
      try { payload = JSON.parse(decoder.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(value.iv), additionalData: this.aad(this.opponent.id, this.matchId) }, await this.pairKey, bytes(value.data)))); } catch { return; }
      if (this.ended || this.started || !Number.isSafeInteger(payload.seq) || payload.seq < 1 || payload.seq > 128) return;
      // Retries are paced by tick(). Echoing a cached reply for every repeated
      // packet would create an offer/answer loop while RTC is still connecting.
      if (this.seenSignals.has(payload.seq)) return;
      this.seenSignals.add(payload.seq);
      if (payload.type === 'candidate' && this.options.trickleIce) {
        await this.addRemoteCandidate(payload.candidate);
      } else if (payload.type === 'offer' && this.matchId > this.opponent.id) {
        const answer = await super.accept(payload.invite); if (!this.ended) await this.sendSignal({ type: 'answer', invite: answer });
      } else if (payload.type === 'answer' && this.matchId < this.opponent.id && !this.answerAccepted) await super.accept(payload.invite);
    }
    release(id, request, session) {
      const ticket = this.introductions.get(session);
      if (!ticket || !ticket.members.some(member => member.id === id && member.request === request)) return;
      ticket.confirmed.add(id); this.players.delete(id);
      if (ticket.confirmed.size === 2) this.introductions.delete(session);
    }
    confirmIntroduction() {
      if (!this.assignment || this.introductionConfirmed) return;
      clearTimeout(this.assignmentTimeout);
      this.introductionConfirmed = true;
      if (this.isCoordinator) this.release(this.matchId, this.matchRequest, this.assignment.session);
      this.publish('connected', { to: this.assignment.from, request: this.matchRequest, session: this.assignment.session });
      this.phase('paired', '双方独立连接已建立，临时匹配记录正在释放。');
      if (!this.isCoordinator) this.discoveryRelease = setTimeout(() => this.stopMatching(), this.options.discoveryReleaseDelay ?? 1800);
    }
    tick() {
      if (this.ended || this.discoveryClosed || !this.bus?.sockets.size) return;
      this.elect();
      this.publish('hello', { server: Boolean(this.isCoordinator), since: this.since || 0 });
      if (!this.assignment && this.leader) {
        const player = { id: this.matchId, pub: this.publicKey, request: this.matchRequest, trickle: true };
        if (this.isCoordinator) this.enqueue(player); else this.publish('join', { to: this.leader, request: this.matchRequest, trickle: true });
      }
      if (this.isCoordinator) {
        for (const [id, player] of this.players) if (!player.session && Date.now() - player.seen > (this.options.nodeTimeout ?? 9000)) this.players.delete(id);
        this.pump();
      }
      if (!this.started) for (const signal of this.cachedSignals.values()) this.publish('signal', signal);
      if (this.started && this.assignment && !this.isCoordinator) this.publish('connected', { to: this.assignment.from, request: this.matchRequest, session: this.assignment.session });
    }
    share() { return { ...super.share(), random: true }; }
    joined(seat) { return { ...super.joined(seat), random: true }; }
    broadcast(extra = {}) { return super.broadcast({ ...extra, random: true }); }
    stopMatching() {
      if (this.discoveryClosed) return;
      this.discoveryClosed = true; clearInterval(this.matchTimer); clearTimeout(this.discoveryRelease); clearTimeout(this.assignmentTimeout);
      this.bus?.close(); this.players.clear(); this.introductions.clear(); this.nodes.clear(); this.isCoordinator = false;
      this.cachedSignals.clear(); this.remoteCandidates.length = 0;
    }
    close(reason = '') {
      if (this.ended) return;
      this.publish('cancel', { to: this.leader, request: this.matchRequest }); this.stopMatching(); super.close(reason);
    }
  }
  root.StrangeChessRandom = Object.freeze({ Link, SERVICE });
})(globalThis);
