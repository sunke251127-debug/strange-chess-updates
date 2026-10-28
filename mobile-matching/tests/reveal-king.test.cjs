'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const { startChessServer } = require('../server/server.cjs');
const { GameRoom } = require('../server/game-room.cjs');

function piece(id, kind, color, x, y, extra = {}) {
  return { id, kind, color, x, y, faceUp: true, slotKind: kind, slotColor: color, ...extra };
}

function board(pieces, turn = 'red') {
  return {
    version: 1,
    pieces,
    turn,
    winner: null,
    endReason: null,
    moveNumber: 0,
    revision: 0,
    lastMove: null,
    lastAction: null,
    captured: []
  };
}

function enemyKingState() {
  return board([
    piece(7, 'cannon', 'black', 0, 5, { faceUp: false, slotKind: 'rook', slotColor: 'red' }),
    piece(9, 'king', 'black', 0, 3, { faceUp: false, slotKind: 'pawn', slotColor: 'black' }),
    piece(11, 'pawn', 'black', 8, 0)
  ]);
}

function friendlyKingState() {
  return board([
    piece(7, 'cannon', 'black', 0, 5, { faceUp: false, slotKind: 'rook', slotColor: 'red' }),
    piece(9, 'king', 'red', 0, 3, { faceUp: false, slotKind: 'pawn', slotColor: 'black' }),
    piece(11, 'pawn', 'black', 8, 0)
  ]);
}

function roomWith(factory) {
  const room = new GameRoom('TEST01', { initialStateFactory: factory });
  room.addPlayer('socket-a');
  room.addPlayer('socket-b');
  return room;
}

function rawIdsAbsent(state, ids = [7, 9, 11]) {
  const text = JSON.stringify(state);
  for (const id of ids) {
    assert.equal(text.includes(`"id":${id}`), false, `raw id ${id} leaked`);
    assert.equal(text.includes(`"pieceId":${id}`), false, `raw pieceId ${id} leaked`);
    assert.equal(text.includes(`"targetId":${id}`), false, `raw targetId ${id} leaked`);
  }
}

class Client {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.queue = [];
    this.waiters = [];
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      const timer = setTimeout(() => reject(new Error('open timeout')), 4000);
      this.ws.once('open', () => { clearTimeout(timer); resolve(this); });
      this.ws.once('error', error => { clearTimeout(timer); reject(error); });
      this.ws.on('message', data => {
        let message;
        try { message = JSON.parse(String(data)); } catch { return; }
        const index = this.waiters.findIndex(waiter => waiter.predicate(message));
        if (index >= 0) {
          const [waiter] = this.waiters.splice(index, 1);
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        } else {
          this.queue.push(message);
        }
      });
    });
  }

  waitFor(predicate, timeout = 4000) {
    const index = this.queue.findIndex(predicate);
    if (index >= 0) {
      const [message] = this.queue.splice(index, 1);
      return Promise.resolve(message);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          const at = this.waiters.indexOf(waiter);
          if (at >= 0) this.waiters.splice(at, 1);
          reject(new Error('timed out waiting for websocket message'));
        }, timeout)
      };
      this.waiters.push(waiter);
    });
  }

  send(payload) {
    this.ws.send(JSON.stringify(payload));
  }

  close() {
    return new Promise(resolve => {
      if (!this.ws) { resolve(); return; }
      const timer = setTimeout(resolve, 800);
      this.ws.once('close', () => { clearTimeout(timer); resolve(); });
      try { this.ws.close(); } catch { resolve(); }
    });
  }
}

async function joinRoom(server) {
  const url = `ws://127.0.0.1:${server.port}/ws`;
  const host = await new Client(url).open();
  host.send({ type: 'createRoom' });
  const hostJoined = await host.waitFor(message => message.type === 'joined');
  const guest = await new Client(url).open();
  guest.send({ type: 'joinRoom', roomCode: hostJoined.roomCode });
  await guest.waitFor(message => message.type === 'joined');
  const hostPlaying = await host.waitFor(message => message.type === 'room' && message.status === 'playing');
  const guestPlaying = await guest.waitFor(message => message.type === 'room' && message.status === 'playing');
  assert.deepEqual(hostPlaying.state, guestPlaying.state);
  return { host, guest, hostJoined, hostPlaying, guestPlaying };
}

test('public state exposes revision and a whitelisted reveal-king action with public ids only', () => {
  const room = roomWith(enemyKingState);
  room.move(0, 0, 5, 0, 3);
  const view = room.publicState();
  assert.equal(view.moveNumber, 1);
  assert.equal(view.revision, 1);
  assert.equal(view.turn, 'black');
  assert.equal(view.winner, null);
  assert.equal(view.captured.length, 0);
  assert.equal(view.lastMove.type, 'reveal-king');
  assert.equal(view.lastAction.type, 'reveal-king');
  assert.equal(view.lastAction.targetName, '将');
  assert.equal(view.lastAction.targetColor, 'black');
  assert.match(view.lastAction.pieceId, /^p_[A-Za-z0-9_-]+$/);
  assert.match(view.lastAction.targetId, /^p_[A-Za-z0-9_-]+$/);
  const attacker = view.pieces.find(piece => piece.x === 0 && piece.y === 5);
  const king = view.pieces.find(piece => piece.x === 0 && piece.y === 3);
  assert.equal(attacker.faceUp, false);
  assert.equal(Object.hasOwn(attacker, 'kind'), false);
  assert.equal(Object.hasOwn(attacker, 'color'), false);
  assert.equal(king.faceUp, true);
  assert.equal(king.kind, 'king');
  assert.equal(king.color, 'black');
  assert.equal(view.lastAction.pieceId, attacker.id);
  assert.equal(view.lastAction.targetId, king.id);
  assert.equal(view.lastMove.targetId, king.id);
  assert.equal(view.lastMove.fromX, 0);
  assert.equal(view.lastMove.toY, 3);
  assert.equal(Object.hasOwn(view.lastAction, 'pieceName'), false);
  assert.equal(Object.hasOwn(view.lastAction, 'pieceColor'), false);
  assert.equal(Object.hasOwn(view.lastMove, 'pieceName'), false);
  rawIdsAbsent(view);

  room.move(1, 8, 0, 8, 1);
  const reply = room.publicState();
  assert.equal(reply.moveNumber, 2);
  assert.equal(reply.revision, 2);
  assert.equal(reply.lastMove.type, 'move');
  assert.equal(reply.lastMove.pieceName, '卒');
  assert.equal(reply.lastMove.capturedName, null);

  room.move(0, 0, 5, 0, 3);
  const ended = room.publicState();
  assert.equal(ended.moveNumber, 3);
  assert.equal(ended.revision, 3);
  assert.equal(ended.winner, 'red');
  assert.equal(ended.endReason, 'king-captured');
  assert.equal(ended.captured.length, 1);
  assert.equal(ended.captured[0].kind, 'king');
  assert.equal(ended.lastMove.type, 'move');
  assert.equal(ended.lastMove.capturedName, '将');
  rawIdsAbsent(ended);
});

test('a real own-color concealed king is also protected: it only reveals, consumes a turn, and does not end the game', () => {
  const room = roomWith(friendlyKingState);
  room.move(0, 0, 5, 0, 3);
  const view = room.publicState();
  assert.equal(view.moveNumber, 1);
  assert.equal(view.revision, 1);
  assert.equal(view.turn, 'black');
  assert.equal(view.winner, null);
  assert.equal(view.endReason, null);
  assert.equal(view.captured.length, 0);
  assert.equal(view.lastAction.type, 'reveal-king');
  assert.equal(view.lastAction.targetColor, 'red');
  assert.equal(view.lastAction.targetName, '帅');
  const king = view.pieces.find(piece => piece.x === 0 && piece.y === 3);
  assert.equal(king.faceUp, true);
  assert.equal(king.color, 'red');
  const attacker = view.pieces.find(piece => piece.x === 0 && piece.y === 5);
  assert.equal(attacker.faceUp, false);
  rawIdsAbsent(view);
});

test('two real WebSocket clients receive the same reveal-king event, cannot move twice, and can capture the revealed king later', async () => {
  const server = await startChessServer({
    host: '127.0.0.1', port: 0, quiet: true, initialStateFactory: enemyKingState
  });
  let host = null;
  let guest = null;
  try {
    const joined = await joinRoom(server);
    host = joined.host;
    guest = joined.guest;
    const initial = joined.hostPlaying;
    assert.equal(initial.state.revision, 0);
    assert.equal(initial.state.lastAction, null);
    assert.deepEqual(initial.state, joined.guestPlaying.state);

    host.send({ type: 'move', fromX: 0, fromY: 5, toX: 0, toY: 3 });
    const hostReveal = await host.waitFor(message => message.type === 'room' && message.state.moveNumber === 1);
    const guestReveal = await guest.waitFor(message => message.type === 'room' && message.state.moveNumber === 1);
    assert.deepEqual(hostReveal.state, guestReveal.state);
    const state = hostReveal.state;
    assert.equal(state.revision, 1);
    assert.equal(state.turn, 'black');
    assert.equal(state.winner, null);
    assert.equal(hostReveal.status, 'playing');
    assert.equal(hostReveal.paused, false);
    assert.equal(state.captured.length, 0);
    assert.equal(state.lastMove.type, 'reveal-king');
    assert.equal(state.lastAction.type, 'reveal-king');
    assert.equal(state.lastAction.targetName, '将');
    const king = state.pieces.find(piece => piece.x === 0 && piece.y === 3);
    const attacker = state.pieces.find(piece => piece.x === 0 && piece.y === 5);
    assert.equal(king.faceUp, true);
    assert.equal(king.kind, 'king');
    assert.equal(state.lastAction.targetId, king.id);
    assert.equal(state.lastAction.pieceId, attacker.id);
    assert.match(king.id, /^p_[A-Za-z0-9_-]+$/);
    assert.equal(attacker.faceUp, false);
    assert.equal(Object.hasOwn(attacker, 'kind'), false);
    assert.equal(Object.hasOwn(attacker, 'color'), false);
    assert.equal(Object.hasOwn(state.lastAction, 'pieceName'), false);
    assert.equal(Object.hasOwn(state.lastAction, 'pieceColor'), false);
    assert.equal(Object.hasOwn(state.lastMove, 'pieceName'), false);
    rawIdsAbsent(state);

    host.send({ type: 'move', fromX: 0, fromY: 5, toX: 0, toY: 4 });
    const turnError = await host.waitFor(message => message.type === 'error');
    assert.equal(turnError.code, 'NOT_YOUR_TURN');
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(host.queue.some(message => message.type === 'room' && message.state.moveNumber > 1), false);

    guest.send({ type: 'move', fromX: 8, fromY: 0, toX: 8, toY: 1 });
    const hostReply = await host.waitFor(message => message.type === 'room' && message.state.moveNumber === 2);
    const guestReply = await guest.waitFor(message => message.type === 'room' && message.state.moveNumber === 2);
    assert.deepEqual(hostReply.state, guestReply.state);
    assert.equal(hostReply.state.revision, 2);
    assert.equal(hostReply.state.turn, 'red');
    assert.equal(hostReply.state.lastMove.type, 'move');

    host.send({ type: 'move', fromX: 0, fromY: 5, toX: 0, toY: 3 });
    const hostEnd = await host.waitFor(message => message.type === 'room' && message.status === 'ended');
    const guestEnd = await guest.waitFor(message => message.type === 'room' && message.status === 'ended');
    assert.deepEqual(hostEnd.state, guestEnd.state);
    assert.equal(hostEnd.state.revision, 3);
    assert.equal(hostEnd.state.winner, 'red');
    assert.equal(hostEnd.state.endReason, 'king-captured');
    assert.equal(hostEnd.state.captured.length, 1);
    assert.equal(hostEnd.state.captured[0].kind, 'king');
    assert.equal(hostEnd.state.lastMove.type, 'move');
    assert.equal(hostEnd.state.lastMove.capturedName, '将');
    rawIdsAbsent(hostEnd.state);
  } finally {
    if (host) await host.close();
    if (guest) await guest.close();
    await server.close();
  }
});

test('two real WebSocket clients also sync a protected own-color concealed king without leaking the attacker', async () => {
  const server = await startChessServer({
    host: '127.0.0.1', port: 0, quiet: true, initialStateFactory: friendlyKingState
  });
  let host = null;
  let guest = null;
  try {
    const joined = await joinRoom(server);
    host = joined.host;
    guest = joined.guest;
    host.send({ type: 'move', fromX: 0, fromY: 5, toX: 0, toY: 3 });
    const hostReveal = await host.waitFor(message => message.type === 'room' && message.state.moveNumber === 1);
    const guestReveal = await guest.waitFor(message => message.type === 'room' && message.state.moveNumber === 1);
    assert.deepEqual(hostReveal.state, guestReveal.state);
    assert.equal(hostReveal.state.turn, 'black');
    assert.equal(hostReveal.state.winner, null);
    assert.equal(hostReveal.state.lastAction.type, 'reveal-king');
    assert.equal(hostReveal.state.lastAction.targetColor, 'red');
    assert.equal(hostReveal.state.captured.length, 0);
    const attacker = hostReveal.state.pieces.find(piece => piece.x === 0 && piece.y === 5);
    assert.equal(attacker.faceUp, false);
    assert.equal(Object.hasOwn(attacker, 'kind'), false);
    rawIdsAbsent(hostReveal.state);
  } finally {
    if (host) await host.close();
    if (guest) await guest.close();
    await server.close();
  }
});
