(function (root) {
  'use strict';
  const links = new Map();
  root.receiveDhtEvent = function (id, value) {
    const link = links.get(id);
    if (link && !link.ended) link.nativeEvent(value);
  };
  class Link extends root.StrangeChessDirect.Link {
    constructor(options = {}) {
      super(options); this.bridge = options.bridge || root.AndroidShell;
      this.nativeConnected = false; this.matchPhase = 'idle'; this.matchNotice = '';
    }
    static available() {
      try { return Boolean(root.AndroidShell?.isDhtAvailable?.()); } catch { return false; }
    }
    // Matchmaking phases stay separate from the transport state so the UI can
    // explain temporary hosting and retries without treating them as connected.
    phase(phase, message = '') {
      this.matchPhase = phase;
      if (message) this.matchNotice = message;
      this.dispatchEvent(new CustomEvent('matchstatus', { detail: { phase, message: this.matchNotice } }));
    }
    start() {
      if (this.id || this.ended) throw new Error('已经开始匹配');
      if (!this.bridge?.startDht) throw new Error('请安装支持随机联机的新版 APK');
      this.id = root.SystemRandom.id(24); links.set(this.id, this);
      this.transport = 'dht'; this.phase('searching', '正在通过公共发现网络查找匹配节点和在线对手…'); this.state('searching');
      try { this.bridge.startDht(this.id); }
      catch (error) { this.close(error.message); throw error; }
    }
    remote(payload) {
      if (this.ended || !this.nativeConnected) return;
      this.bridge.sendDht(this.id, JSON.stringify(payload));
    }
    nativeEvent(value) {
      if (!value || typeof value.type !== 'string') return;
      if (value.type === 'paired') {
        if (this.started) return;
        this.nativeConnected = true;
        this.host = value.host === true;
        this.session = value.session;
        this.phase('paired', '已找到对手，双方独立连接已建立。');
        if (this.host) {
          this.room = new root.StrangeChessRooms.GameRoom(root.StrangeChessRooms.makeRoomCode(), { initialStateFactory: this.options.initialStateFactory });
          this.hostSeat = this.room.addPlayer('host');
          this.choose('dht');
        }
      } else if (value.type === 'data') {
        this.receive('dht', value.body);
      } else if (value.type === 'disconnected') {
        this.nativeConnected = false;
        this.phase('reconnecting', '对手连接暂时中断，正在重连原对局…');
        this.pause();
      } else if (value.type === 'reconnected') {
        if (this.session === value.session) { this.nativeConnected = true; this.phase('connected', '已恢复与原对手的独立连接。'); this.resume(); }
      } else if (value.type === 'searching') {
        this.phase('searching', '正在通过公共发现网络查找匹配节点和在线对手…'); this.state('searching');
      } else if (value.type === 'hosting') {
        this.phase('hosting', '当前没有其他匹配节点，你的手机正在临时提供匹配服务；介绍完成后会释放临时记录。');
      } else if (value.type === 'coordinator') {
        if (value.self === true) this.phase('hosting', '你正在担任当前匹配节点；配对完成或取消后会立即释放临时记录。');
        else this.phase('waiting', '已找到现有匹配节点，正在登记并等待在线对手。');
      } else if (value.type === 'introducing') {
        this.phase('introducing', '已找到一位对手，正在建立双方独立连接…');
      } else if (value.type === 'retry') {
        this.phase('searching', '这次建连没有完成，已回到等待队列并继续重试。');
      } else if (value.type === 'notice') {
        this.phase(this.matchPhase === 'idle' ? 'notice' : this.matchPhase, value.message || '匹配节点暂时繁忙，正在重试。');
      } else if (value.type === 'left') {
        this.emit({ type: 'roomClosed', message: '对方已离开随机对局' }); this.close();
      } else if (value.type === 'fatal') {
        this.close(value.message || 'DHT 联机暂不可用');
      }
    }
    share() { return { code: this.room.code, urls: [], scope: 'dht', direct: true }; }
    close(reason = '') {
      if (this.ended) return;
      links.delete(this.id);
      try { if (this.id) this.bridge?.stopDht?.(this.id); } catch {}
      super.close(reason);
    }
  }
  root.StrangeChessDht = Object.freeze({ Link });
})(globalThis);
