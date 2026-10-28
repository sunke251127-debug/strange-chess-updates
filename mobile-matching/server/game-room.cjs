'use strict';

const crypto = require('node:crypto');
const E = require('../src/game-engine.js');

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const COLORS = [E.RED, E.BLACK];

function randomToken(bytes = 18) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function randomPublicId() {
  return 'p_' + crypto.randomBytes(10).toString('base64url');
}

function makeRoomCode() {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += ROOM_ALPHABET[crypto.randomInt(0, ROOM_ALPHABET.length)];
  }
  return code;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validState(state) {
  return state && Array.isArray(state.pieces) && Array.isArray(state.captured) &&
    (state.turn === E.RED || state.turn === E.BLACK);
}

class GameRoom {
  constructor(code, options = {}) {
    this.code = code;
    this.createdAt = Date.now();
    this.updatedAt = this.createdAt;
    this.seats = [null, null];
    this.restart = null;
    this.undoRequest = null;
    this.history = [];
    this.positionRevision = 0;
    this.gameCount = 0;
    this.firstColor = options.firstColor === E.BLACK ? E.BLACK : E.RED;
    this.initialStateFactory = options.initialStateFactory || null;
    this.game = this.makeInitialState();
    this.publicIds = this.assignPublicIds();
    this.status = 'waiting';
  }

  makeInitialState() {
    const state = this.initialStateFactory ? this.initialStateFactory(this.gameCount) : E.createGame();
    if (!validState(state)) throw new Error('初始局面无效');
    this.gameCount++;
    return clone(state);
  }

  assignPublicIds() {
    const ids = new Map();
    for (const piece of this.game.pieces) ids.set(piece.id, randomPublicId());
    return ids;
  }

  publicId(id) {
    let publicId = this.publicIds.get(id);
    if (!publicId) {
      publicId = randomPublicId();
      this.publicIds.set(id, publicId);
    }
    return publicId;
  }

  occupiedSeats() {
    return this.seats.filter(Boolean).length;
  }

  colorForSeat(seat) {
    return (seat + this.gameCount - 1) % 2 === 0 ? this.firstColor : E.opposite(this.firstColor);
  }

  addPlayer(socketId) {
    if (this.occupiedSeats() >= 2) {
      const error = new Error('房间已满');
      error.code = 'ROOM_FULL';
      throw error;
    }
    const seat = this.seats[0] ? 1 : 0;
    const token = randomToken();
    this.seats[seat] = { socketId, token, connected: true, joinedAt: Date.now() };
    this.status = this.seats[0] && this.seats[1]
      ? (this.game.winner ? 'ended' : 'playing')
      : 'waiting';
    this.updatedAt = Date.now();
    return { seat, color: this.colorForSeat(seat), token };
  }

  reconnect(socketId, token) {
    if (typeof token !== 'string' || token.length < 10 || token.length > 200) return null;
    const seat = this.seats.findIndex(player => player && player.token === token);
    if (seat < 0) return null;
    const previousSocketId = this.seats[seat].socketId;
    this.seats[seat].socketId = socketId;
    this.seats[seat].connected = true;
    this.updatedAt = Date.now();
    if (this.seats[0] && this.seats[1]) {
      this.status = this.game.winner ? 'ended' : 'playing';
    }
    return { seat, color: this.colorForSeat(seat), previousSocketId };
  }

  disconnect(socketId) {
    const seat = this.seats.findIndex(player => player && player.socketId === socketId);
    if (seat < 0) return null;
    this.seats[seat].connected = false;
    this.clearRequests();
    this.updatedAt = Date.now();
    return seat;
  }

  removePlayer(seat) {
    if (!this.seats[seat]) return null;
    const removed = this.seats[seat];
    this.seats[seat] = null;
    this.clearRequests();
    this.updatedAt = Date.now();
    return removed;
  }

  bothConnected() {
    return this.occupiedSeats() === 2 && this.seats.every(player => player && player.connected);
  }

  playerSeat(socketId) {
    return this.seats.findIndex(player => player && player.socketId === socketId);
  }

  get colorOfTurn() {
    return this.game.turn;
  }

  move(seat, fromX, fromY, toX, toY) {
    if (this.status !== 'playing') {
      const error = new Error(this.game.winner ? '本局已结束' : '对局尚未开始');
      error.code = 'NOT_PLAYING';
      throw error;
    }
    if (!this.bothConnected()) {
      const error = new Error('对手已断线，暂时不能走棋');
      error.code = 'OPPONENT_DISCONNECTED';
      throw error;
    }
    if (seat !== 0 && seat !== 1) {
      const error = new Error('你不在这个房间中');
      error.code = 'NOT_SEATED';
      throw error;
    }
    const color = this.colorForSeat(seat);
    if (this.game.turn !== color) {
      const error = new Error('还没有轮到你走棋');
      error.code = 'NOT_YOUR_TURN';
      throw error;
    }
    const coords = [fromX, fromY, toX, toY];
    if (!coords.every(Number.isInteger)) {
      const error = new Error('坐标必须是整数');
      error.code = 'BAD_COORDINATES';
      throw error;
    }
    const result = E.move(this.game, fromX, fromY, toX, toY);
    if (!result.ok) {
      const error = new Error(result.error);
      error.code = 'ILLEGAL_MOVE';
      throw error;
    }
    this.history.push(clone(this.game));
    if (this.history.length > 35) this.history.shift();
    this.game = result.state;
    this.positionRevision++;
    this.updatedAt = Date.now();
    if (this.game.winner) this.status = 'ended';
    this.clearRequests();
    return this.game;
  }

  clearRequests() {
    this.restart = null;
    this.undoRequest = null;
  }

  requirePlayer(seat) {
    if ((seat !== 0 && seat !== 1) || !this.seats[seat]) {
      const error = new Error('你不在这个房间中'); error.code = 'NOT_SEATED'; throw error;
    }
    if (!this.bothConnected()) {
      const error = new Error('双方都在线时才能申请或同意'); error.code = 'OPPONENT_DISCONNECTED'; throw error;
    }
  }

  requestChange(seat, kind) {
    this.requirePlayer(seat);
    if (!['playing', 'ended'].includes(this.status)) throw new Error('对局尚未开始');
    if (kind === 'undo' && !this.history.length) {
      const error = new Error('还没有可以撤销的棋'); error.code = 'NO_UNDO_HISTORY'; throw error;
    }
    const pending = this.restart || this.undoRequest;
    if (pending) {
      if (pending.kind === kind && pending.requestedBy === seat) return pending;
      const error = new Error('请先处理当前的悔棋或新棋局申请'); error.code = 'ACTION_PENDING'; throw error;
    }
    const request = { id: randomToken(12), kind, requestedBy: seat, acceptedBy: [seat], requestedAt: Date.now(), revision: this.positionRevision };
    if (kind === 'restart') this.restart = request; else this.undoRequest = request;
    this.updatedAt = Date.now();
    return request;
  }

  requestRestart(seat) { return this.requestChange(seat, 'restart'); }
  requestUndo(seat) { return this.requestChange(seat, 'undo'); }

  respondChange(seat, kind, accept, requestId) {
    this.requirePlayer(seat);
    if (typeof accept !== 'boolean') throw new Error('请明确同意或拒绝');
    const pending = kind === 'restart' ? this.restart : this.undoRequest;
    if (!pending) {
      const error = new Error('申请已失效，请重新申请'); error.code = kind === 'restart' ? 'NO_RESTART_PENDING' : 'NO_UNDO_PENDING'; throw error;
    }
    if (seat === pending.requestedBy) {
      const error = new Error('需要对方同意'); error.code = 'SELF_ACCEPT_NOT_ALLOWED'; throw error;
    }
    // Legacy clients only support restart after game over and omit the id.
    // All current requests are tied to a unique id and an unchanged position.
    const legacyRestart = kind === 'restart' && requestId === undefined && this.status === 'ended';
    if ((!legacyRestart && requestId !== pending.id) || pending.revision !== this.positionRevision) {
      const error = new Error('申请已失效，请重新申请'); error.code = 'STALE_REQUEST'; throw error;
    }
    if (!accept) {
      this.clearRequests(); this.updatedAt = Date.now();
      return kind === 'restart' ? { restarted: false, declinedBy: seat } : { undone: false, declinedBy: seat };
    }
    if (kind === 'undo') {
      if (!this.history.length) throw new Error('还没有可以撤销的棋');
      const revision = (Number.isInteger(this.game.revision) ? this.game.revision : this.game.moveNumber) + 1;
      this.game = this.history.pop();
      this.game.revision = revision;
    } else {
      this.game = this.makeInitialState();
      this.history = [];
      this.publicIds = this.assignPublicIds();
    }
    this.positionRevision++;
    this.clearRequests();
    this.status = this.game.winner ? 'ended' : 'playing';
    this.updatedAt = Date.now();
    return kind === 'restart' ? { restarted: true } : { undone: true };
  }

  respondRestart(seat, accept, requestId) { return this.respondChange(seat, 'restart', accept, requestId); }
  respondUndo(seat, accept, requestId) { return this.respondChange(seat, 'undo', accept, requestId); }

  sanitizePiece(piece, includeLocation = true) {
    const result = {
      id: this.publicId(piece.id),
      x: piece.x,
      y: piece.y,
      faceUp: Boolean(piece.faceUp),
      slotKind: piece.slotKind,
      slotColor: piece.slotColor
    };
    if (piece.faceUp) {
      result.kind = piece.kind;
      result.color = piece.color;
    }
    if (!includeLocation) {
      delete result.x;
      delete result.y;
    }
    return result;
  }

  // Only whitelisted public fields cross the wire. Piece identifiers are always replaced
  // with the room's random public ids; concealed attacker identities are never included.
  sanitizeLastMove(lastMove) {
    if (!lastMove) return null;
    const revealKing = lastMove.type === 'reveal-king';
    const result = {
      type: revealKing ? 'reveal-king' : 'move',
      fromX: lastMove.fromX,
      fromY: lastMove.fromY,
      toX: lastMove.toX,
      toY: lastMove.toY,
      color: lastMove.color,
      pieceId: this.publicId(lastMove.pieceId),
      revealed: Boolean(lastMove.revealed),
      switchedSide: Boolean(lastMove.switchedSide),
      capturedName: lastMove.capturedName || null,
      capturedColor: lastMove.capturedColor || null
    };
    if (revealKing) {
      result.targetId = this.publicId(lastMove.targetId);
      result.targetColor = lastMove.targetColor === E.RED ? E.RED : E.BLACK;
      result.targetName = lastMove.targetName === '帅' ? '帅' : '将';
    } else {
      result.pieceName = lastMove.pieceName || null;
      result.pieceColor = lastMove.pieceColor || null;
    }
    return result;
  }

  sanitizeLastAction(lastAction) {
    if (!lastAction) return null;
    if (lastAction.type !== 'reveal-king') return this.sanitizeLastMove(lastAction);
    return {
      type: 'reveal-king',
      color: lastAction.color,
      pieceId: this.publicId(lastAction.pieceId),
      fromX: lastAction.fromX,
      fromY: lastAction.fromY,
      toX: lastAction.toX,
      toY: lastAction.toY,
      targetId: this.publicId(lastAction.targetId),
      targetColor: lastAction.targetColor === E.RED ? E.RED : E.BLACK,
      targetName: lastAction.targetName === '帅' ? '帅' : '将'
    };
  }

  publicState() {
    const state = this.game;
    return {
      version: 1,
      pieces: state.pieces.map(piece => this.sanitizePiece(piece)),
      turn: state.turn,
      winner: state.winner,
      endReason: state.endReason,
      moveNumber: state.moveNumber,
      revision: Number.isInteger(state.revision) ? state.revision : (Number.isInteger(state.moveNumber) ? state.moveNumber : 0),
      lastMove: this.sanitizeLastMove(state.lastMove),
      lastAction: this.sanitizeLastAction(state.lastAction),
      captured: state.captured.map(piece => {
        const safe = this.sanitizePiece(Object.assign({}, piece, { faceUp: true }));
        safe.capturedBy = piece.capturedBy || null;
        return safe;
      })
    };
  }

  publicView(share = {}, extra = {}) {
    const pending = this.restart || this.undoRequest;
    return {
      type: 'room',
      roomCode: this.code,
      round: this.gameCount,
      status: this.status,
      paused: this.status === 'playing' && !this.bothConnected(),
      players: this.seats.map((player, seat) => ({
        seat,
        color: this.colorForSeat(seat),
        occupied: Boolean(player),
        connected: Boolean(player && player.connected)
      })),
      bothConnected: this.bothConnected(),
      state: this.publicState(),
      canUndo: this.history.length > 0,
      pendingAction: pending ? { id: pending.id, kind: pending.kind, requestedBy: pending.requestedBy, requestedAt: pending.requestedAt } : null,
      pendingRestart: this.restart ? {
        requestedBy: this.restart.requestedBy,
        acceptedBy: this.restart.acceptedBy.slice(),
        requestedAt: this.restart.requestedAt
      } : null,
      share,
      ...extra
    };
  }

  cleanupInfo(now = Date.now()) {
    const allDisconnected = this.seats.filter(Boolean).every(player => !player.connected);
    return {
      waitingExpired: this.status === 'waiting' && now - this.updatedAt > 30 * 60 * 1000,
      finishedExpired: this.status === 'ended' && now - this.updatedAt > 2 * 60 * 60 * 1000,
      abandonedExpired: this.occupiedSeats() > 0 && allDisconnected && now - this.updatedAt > 15 * 60 * 1000,
      empty: this.occupiedSeats() === 0
    };
  }
}

class RoomManager {
  constructor(options = {}) {
    this.rooms = new Map();
    this.initialStateFactory = options.initialStateFactory || null;
  }

  createRoom(options = {}) {
    let code = makeRoomCode();
    let attempts = 0;
    while (this.rooms.has(code) && attempts++ < 30) code = makeRoomCode();
    if (this.rooms.has(code)) throw new Error('无法生成房间号');
    const room = new GameRoom(code, {
      initialStateFactory: options.initialStateFactory || this.initialStateFactory
    });
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code) {
    if (typeof code !== 'string') return null;
    return this.rooms.get(code.toUpperCase()) || null;
  }

  deleteRoom(code) {
    return this.rooms.delete(code);
  }

  cleanup(now = Date.now()) {
    let removed = 0;
    for (const [code, room] of this.rooms) {
      const info = room.cleanupInfo(now);
      if (info.empty || info.waitingExpired || info.finishedExpired || info.abandonedExpired) {
        this.rooms.delete(code);
        removed++;
      }
    }
    return removed;
  }
}

module.exports = {
  GameRoom,
  RoomManager,
  makeRoomCode,
  randomToken,
  randomPublicId,
  COLORS
};
