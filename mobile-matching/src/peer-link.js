(function (root) {
  'use strict';
  const PREFIX = 'SC-DIRECT-1:';
  const RELAY_SDP = 'v=0\r\ns=SC-RELAY\r\nt=0 0\r\n';
  function encode(value) {
    const raw = new TextEncoder().encode(JSON.stringify(value));
    let binary = ''; for (const b of raw) binary += String.fromCharCode(b);
    return PREFIX + btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function decode(text) {
    if (typeof text !== 'string' || text.length > 32768) throw new Error('直连邀请过长或无效');
    const match = text.match(/SC-DIRECT-1:([A-Za-z0-9_-]+)/);
    if (!match) throw new Error('没有找到完整直连邀请或回复码');
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(match[1].replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)))); }
    catch { throw new Error('直连信息损坏，请重新复制完整内容'); }
    if (value.v !== 1 || !/^[A-Za-z0-9_-]{18,64}$/.test(value.id) || !['offer','answer'].includes(value.type) || typeof value.sdp !== 'string' || value.sdp.length > 24000 || !value.sdp.startsWith('v=0')) throw new Error('直连信息格式无效');
    if (value.relay && (value.relay.v !== 1 || !root.StrangeChessRelay?.validKey(value.relay.key))) throw new Error('中继邀请信息损坏');
    return value;
  }
  class Link extends EventTarget {
    constructor(options = {}) {
      super(); this.options = options; this.pc = null; this.channel = null; this.room = null; this.readyState = 0;
      this.host = false; this.id = ''; this.ended = false; this.started = false; this.transport = '';
      this.relay = null; this.relayKey = ''; this.canRelay = false;
      this.pendingCommands = []; this.rtcChallenges = new Set(); this.lastRtcReply = 0;
      this.remoteCandidates = []; this.relayPreferredAt = 0;
    }
    emit(payload) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(payload) })); }
    remote(payload) {
      if (this.ended) return;
      if (this.transport === 'relay') return this.relay.send(payload).catch(error => {
        if (!this.ended) { this.pause(); this.emit({ type: 'error', message: error.message }); }
      });
      try { if (this.channel?.readyState === 'open') this.channel.send(JSON.stringify(payload)); else this.recoverRtc(); }
      catch { this.recoverRtc(); }
    }
    state(value) { this.dispatchEvent(new CustomEvent('state', { detail: value })); }
    pause() {
      if (!this.started || this.ended || this.readyState === 0) return;
      this.readyState = 0;
      if (this.host && this.guestSeat) { this.room.disconnect('guest'); this.broadcast(); }
      this.state('reconnecting');
    }
    resume() {
      if (!this.started || this.ended) return;
      this.readyState = 1;
      if (this.host) {
        this.room.reconnect('guest', this.guestSeat.token);
        const pending = this.pendingCommands.splice(0);
        for (const command of pending) this.command(1, command);
        this.broadcast();
      } else this.remote({ type: 'sync' });
      this.state('connected');
    }
    recoverRtc() {
      if (this.ended || this.transport === 'relay') return;
      this.pause();
      this.relayPreferredAt = 0;
      if (this.host && this.relay?.peerConnected) { this.choose('relay'); return; }
      if (this.canRelay) void this.startRelay();
    }
    watchRtc() {
      clearInterval(this.heartbeat);
      this.lastRtcReply = Date.now();
      this.heartbeat = setInterval(() => {
        if (this.ended || this.transport !== 'rtc') return;
        if (Date.now() - this.lastRtcReply > (this.options.peerTimeout ?? 16000)) { this.recoverRtc(); return; }
        const nonce = root.SystemRandom.id(20); this.rtcChallenges.add(nonce);
        while (this.rtcChallenges.size > 4) this.rtcChallenges.delete(this.rtcChallenges.values().next().value);
        this.remote({ type: 'linkPing', nonce });
      }, this.options.heartbeatInterval ?? 4000);
    }
    setup(host) {
      this.host = host;
      try {
        if (!root.RTCPeerConnection) throw new Error('系统 WebView 不支持 WebRTC');
        this.pc = new RTCPeerConnection({ iceServers: this.options.iceServers || [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }] });
        this.pc.addEventListener('icecandidate', event => {
          if (!this.ended && this.options.trickleIce && event.candidate && this.options.onIceCandidate) {
            Promise.resolve(this.options.onIceCandidate(event.candidate.toJSON())).catch(() => {});
          }
        });
        this.pc.addEventListener('datachannel', event => this.attach(event.channel));
        const changed = () => {
          if (this.ended || this.transport === 'relay') return;
          const state = this.pc?.connectionState || this.pc?.iceConnectionState;
          if (state === 'failed') {
            this.recoverRtc();
          } else if (state === 'disconnected' && this.transport === 'rtc') {
            this.recoverRtc();
          } else if (['connected','completed'].includes(state) && this.started) {
            this.lastRtcReply = Date.now(); this.resume();
          }
        };
        this.pc.addEventListener('connectionstatechange', changed); this.pc.addEventListener('iceconnectionstatechange', changed);
      } catch { this.pc = null; }
    }
    async gather() {
      if (this.pc.iceGatheringState === 'complete') return;
      await new Promise((resolve, reject) => {
        const pc = this.pc;
        const finish = () => { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', changed); this.ended ? reject(new Error('已取消直连')) : resolve(); };
        const changed = () => { if (pc.iceGatheringState === 'complete') finish(); };
        const timer = setTimeout(finish, this.options.gatherTimeout || 10000); pc.addEventListener('icegatheringstatechange', changed);
      });
    }
    async addRemoteCandidate(candidate) {
      if (this.ended || !this.options.trickleIce || !candidate || typeof candidate.candidate !== 'string' || candidate.candidate.length > 2048 || !candidate.candidate.startsWith('candidate:')) return;
      if (!this.pc?.remoteDescription) {
        if (this.remoteCandidates.length < 64) this.remoteCandidates.push(candidate);
      } else {
        try { await this.pc.addIceCandidate(candidate); } catch { /* other candidates may still connect */ }
      }
    }
    async flushRemoteCandidates() {
      const pending = this.remoteCandidates.splice(0);
      for (const candidate of pending) await this.addRemoteCandidate(candidate);
    }
    relayInfo() { return this.relayKey ? { v: 1, key: this.relayKey } : undefined; }
    async offer() {
      if (this.id) throw new Error('请先取消当前邀请');
      this.id = root.SystemRandom.id(24); this.relayKey = root.StrangeChessRelay ? root.StrangeChessRelay.newKey() : ''; this.canRelay = Boolean(this.relayKey);
      this.setup(true);
      this.room = new root.StrangeChessRooms.GameRoom(root.StrangeChessRooms.makeRoomCode(), { initialStateFactory: this.options.initialStateFactory, firstColor: this.options.initialHostColor });
      this.hostSeat = this.room.addPlayer('host'); let sdp = RELAY_SDP;
      if (this.pc) {
        try { this.attach(this.pc.createDataChannel('strange-chess-v1', { ordered: true })); await this.pc.setLocalDescription(await this.pc.createOffer()); if (!this.options.trickleIce) await this.gather(); sdp = this.pc.localDescription.sdp; }
        catch (error) { if (this.ended || !this.canRelay) throw error; this.pc.close(); this.pc = null; }
      } else if (!this.canRelay) throw new Error('系统 WebView 不支持联机，请更新系统组件');
      if (this.options.parallelRelay) this.scheduleRelay(!this.pc);
      return encode({ v: 1, id: this.id, type: 'offer', sdp, relay: this.relayInfo() });
    }
    async accept(text) {
      const value = decode(text);
      if (value.type === 'answer') {
        if (!this.host || this.ended || value.id !== this.id || this.answerAccepted) throw new Error('回复码不属于当前邀请，或已经使用');
        this.answerAccepted = true;
        this.canRelay = Boolean(value.relay && value.relay.key === this.relayKey);
        if (this.pc && value.sdp.includes('m=application')) {
          try { await this.pc.setRemoteDescription({ type: 'answer', sdp: value.sdp }); await this.flushRemoteCandidates(); }
          catch (error) { if (!this.canRelay) { this.answerAccepted = false; throw error; } this.pc.close(); this.pc = null; }
        } else { this.pc?.close(); this.pc = null; }
        this.connectTimeout(); this.scheduleRelay(!this.pc); return null;
      }
      if (this.id) throw new Error('请先取消当前邀请');
      this.id = value.id; this.relayKey = value.relay?.key || ''; this.canRelay = Boolean(this.relayKey); this.setup(false);
      let sdp = RELAY_SDP;
      if (this.pc && value.sdp.includes('m=application')) {
        try { await this.pc.setRemoteDescription({ type: 'offer', sdp: value.sdp }); await this.flushRemoteCandidates(); await this.pc.setLocalDescription(await this.pc.createAnswer()); if (!this.options.trickleIce) await this.gather(); sdp = this.pc.localDescription.sdp; }
        catch (error) { if (this.ended || !this.canRelay) throw error; this.pc.close(); this.pc = null; }
      } else { this.pc?.close(); this.pc = null; if (!this.canRelay) throw new Error('此邀请无法建立连接，请双方更新到新版'); }
      this.scheduleRelay(!this.pc);
      return encode({ v: 1, id: this.id, type: 'answer', sdp, relay: this.relayInfo() });
    }
    scheduleRelay(immediate = false) {
      if (!this.canRelay || this.ended || this.started) return;
      clearTimeout(this.fallbackTimer);
      if (this.options.parallelRelay && !immediate) {
        if (!this.relayPreferredAt) this.relayPreferredAt = Date.now() + (this.options.fallbackDelay ?? 1800);
        void this.startRelay();
        this.fallbackTimer = setTimeout(() => { if (!this.ended && !this.started && this.host && this.relay?.peerConnected) this.choose('relay'); }, Math.max(0, this.relayPreferredAt - Date.now()));
        return;
      }
      this.fallbackTimer = setTimeout(() => { void this.startRelay(); }, immediate ? 0 : (this.options.fallbackDelay ?? 4500));
    }
    async startRelay() {
      if (this.ended || this.relay || !this.canRelay) return;
      if (!this.started) this.state('relay-connecting');
      const relay = new root.StrangeChessRelay.Channel(this.id, this.relayKey, this.host, { ...this.options.relayOptions, urls: this.options.relayUrls, timeout: this.options.relayTimeout }); this.relay = relay;
      relay.addEventListener('message', event => {
        if (this.ended || this.relay !== relay) return;
        const value = event.data;
        this.receive('relay', value);
      });
      relay.addEventListener('state', event => {
        if (this.ended || this.relay !== relay) return;
        if (event.detail === 'connected') {
          if (this.host && this.transport !== 'relay') {
            if (!this.started && this.pc && Date.now() < this.relayPreferredAt) return;
            this.choose('relay');
          }
          else if (this.transport === 'relay') this.resume();
        } else if (this.transport === 'relay') this.pause();
      });
      try {
        await relay.open();
      } catch (error) { if (!this.ended && this.relay === relay && !this.started) this.close(error.message); }
    }
    choose(transport) {
      if (this.ended || (this.started && (transport === this.transport || transport !== 'relay'))) return;
      const initial = !this.started;
      this.transport = transport; this.started = true; this.readyState = 1;
      if (!this.host && transport === 'relay' && !this.relay?.peerConnected) this.readyState = 0;
      clearTimeout(this.timer); clearTimeout(this.fallbackTimer); clearInterval(this.probeTimer);
      if (transport === 'rtc') { const relay = this.relay; this.relay = null; relay?.close(); this.watchRtc(); }
      else { clearInterval(this.heartbeat); this.pc?.close(); }
      if (this.host) {
        if (initial) { this.guestSeat = this.room.addPlayer('guest'); this.emit(this.joined(this.hostSeat)); }
        else this.room.reconnect('guest', this.guestSeat.token);
        this.remote(this.joined(this.guestSeat));
        const pending = this.pendingCommands.splice(0);
        for (const command of pending) this.command(1, command);
        this.broadcast();
      }
      this.state(this.readyState === 1 ? 'connected' : 'reconnecting');
    }
    receive(transport, payload) {
      if (this.ended || !payload || typeof payload.type !== 'string') return;
      // Only an authenticated relay join may migrate an existing RTC session.
      // The host retains the original GameRoom, seat tokens and concealed pieces.
      if (!this.host && payload.type === 'joined' && transport === 'relay') this.choose(transport);
      if (this.transport && this.transport !== transport) return;
      if (payload.type === 'linkPing' && transport === 'rtc' && typeof payload.nonce === 'string' && payload.nonce.length === 20) { this.remote({ type: 'linkPong', nonce: payload.nonce }); return; }
      if (payload.type === 'linkPong' && transport === 'rtc') {
        if (this.rtcChallenges.delete(payload.nonce)) this.lastRtcReply = Date.now();
        return;
      }
      if (this.host) {
        if (this.started && this.readyState !== 1) {
          if (this.pendingCommands.length < 16) this.pendingCommands.push(payload);
        } else if (this.started) this.command(1, payload);
      }
      else if (['joined','room','error','roomClosed','left'].includes(payload.type)) {
        if (payload.type === 'joined') this.choose(transport);
        if (this.started) this.emit(payload);
      }
    }
    connectTimeout() {
      clearTimeout(this.timer); this.timer = setTimeout(() => { if (!this.started) this.close('直连和加密中继均未连通。请确认双方使用新版，重新复制完整回复码后再试。'); }, 35000);
    }
    share() { return { code: this.room.code, urls: [], scope: 'direct', direct: true }; }
    joined(seat) { return { type: 'joined', roomCode: this.room.code, seat: seat.seat, color: this.room.colorForSeat(seat.seat), token: seat.token, share: this.share(), direct: true, transport: this.transport }; }
    broadcast(extra = {}) { const view = this.room.publicView(this.share(), { ...extra, direct: true }); view.transport = this.transport; this.remote(view); this.emit(view); }
    attach(channel) {
      if (this.channel) throw new Error('重复的数据通道'); this.channel = channel;
      channel.addEventListener('open', () => { if (!this.ended && this.host) this.choose('rtc'); });
      channel.addEventListener('message', event => {
        if (typeof event.data !== 'string' || event.data.length > (this.host ? 4096 : 65536)) return;
        let payload; try { payload = JSON.parse(event.data); } catch { return; }
        this.receive('rtc', payload);
      });
      channel.addEventListener('close', () => this.recoverRtc());
      channel.addEventListener('error', () => this.recoverRtc());
    }
    send(raw) {
      if (this.readyState !== 1 || this.ended || raw.length > 4096) throw new Error('连接暂不可用');
      const payload = JSON.parse(raw);
      if (this.host) Promise.resolve().then(() => { if (!this.ended) this.command(0, payload); }); else this.remote(payload);
    }
    command(seat, payload) {
      try {
        const extra = {};
        if (payload.type === 'move') this.room.move(seat, payload.fromX, payload.fromY, payload.toX, payload.toY);
        else if (payload.type === 'requestRestart') this.room.requestRestart(seat);
        else if (payload.type === 'requestUndo') this.room.requestUndo(seat);
        else if (payload.type === 'respondRestart') {
          const result = this.room.respondRestart(seat, payload.accept, payload.requestId);
          extra.notice = result.restarted ? '双方已同意，新棋局开始' : '新棋局申请已拒绝，保持当前棋局';
        }
        else if (payload.type === 'respondUndo') {
          const result = this.room.respondUndo(seat, payload.accept, payload.requestId);
          extra.notice = result.undone ? '双方已同意，已撤销上一手' : '悔棋申请已拒绝，可以继续下棋';
        }
        else if (payload.type === 'leaveRoom') {
          const message = this.transport === 'dht' ? '对方已离开随机对局' : '对方已离开好友对局';
          const remote = seat === 0 ? { type:'roomClosed', message } : { type:'left' };
          const local = seat === 0 ? { type:'left' } : { type:'roomClosed', message };
          Promise.resolve(this.remote(remote)).then(() => { this.emit(local); setTimeout(() => this.close(), 40); }); return;
        } else if (payload.type === 'sync') { this.broadcast(); return; }
        else if (payload.type === 'ping') return;
        else throw new Error('不支持的联机操作');
        this.broadcast(extra);
      } catch (error) {
        const result = { type: 'error', code: error.code || 'DIRECT_ERROR', message: error.message || '操作失败' };
        if (seat === 0) this.emit(result); else this.remote(result);
      }
    }
    close(reason = '') {
      if (this.ended) return; this.ended = true; this.readyState = 3;
      clearTimeout(this.timer); clearTimeout(this.fallbackTimer); clearInterval(this.probeTimer); clearInterval(this.heartbeat);
      this.pendingCommands.length = 0; this.rtcChallenges.clear();
      this.remoteCandidates.length = 0;
      this.relay?.close(); this.channel?.close(); this.pc?.close(); this.state('closed');
      this.dispatchEvent(new CustomEvent('close', { detail: reason }));
    }
  }
  root.StrangeChessDirect = { Link, encode, decode, isInvite: text => typeof text === 'string' && text.includes(PREFIX) };
})(globalThis);
