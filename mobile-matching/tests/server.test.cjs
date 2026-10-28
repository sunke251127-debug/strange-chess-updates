'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { WebSocket } = require('ws');
const E = require('../src/game-engine.js');
const { startChessServer } = require('../server/server.cjs');
const { RoomManager } = require('../server/game-room.cjs');

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class TestClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.queue = [];
    this.waiters = [];
    this.closed = false;
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), 4000);
      this.ws.once('open', () => {
        clearTimeout(timer);
        resolve(this);
      });
      this.ws.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      this.ws.on('message', data => {
        let message;
        try {
          message = JSON.parse(String(data));
        } catch {
          return;
        }
        const waiterIndex = this.waiters.findIndex(waiter => waiter.predicate(message));
        if (waiterIndex >= 0) {
          const [waiter] = this.waiters.splice(waiterIndex, 1);
          clearTimeout(waiter.timer);
          waiter.resolve(message);
          return;
        }
        this.queue.push(message);
      });
      this.ws.on('close', () => {
        this.closed = true;
        for (const waiter of this.waiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error('socket closed while waiting for message'));
        }
      });
    });
  }

  waitFor(predicate, timeout = 4000) {
    const queueIndex = this.queue.findIndex(predicate);
    if (queueIndex >= 0) {
      const [message] = this.queue.splice(queueIndex, 1);
      return Promise.resolve(message);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error('timed out waiting for websocket message'));
        }, timeout)
      };
      this.waiters.push(waiter);
    });
  }

  send(payload) {
    this.ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
  }

  async close() {
    if (!this.ws || this.closed) return;
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 800);
      this.ws.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.close();
    });
  }

  terminate() {
    if (this.ws) this.ws.terminate();
  }
}

async function withServer(fn, options = {}) {
  const server = await startChessServer({
    host: '127.0.0.1',
    port: 0,
    quiet: true,
    ...options
  });
  const wsUrl = `ws://127.0.0.1:${server.port}/ws`;
  const clients = [];
  const connect = async () => {
    const client = new TestClient(wsUrl);
    clients.push(client);
    await client.open();
    return client;
  };
  try {
    return await fn({ server, wsUrl, connect, clients });
  } finally {
    await Promise.all(clients.map(client => client.close()));
    await server.close();
  }
}

async function createJoinedRoom(connect) {
  const host = await connect();
  host.send({ type: 'createRoom' });
  const hostJoined = await host.waitFor(message => message.type === 'joined');
  const hostWaiting = await host.waitFor(message => message.type === 'room' && message.status === 'waiting');

  const guest = await connect();
  guest.send({ type: 'joinRoom', roomCode: hostJoined.roomCode });
  const guestJoined = await guest.waitFor(message => message.type === 'joined');
  const hostPlaying = await host.waitFor(message => message.type === 'room' && message.status === 'playing');
  const guestPlaying = await guest.waitFor(message => message.type === 'room' && message.status === 'playing');
  return { host, guest, hostJoined, guestJoined, hostWaiting, hostPlaying, guestPlaying };
}

function findLegalMove(state) {
  for (const piece of state.pieces) {
    const moves = E.legalMoves(state, piece.x, piece.y);
    if (moves.length) return { piece, to: moves[0] };
  }
  throw new Error('no legal move found');
}

function publicIdsAreOpaque(state) {
  return state.pieces.every(piece => typeof piece.id === 'string' && /^p_[A-Za-z0-9_-]{10,}$/.test(piece.id));
}

test('two real WebSocket clients join, hide identities, move in sync, and reject a full third player', async () => {
  await withServer(async ({ server, connect }) => {
    const { host, guest, hostJoined, guestJoined, hostPlaying, guestPlaying } = await createJoinedRoom(connect);

    assert.equal(hostJoined.seat, 0);
    assert.equal(hostJoined.color, 'red');
    assert.equal(guestJoined.seat, 1);
    assert.equal(guestJoined.color, 'black');
    assert.equal(hostPlaying.state.pieces.length, 32);
    assert.deepEqual(hostPlaying.state, guestPlaying.state);

    for (const piece of hostPlaying.state.pieces) {
      assert.equal(piece.faceUp, false);
      assert.equal(Object.hasOwn(piece, 'kind'), false);
      assert.equal(Object.hasOwn(piece, 'color'), false);
      assert.ok(piece.slotKind);
      assert.ok(piece.slotColor);
    }
    assert.ok(publicIdsAreOpaque(hostPlaying.state));
    const publicIds = hostPlaying.state.pieces.map(piece => piece.id);
    assert.equal(new Set(publicIds).size, 32);

    const room = server.manager.getRoom(hostJoined.roomCode);
    const rawIds = room.game.pieces.map(piece => piece.id);
    assert.equal(publicIds.some(id => rawIds.some(raw => String(raw) === id)), false);
    assert.equal(JSON.stringify(hostPlaying.state).includes('"capturedName"'), false);

    const move = findLegalMove(hostPlaying.state);
    assert.equal(move.piece.slotColor, 'red');
    host.send({ type: 'move', fromX: move.piece.x, fromY: move.piece.y, toX: move.to.x, toY: move.to.y });
    const hostAfter = await host.waitFor(message => message.type === 'room' && message.state.moveNumber === 1);
    const guestAfter = await guest.waitFor(message => message.type === 'room' && message.state.moveNumber === 1);
    assert.deepEqual(hostAfter.state, guestAfter.state);
    assert.equal(hostAfter.state.turn, 'black');
    const revealed = hostAfter.state.pieces.find(piece => piece.x === move.to.x && piece.y === move.to.y);
    assert.equal(revealed.faceUp, true);
    assert.ok(revealed.kind);
    assert.ok(revealed.color);
    assert.equal(hostAfter.state.pieces.filter(piece => !piece.faceUp).every(piece => !Object.hasOwn(piece, 'kind')), true);
    assert.match(hostAfter.state.lastMove.pieceId, /^p_[A-Za-z0-9_-]+$/);
    assert.equal(rawIds.some(raw => String(raw) === hostAfter.state.lastMove.pieceId), false);

    const fullRoom = await connect();
    fullRoom.send({ type: 'joinRoom', roomCode: hostJoined.roomCode });
    const fullError = await fullRoom.waitFor(message => message.type === 'error');
    assert.equal(fullError.code, 'ROOM_FULL');
  });
});

test('server rejects wrong turns, illegal targets, malformed input, and preserves the room state', async () => {
  await withServer(async ({ server, connect }) => {
    const { host, guest, hostPlaying } = await createJoinedRoom(connect);
    const before = JSON.stringify(hostPlaying.state);
    const roomCode = hostPlaying.roomCode;

    const move = findLegalMove(hostPlaying.state);
    guest.send({ type: 'move', fromX: move.piece.x, fromY: move.piece.y, toX: move.to.x, toY: move.to.y });
    const wrongTurn = await guest.waitFor(message => message.type === 'error');
    assert.equal(wrongTurn.code, 'NOT_YOUR_TURN');

    host.send({ type: 'move', fromX: 0, fromY: 9, toX: 99, toY: 99 });
    const illegal = await host.waitFor(message => message.type === 'error');
    assert.equal(illegal.code, 'ILLEGAL_MOVE');

    host.send({ type: 'move', fromX: '0', fromY: 9, toX: 0, toY: 8 });
    const badCoordinates = await host.waitFor(message => message.type === 'error');
    assert.equal(badCoordinates.code, 'BAD_COORDINATES');

    host.send('{not valid json');
    const badJson = await host.waitFor(message => message.type === 'error');
    assert.equal(badJson.code, 'BAD_JSON');

    host.send(JSON.stringify({ type: 'move', padding: 'x'.repeat(5000) }));
    const tooLarge = await host.waitFor(message => message.type === 'error');
    assert.equal(tooLarge.code, 'MESSAGE_TOO_LARGE');

    host.send({ type: 'ping' });
    const pong = await host.waitFor(message => message.type === 'pong');
    assert.equal(pong.type, 'pong');

    const room = server.manager.getRoom(roomCode);
    assert.equal(room.game.moveNumber, 0);
    assert.equal(JSON.stringify(room.publicState()), before);
    await wait(80);
    assert.equal(host.queue.some(message => message.type === 'room' && message.state.moveNumber > 0), false);
  });
});

test('a disconnected player pauses play; token reconnect restores the same seat, then leaving closes the room', async () => {
  await withServer(async ({ connect }) => {
    const { host, guest, guestJoined, hostPlaying } = await createJoinedRoom(connect);
    guest.terminate();

    const paused = await host.waitFor(message =>
      message.type === 'room' && message.players[1] && message.players[1].connected === false
    );
    assert.equal(paused.paused, true);
    assert.equal(paused.bothConnected, false);

    const move = findLegalMove(hostPlaying.state);
    host.send({ type: 'move', fromX: move.piece.x, fromY: move.piece.y, toX: move.to.x, toY: move.to.y });
    const disconnectedError = await host.waitFor(message => message.type === 'error');
    assert.equal(disconnectedError.code, 'OPPONENT_DISCONNECTED');

    const reconnectedGuest = await connect();
    reconnectedGuest.send({ type: 'reconnect', roomCode: guestJoined.roomCode, token: guestJoined.token });
    const reconnectedJoined = await reconnectedGuest.waitFor(message => message.type === 'joined');
    assert.equal(reconnectedJoined.reconnected, true);
    assert.equal(reconnectedJoined.seat, 1);
    const resumed = await host.waitFor(message =>
      message.type === 'room' && message.bothConnected === true && message.state.moveNumber === 0
    );
    assert.equal(resumed.players[1].connected, true);

    host.send({ type: 'move', fromX: move.piece.x, fromY: move.piece.y, toX: move.to.x, toY: move.to.y });
    const synchronizedGuest = await reconnectedGuest.waitFor(message => message.type === 'room' && message.state.moveNumber === 1);
    const synchronizedHost = await host.waitFor(message => message.type === 'room' && message.state.moveNumber === 1);
    assert.deepEqual(synchronizedGuest.state, synchronizedHost.state);

    reconnectedGuest.send({ type: 'leaveRoom' });
    const left = await reconnectedGuest.waitFor(message => message.type === 'left');
    assert.equal(left.type, 'left');
    const closed = await host.waitFor(message => message.type === 'roomClosed');
    assert.match(closed.message, /离开/);
  });
});

function terminalState() {
  return {
    version: 1,
    pieces: [
      { id: 1, kind: 'rook', color: 'red', x: 0, y: 5, faceUp: true, slotKind: 'rook', slotColor: 'red' },
      { id: 2, kind: 'king', color: 'black', x: 0, y: 3, faceUp: true, slotKind: 'king', slotColor: 'black' },
      { id: 3, kind: 'pawn', color: 'black', x: 8, y: 9, faceUp: true, slotKind: 'pawn', slotColor: 'black' }
    ],
    turn: 'red',
    winner: null,
    endReason: null,
    moveNumber: 0,
    lastMove: null,
    captured: []
  };
}

test('end-to-end king capture ends the room, blocks further moves, and restart requires both players', async () => {
  await withServer(async ({ connect }) => {
    const { host, guest, hostPlaying, guestPlaying } = await createJoinedRoom(connect);
    assert.deepEqual(hostPlaying.state, guestPlaying.state);

    host.send({ type: 'move', fromX: 0, fromY: 5, toX: 0, toY: 3 });
    const hostEnded = await host.waitFor(message => message.type === 'room' && message.status === 'ended');
    const guestEnded = await guest.waitFor(message => message.type === 'room' && message.status === 'ended');
    assert.deepEqual(hostEnded.state, guestEnded.state);
    assert.equal(hostEnded.state.winner, 'red');
    assert.equal(hostEnded.state.endReason, 'king-captured');
    assert.equal(hostEnded.state.captured.length, 1);
    assert.equal(hostEnded.state.captured[0].kind, 'king');

    host.send({ type: 'move', fromX: 0, fromY: 3, toX: 0, toY: 2 });
    const endedError = await host.waitFor(message => message.type === 'error');
    assert.equal(endedError.code, 'NOT_PLAYING');

    host.send({ type: 'requestRestart' });
    const hostPending = await host.waitFor(message => message.type === 'room' && message.pendingRestart);
    const guestPending = await guest.waitFor(message => message.type === 'room' && message.pendingRestart);
    assert.equal(hostPending.pendingRestart.requestedBy, 0);
    assert.equal(guestPending.status, 'ended');

    host.send({ type: 'respondRestart', accept: true });
    const selfAccept = await host.waitFor(message => message.type === 'error');
    assert.equal(selfAccept.code, 'SELF_ACCEPT_NOT_ALLOWED');

    guest.send({ type: 'respondRestart', accept: true });
    const hostRestarted = await host.waitFor(message => message.type === 'room' && message.status === 'playing' && message.pendingRestart === null);
    const guestRestarted = await guest.waitFor(message => message.type === 'room' && message.status === 'playing' && message.pendingRestart === null);
    assert.deepEqual(hostRestarted.state, guestRestarted.state);
    assert.equal(hostRestarted.state.moveNumber, 0);
    assert.equal(hostRestarted.state.winner, null);
    assert.equal(hostRestarted.state.pieces.length, 3);
  }, { initialStateFactory: terminalState });
});

test('HTTP server serves the debug UI and its engine script', async () => {
  await withServer(async ({ server }) => {
    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /根本就没有这样的象棋/);
    assert.match(html, /boardGrid/);
    const engineResponse = await fetch(`http://127.0.0.1:${server.port}/src/game-engine.js`);
    assert.equal(engineResponse.status, 200);
    assert.match(engineResponse.headers.get('content-type') || '', /javascript/);
    assert.match(await engineResponse.text(), /StrangeChess/);
    const infoResponse = await fetch(`http://127.0.0.1:${server.port}/api/info`);
    const info = await infoResponse.json();
    assert.equal(info.port, server.port);
    assert.equal(info.status, 'ok');
    assert.equal(info.websocketPath, '/ws');
  });
});

test('an occupied preferred port falls back to the next usable port', async () => {
  const blocker = net.createServer();
  const occupiedPort = await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', () => resolve(blocker.address().port));
  });
  let server = null;
  try {
    server = await startChessServer({
      host: '127.0.0.1',
      port: occupiedPort,
      portAttempts: 20,
      quiet: true
    });
    assert.notEqual(server.port, occupiedPort);
    const response = await fetch(`http://127.0.0.1:${server.port}/health`);
    assert.equal(response.status, 200);
  } finally {
    if (server) await server.close();
    await new Promise(resolve => blocker.close(() => resolve()));
  }
});

test('room manager cleans abandoned and expired rooms', () => {
  const manager = new RoomManager();
  const abandoned = manager.createRoom();
  abandoned.addPlayer('socket-a');
  abandoned.updatedAt = Date.now() - 16 * 60 * 1000;
  abandoned.seats[0].connected = false;
  const waiting = manager.createRoom();
  waiting.addPlayer('socket-b');
  waiting.updatedAt = Date.now() - 31 * 60 * 1000;
  const fresh = manager.createRoom();
  fresh.addPlayer('socket-c');
  assert.equal(manager.rooms.size, 3);
  const removed = manager.cleanup();
  assert.equal(removed, 2);
  assert.equal(manager.getRoom(abandoned.code), null);
  assert.equal(manager.getRoom(waiting.code), null);
  assert.ok(manager.getRoom(fresh.code));
});
