'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const E = require('../src/game-engine.js');
const { startChessServer } = require('../server/server.cjs');

async function scenario(run) {
  const server = await startChessServer({ host: '127.0.0.1', port: 0, quiet: true });
  const clients = [];
  async function connect() {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const queue = [], waiters = [];
    socket.on('message', raw => {
      const value = JSON.parse(String(raw));
      const i = waiters.findIndex(w => w.predicate(value));
      if (i < 0) queue.push(value);
      else { const w = waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.resolve(value); }
    });
    const client = {
      socket, queue,
      send: value => socket.send(JSON.stringify(value)),
      wait(predicate) {
        const i = queue.findIndex(predicate);
        if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
        return new Promise((resolve, reject) => {
          const w = { predicate, resolve, timer: setTimeout(() => {
            waiters.splice(waiters.indexOf(w), 1);
            reject(new Error('message timeout'));
          }, 4000) };
          waiters.push(w);
        });
      },
      async close() {
        if (socket.readyState === WebSocket.CLOSED) return;
        const closed = once(socket, 'close'); socket.close(); await closed;
      }
    };
    clients.push(client);
    await once(socket, 'open');
    await client.wait(m => m.type === 'welcome');
    return client;
  }
  try { await run({ server, connect }); }
  finally { await Promise.all(clients.map(c => c.close())); await server.close(); }
}
const status = value => m => m.type === 'matchStatus' && m.status === value;
const joined = m => m.type === 'joined';

test('FIFO matching produces an authoritative game with hidden identities, synchronized moves, reconnect and room guards', async () => {
  await scenario(async ({ connect, server }) => {
    const a = await connect(), b = await connect();
    a.send({ type: 'findMatch' }); await a.wait(status('waiting'));
    // Repeated clicks must neither create a self-match nor duplicate a queue entry.
    a.send({ type: 'findMatch' }); await a.wait(status('waiting'));
    assert.equal(server.manager.rooms.size, 0);
    b.send({ type: 'findMatch' });
    await a.wait(status('matched')); await b.wait(status('matched'));
    const first = await a.wait(joined), second = await b.wait(joined);
    assert.equal(first.roomCode, second.roomCode);
    assert.equal(first.seat, 0); assert.equal(second.seat, 1);
    const roomA = await a.wait(m => m.type === 'room' && m.status === 'playing');
    const roomB = await b.wait(m => m.type === 'room' && m.status === 'playing');
    assert.deepEqual(roomA.state, roomB.state);
    assert.ok(roomA.state.pieces.every(p => !Object.hasOwn(p, 'kind') && !Object.hasOwn(p, 'color')));
    assert.equal(server.manager.rooms.size, 1);
    b.send({ type: 'findMatch' });
    assert.equal((await b.wait(m => m.type === 'error')).code, 'ALREADY_IN_ROOM');
    const piece = roomA.state.pieces.find(p => E.legalMoves(roomA.state, p.x, p.y).length);
    const to = E.legalMoves(roomA.state, piece.x, piece.y)[0];
    const move = { type: 'move', fromX: piece.x, fromY: piece.y, toX: to.x, toY: to.y };
    b.send(move); assert.equal((await b.wait(m => m.type === 'error')).code, 'NOT_YOUR_TURN');
    a.send(move);
    const afterA = await a.wait(m => m.type === 'room' && m.state.moveNumber === 1);
    const afterB = await b.wait(m => m.type === 'room' && m.state.moveNumber === 1);
    assert.deepEqual(afterA.state, afterB.state);
    await a.close();
    await b.wait(m => m.type === 'room' && m.paused);
    const rejoin = await connect();
    rejoin.send({ type: 'reconnect', roomCode: first.roomCode, token: first.token });
    assert.equal((await rejoin.wait(joined)).reconnected, true);
    const resumed = await rejoin.wait(m => m.type === 'room' && !m.paused);
    assert.equal(resumed.state.moveNumber, 1);
    b.send({ type: 'cancelMatch' });
    assert.equal((await b.wait(status('matched'))).cancelled, false);
    assert.equal(server.manager.getRoom(first.roomCode).bothConnected(), true);
  });
});

test('cancelled and disconnected players never become ghost opponents; private rooms stay out of matching', async () => {
  await scenario(async ({ connect, server }) => {
    const privateHost = await connect(); privateHost.send({ type: 'createRoom' });
    const invitation = await privateHost.wait(joined);
    const cancelled = await connect(); cancelled.send({ type: 'findMatch' }); await cancelled.wait(status('waiting'));
    cancelled.send({ type: 'cancelMatch' }); await cancelled.wait(status('cancelled'));
    const gone = await connect(); gone.send({ type: 'findMatch' }); await gone.wait(status('waiting')); await gone.close();
    const a = await connect(); a.send({ type: 'findMatch' }); await a.wait(status('waiting'));
    assert.equal(server.manager.rooms.size, 1);
    const b = await connect(); b.send({ type: 'findMatch' });
    const pair = await a.wait(joined); assert.equal((await b.wait(joined)).roomCode, pair.roomCode);
    assert.notEqual(pair.roomCode, invitation.roomCode);
    assert.equal(server.manager.getRoom(invitation.roomCode).occupiedSeats(), 1);
    // A queued player may deliberately switch to an invitation; remove them atomically.
    cancelled.send({ type: 'findMatch' }); await cancelled.wait(status('waiting'));
    cancelled.send({ type: 'joinRoom', roomCode: invitation.roomCode });
    assert.equal((await cancelled.wait(joined)).roomCode, invitation.roomCode);
    const c = await connect(); c.send({ type: 'findMatch' }); await c.wait(status('waiting'));
    assert.equal(server.manager.rooms.size, 2);
  });
});
