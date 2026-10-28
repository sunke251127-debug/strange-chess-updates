'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/game-engine.js');
const { GameRoom } = require('../server/game-room.cjs');
const copy = value => JSON.parse(JSON.stringify(value));
function piece(id, kind, color, x, y, faceUp = true) {
  return { id, kind, color, x, y, faceUp, slotKind: kind, slotColor: color };
}
function position() {
  return { version: 1, pieces: [piece('private-attacker', 'rook', 'red', 0, 5), piece('private-target', 'pawn', 'black', 0, 3, false), piece('private-red-king', 'king', 'red', 4, 9), piece('private-black-king', 'king', 'black', 4, 0)],
    turn: 'red', winner: null, endReason: null, moveNumber: 0, lastMove: null, captured: [] };
}
function room(factory = position) {
  const value = new GameRoom('ABCDEF', { initialStateFactory: factory });
  value.addPlayer('host'); value.addPlayer('guest'); return value;
}
function play(value) {
  const selected = value.game.pieces.find(p => E.owner(p) === value.game.turn && E.legalMoves(value.game, p.x, p.y).length);
  const move = E.legalMoves(value.game, selected.x, selected.y)[0];
  value.move(value.game.turn === 'red' ? 0 : 1, selected.x, selected.y, move.x, move.y);
}
function samePosition(actual, expected) {
  const left = copy(actual), right = copy(expected); delete left.revision; delete right.revision;
  assert.deepEqual(left, right);
}

test('midgame restart preserves the position until the other player explicitly accepts, and a refusal permits normal play', () => {
  const value = room(); play(value);
  const before = copy(value.game), initialCount = value.gameCount;
  let request = value.requestRestart(0);
  assert.deepEqual(value.game, before); assert.equal(value.gameCount, initialCount);
  assert.equal(value.requestRestart(0).id, request.id);
  assert.throws(() => value.respondRestart(0, true, request.id), { code: 'SELF_ACCEPT_NOT_ALLOWED' });
  assert.throws(() => value.requestUndo(1), { code: 'ACTION_PENDING' });
  assert.equal(value.respondRestart(1, false, request.id).restarted, false);
  assert.deepEqual(value.game, before); assert.equal(value.publicView().pendingAction, null);
  play(value); assert.equal(value.game.moveNumber, 2);
  request = value.requestRestart(1);
  assert.equal(value.respondRestart(0, true, request.id).restarted, true);
  assert.equal(value.game.moveNumber, 0); assert.equal(value.gameCount, initialCount + 1);
  assert.equal(value.publicView().canUndo, false); assert.equal(value.publicView().pendingAction, null);
});

test('consensual undo restores captured and concealed pieces, turn and move number without publishing private history', () => {
  const value = room(), before = copy(value.game), ids = copy(value.publicView().state.pieces.map(p => p.id));
  assert.throws(() => value.requestUndo(0), { code: 'NO_UNDO_HISTORY' });
  value.move(0, 0, 5, 0, 3);
  assert.equal(value.game.captured.length, 1);
  const after = copy(value.game), request = value.requestUndo(0);
  assert.deepEqual(value.game, after);
  const view = value.publicView();
  assert.equal(view.pendingAction.kind, 'undo'); assert.equal(view.canUndo, true);
  for (const privateField of ['history', 'publicIds', 'private-target', 'private-attacker']) assert.equal(JSON.stringify(view).includes(privateField), false, privateField);
  assert.throws(() => value.respondUndo(0, true, request.id), { code: 'SELF_ACCEPT_NOT_ALLOWED' });
  assert.equal(value.respondUndo(1, true, request.id).undone, true);
  samePosition(value.game, before); assert.ok(value.game.revision > after.revision);
  const restored = value.publicView();
  assert.deepEqual(restored.state.pieces.map(p => p.id), ids);
  assert.equal(restored.state.captured.length, 0);
  const hidden = restored.state.pieces.find(p => !p.faceUp);
  assert.equal(Object.hasOwn(hidden, 'kind'), false); assert.equal(Object.hasOwn(hidden, 'color'), false);
  assert.equal(restored.canUndo, false);
});

test('the guest may request undo, refusal preserves the full board and the next turn remains playable', () => {
  const value = room(); play(value); play(value);
  const before = copy(value.game), request = value.requestUndo(1);
  assert.equal(value.respondUndo(0, false, request.id).undone, false);
  assert.deepEqual(value.game, before);
  play(value); assert.equal(value.game.moveNumber, 3);
  const next = value.requestUndo(1);
  value.respondUndo(0, true, next.id); samePosition(value.game, before);
});

test('moving invalidates a request and delayed, missing or mismatched responses cannot alter a later request', () => {
  const value = room(); play(value);
  const old = value.requestUndo(0); play(value);
  assert.equal(value.publicView().pendingAction, null);
  const current = value.requestUndo(0), before = copy(value.game);
  assert.notEqual(current.id, old.id);
  assert.throws(() => value.respondUndo(1, true, old.id), { code: 'STALE_REQUEST' });
  assert.throws(() => value.respondUndo(1, true), { code: 'STALE_REQUEST' });
  assert.throws(() => value.respondUndo(1, 'yes', current.id), /明确同意或拒绝/);
  assert.deepEqual(value.game, before);
  value.respondUndo(1, true, current.id);
  const restored = copy(value.game);
  assert.throws(() => value.respondUndo(1, true, current.id), { code: 'NO_UNDO_PENDING' });
  assert.deepEqual(value.game, restored);
  const restart = value.requestRestart(1);
  assert.throws(() => value.respondRestart(0, true), { code: 'STALE_REQUEST' });
  value.respondRestart(0, false, restart.id);
});

test('only seated connected opponents can approve, and disconnect or leaving expires pending applications', () => {
  const value = room(); play(value);
  assert.throws(() => value.requestRestart(-1), { code: 'NOT_SEATED' });
  const request = value.requestUndo(0);
  assert.throws(() => value.respondUndo(2, true, request.id), { code: 'NOT_SEATED' });
  const token = value.seats[1].token, before = copy(value.game);
  value.disconnect('guest'); assert.equal(value.publicView().pendingAction, null);
  assert.throws(() => value.respondUndo(1, true, request.id), { code: 'OPPONENT_DISCONNECTED' });
  assert.throws(() => value.requestRestart(0), { code: 'OPPONENT_DISCONNECTED' });
  value.reconnect('guest-again', token);
  assert.throws(() => value.respondUndo(1, true, request.id), { code: 'NO_UNDO_PENDING' });
  assert.deepEqual(value.game, before);
  value.requestRestart(1); value.removePlayer(1); assert.equal(value.publicView().pendingAction, null);
});

test('consent may undo the terminal move and legacy completed-game restart still requires the other player', () => {
  const value = room(() => { const state = position(); state.pieces[1] = piece('private-target', 'king', 'black', 0, 3); state.pieces.pop(); return state; });
  const before = copy(value.game);
  value.move(0, 0, 5, 0, 3); assert.equal(value.status, 'ended');
  const request = value.requestUndo(1); value.respondUndo(0, true, request.id);
  samePosition(value.game, before); assert.equal(value.status, 'playing');
  value.move(0, 0, 5, 0, 3); value.requestRestart(0);
  assert.throws(() => value.respondRestart(0, true), { code: 'SELF_ACCEPT_NOT_ALLOWED' });
  value.respondRestart(1, true); assert.equal(value.status, 'playing'); assert.equal(value.game.moveNumber, 0);
});
