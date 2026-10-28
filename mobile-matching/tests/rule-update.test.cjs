'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/game-engine.js');

function piece(id, kind, color, x, y, extra = {}) {
  return { id, kind, color, x, y, faceUp: true, slotKind: kind, slotColor: color, ...extra };
}
function board(pieces, turn = 'red') {
  return { version: 1, pieces, turn, winner: null, endReason: null, moveNumber: 0, lastMove: null, captured: [] };
}

test('concealed advisor initial points can only step diagonally inside their own palace', () => {
  for (const color of ['red', 'black']) {
    const y = color === 'red' ? 9 : 0;
    const insideY = color === 'red' ? 8 : 1;
    for (const x of [3, 5]) {
      // Real identity and color must not determine a concealed advisor point's first move.
      const p = piece(1, 'rook', E.opposite(color), x, y, { faceUp: false, slotKind: 'advisor', slotColor: color });
      const s = board([p], color);
      assert.deepEqual(E.legalMoves(s, x, y), [{ x: 4, y: insideY }]);
      assert.equal(E.canMove(s, p, x === 3 ? 2 : 6, insideY), false);
    }
  }
});

test('an advisor point at the palace center cannot cross its palace edge', () => {
  for (const [color, y, outerY] of [['red', 7, 6], ['black', 2, 3]]) {
    const p = piece(1, 'pawn', color, 4, y, { faceUp: false, slotKind: 'advisor', slotColor: color });
    assert.equal(E.canMove(board([p], color), p, 3, outerY), false);
    assert.equal(E.canMove(board([p], color), p, 5, outerY), false);
    assert.equal(E.canMove(board([p], color), p, 3, color === 'red' ? 8 : 1), true);
  }
});

test('a revealed advisor still has full-board diagonals, including after its first palace move', () => {
  const p = piece(1, 'advisor', 'red', 3, 9, { faceUp: false });
  const s = board([p, piece(2, 'king', 'black', 8, 0)]);
  const result = E.move(s, 3, 9, 4, 8);
  assert(result.ok);
  const exposed = E.at(result.state, 4, 8);
  assert(exposed.faceUp);
  assert.equal(E.canMove(result.state, { ...exposed, x: 3 }, 2, 7), true);
  const outside = piece(3, 'advisor', 'red', 1, 5);
  assert.equal(E.canMove(board([outside]), outside, 0, 4), true);
});

test('attempting to capture either concealed general only reveals it, consumes one move and changes turn', () => {
  for (const color of ['red', 'black']) {
    const rook = piece(1, 'rook', 'red', 0, 5);
    const king = piece(2, 'king', color, 0, 3, { faceUp: false, slotKind: 'pawn', slotColor: 'black' });
    const s = board([rook, king, piece(3, 'king', 'black', 8, 0)]);
    s.moveNumber = 7;
    s.lastMove = { fromX: 8, fromY: 1, toX: 8, toY: 0, pieceId: 3 };
    const before = JSON.stringify(s);
    const result = E.move(s, 0, 5, 0, 3);
    assert(result.ok);
    const next = result.state;
    assert.equal(JSON.stringify(s), before, 'the previous undo snapshot is unchanged');
    assert.equal(next.pieces.length, s.pieces.length);
    assert.deepEqual(E.at(next, 0, 5), rook);
    assert.equal(E.at(next, 0, 3).faceUp, true);
    assert.equal(E.at(next, 0, 3).kind, 'king');
    assert.equal(next.captured.length, 0);
    assert.equal(next.winner, null);
    assert.equal(next.endReason, null);
    assert.equal(next.turn, 'black', 'the latest user correction makes revealing a general consume one turn');
    assert.equal(next.moveNumber, 8);
    assert.equal(next.revision, 8);
    assert.equal(next.lastMove.type, 'reveal-king');
    assert.equal(next.lastMove.toX, 0);
    assert.equal(next.lastMove.toY, 3);
    assert.equal(next.lastMove.capturedName, null);
    assert.deepEqual(next.lastAction, {
      type: 'reveal-king', color: 'red', pieceId: 1, fromX: 0, fromY: 5, toX: 0, toY: 3,
      targetId: 2, targetColor: color, targetName: color === 'red' ? '帅' : '将'
    });
  }
});

test('after an intervening opponent move the exposed enemy general can be captured normally', () => {
  const rook = piece(1, 'rook', 'red', 0, 5);
  const king = piece(2, 'king', 'black', 0, 3, { faceUp: false, slotKind: 'pawn' });
  const revealed = E.move(board([rook, king, piece(3, 'pawn', 'black', 8, 0)]), 0, 5, 0, 3).state;
  assert.equal(revealed.moveNumber, 1);
  assert.equal(revealed.revision, 1);
  assert.equal(revealed.turn, 'black');
  assert.equal(E.move(revealed, 0, 5, 0, 3).ok, false, 'attacker must wait for its next turn');
  const replied = E.move(revealed, 8, 0, 8, 1).state;
  const captured = E.move(replied, 0, 5, 0, 3).state;
  assert.equal(captured.winner, 'red');
  assert.equal(captured.endReason, 'king-captured');
  assert.equal(captured.moveNumber, 3);
  assert.equal(captured.revision, 3);
  assert.equal(captured.captured.length, 1);
  assert.equal(captured.lastAction.type, 'move');
});

test('a concealed attacker stays concealed and its identity is absent from the reveal event', () => {
  const attacker = piece(1, 'cannon', 'black', 0, 5, { faceUp: false, slotKind: 'rook', slotColor: 'red' });
  const king = piece(2, 'king', 'black', 0, 3, { faceUp: false, slotKind: 'pawn' });
  const s = E.move(board([attacker, king, piece(3, 'pawn', 'black', 8, 0)]), 0, 5, 0, 3).state;
  assert.deepEqual(E.at(s, 0, 5), attacker);
  assert.equal(E.owner(E.at(s, 0, 5)), 'red');
  for (const secret of ['pieceName', 'pieceColor', 'kind']) assert.equal(Object.hasOwn(s.lastAction, secret), false);
  const reply = E.move(s, 8, 0, 8, 1).state;
  const continued = E.move(reply, 0, 5, 1, 5).state;
  assert.equal(E.at(continued, 1, 5).faceUp, true);
  assert.equal(E.at(continued, 1, 5).kind, 'cannon');
  assert.equal(continued.turn, 'black');
  assert.equal(continued.moveNumber, 3);
});

test('illegal captures never expose a concealed general and ordinary concealed targets still get captured', () => {
  const rook = piece(1, 'rook', 'red', 0, 5);
  const king = piece(2, 'king', 'black', 0, 3, { faceUp: false, slotKind: 'pawn' });
  const blocker = piece(3, 'pawn', 'red', 0, 4);
  const s = board([rook, king, blocker]);
  const before = JSON.stringify(s);
  assert.equal(E.move(s, 0, 5, 0, 3).ok, false);
  assert.equal(JSON.stringify(s), before);
  const target = { ...king, kind: 'horse' };
  const ordinary = E.move(board([rook, target, piece(4, 'king', 'black', 8, 0)]), 0, 5, 0, 3).state;
  assert.equal(ordinary.captured.length, 1);
  assert.equal(ordinary.captured[0].kind, 'horse');
  assert.equal(ordinary.turn, 'black');
  assert.equal(ordinary.moveNumber, 1);
});
