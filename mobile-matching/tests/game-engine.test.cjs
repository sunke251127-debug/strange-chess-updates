const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/game-engine.js');

function seed(n) {
  return () => { n = (1664525 * n + 1013904223) >>> 0; return n / 4294967296; };
}
function piece(id, kind, color, x, y, extra = {}) {
  return { id, kind, color, x, y, faceUp: true, slotKind: kind, slotColor: color, ...extra };
}
function board(pieces, turn = 'red') {
  return { version: 1, pieces, turn, winner: null, endReason: null, moveNumber: 0, lastMove: null, captured: [] };
}

test('32 pieces start face down on standard 32 positions with both kings and 16 identities per color', () => {
  const s = E.createGame(seed(42));
  assert.equal(s.pieces.length, 32);
  assert.equal(new Set(s.pieces.map(p => `${p.x},${p.y}`)).size, 32);
  assert.equal(s.pieces.filter(p => p.faceUp).length, 0);
  for (const color of ['red', 'black']) {
    assert.equal(s.pieces.filter(p => p.color === color).length, 16);
    assert.equal(s.pieces.filter(p => p.color === color && p.kind === 'king').length, 1);
  }
  assert(s.pieces.some(p => p.color !== p.slotColor));
  assert.deepEqual(s, E.createGame(seed(42)));
  assert.notDeepEqual(s.pieces.map(p => p.id), E.createGame(seed(43)).pieces.map(p => p.id));
});

test('a concealed pawn position moves as pawn, reveals after arrival, and becomes its true color', () => {
  const p = piece(1, 'rook', 'black', 4, 6, { faceUp: false, slotKind: 'pawn', slotColor: 'red' });
  const s = board([p, piece(2, 'king', 'black', 8, 0), piece(3, 'king', 'red', 0, 9)]);
  const before = JSON.stringify(s);
  assert.equal(E.move(s, 4, 6, 3, 6).ok, false);
  const result = E.move(s, 4, 6, 4, 5);
  assert(result.ok);
  assert.equal(JSON.stringify(s), before, 'transition must preserve undo snapshot');
  assert.equal(E.at(result.state, 4, 5).faceUp, true);
  assert.equal(E.owner(E.at(result.state, 4, 5)), 'black');
  assert.equal(result.state.turn, 'black');
  assert.equal(result.state.lastMove.switchedSide, true);
  assert(E.legalMoves(result.state, 4, 5).some(m => m.x === 7 && m.y === 5));
});

test('both generals start concealed and a hidden king position moves without palace boundary', () => {
  const s = E.createGame(seed(5));
  assert.equal(E.at(s, 4, 9).faceUp, false);
  assert(E.legalMoves(s, 4, 9).some(m => m.x === 4 && m.y === 8));
  const p = piece(1, 'pawn', 'black', 4, 4, { faceUp: false, slotKind: 'king', slotColor: 'red' });
  const position = board([p]);
  assert(E.canMove(position, p, 4, 3));
  assert(!E.canMove(position, p, 5, 3));
});

test('exposed generals may cross the river and leave the palace; facing generals is allowed', () => {
  const p = piece(1, 'king', 'red', 4, 5);
  const s = board([p, piece(2, 'king', 'black', 4, 0)]);
  assert(E.canMove(s, p, 4, 4));
  assert(E.canMove(s, p, 3, 5));
  assert(!E.canMove(s, p, 4, 0));
  assert(!E.canMove(s, p, 5, 4));
});

test('rooks cannot cross blockers and cannot capture own apparent camp', () => {
  const p = piece(1, 'rook', 'red', 0, 5);
  const s = board([p, piece(2, 'pawn', 'black', 0, 3), piece(3, 'pawn', 'red', 2, 5)]);
  assert(E.canMove(s, p, 0, 3));
  assert(!E.canMove(s, p, 0, 2));
  assert(!E.canMove(s, p, 2, 5));
  assert(!E.canMove(s, p, 1, 4));
});

test('cannons need exactly one screen to capture, including a concealed target', () => {
  const p = piece(1, 'cannon', 'red', 0, 5);
  const screen = piece(2, 'pawn', 'red', 0, 3);
  const target = piece(3, 'rook', 'red', 0, 0, { faceUp: false, slotColor: 'black' });
  const s = board([p, screen, target]);
  assert(E.canMove(s, p, 0, 4));
  assert(E.canMove(s, p, 0, 0));
  assert(!E.canMove(s, p, 0, 2));
  assert(!E.canMove(board([p, target]), p, 0, 0));
  assert(!E.canMove(board([...s.pieces, piece(4, 'pawn', 'black', 0, 1)]), p, 0, 0));
});

test('horse legs and elephant eyes block movement; elephants and advisors have full-board range', () => {
  const h = piece(1, 'horse', 'red', 4, 5);
  assert(E.canMove(board([h]), h, 6, 4));
  assert(!E.canMove(board([h, piece(2, 'pawn', 'black', 5, 5)]), h, 6, 4));
  const e = piece(3, 'elephant', 'red', 4, 5);
  assert(E.canMove(board([e]), e, 6, 3));
  assert(!E.canMove(board([e, piece(4, 'pawn', 'black', 5, 4)]), e, 6, 3));
  const a = piece(5, 'advisor', 'red', 0, 5);
  assert(E.canMove(board([a]), a, 1, 4));
});

test('pawns move forward and gain sideways moves only after their actual color crosses river', () => {
  for (const [color, y, forward, crossedY] of [['red', 6, -1, 4], ['black', 3, 1, 5]]) {
    const p = piece(1, 'pawn', color, 4, y);
    assert(E.canMove(board([p]), p, 4, y + forward));
    assert(!E.canMove(board([p]), p, 3, y));
    assert(!E.canMove(board([p]), p, 4, y - forward));
    const crossed = { ...p, y: crossedY };
    assert(E.canMove(board([crossed]), crossed, 3, crossedY));
  }
});

// Updated for the user's explicit rule correction: only an exposed enemy general can be captured.
test('capturing an exposed enemy king ends play; an exposed own king cannot be captured', () => {
  const rook = piece(1, 'rook', 'red', 0, 5);
  const king = piece(2, 'king', 'black', 0, 3);
  const s = E.move(board([rook, king]), 0, 5, 0, 3).state;
  assert.equal(s.winner, 'red');
  assert.equal(s.captured[0].faceUp, true);
  assert.equal(s.endReason, 'king-captured');
  assert.deepEqual(E.legalMoves(s, 0, 3), []);
  assert.equal(E.move(s, 0, 3, 1, 3).ok, false);
  const own = { ...king, color: 'red' };
  assert.equal(E.move(board([rook, own]), 0, 5, 0, 3).ok, false);
});

test('invalid turns, out-of-board points and null moves are rejected without mutation', () => {
  const s = E.createGame(seed(3));
  const before = JSON.stringify(s);
  assert.equal(E.move(s, 0, 0, 0, 1).ok, false);
  assert.equal(E.move(s, 0, 6, -1, 6).ok, false);
  assert.equal(E.move(s, 0, 6, 0, 6).ok, false);
  assert.equal(E.move(s, 0, 6, 0.5, 5).ok, false);
  assert.equal(JSON.stringify(s), before);
});

test('a player with no legal moves loses after the preceding move', () => {
  const s = board([piece(1, 'rook', 'red', 0, 8), ...Array.from({ length: 9 }, (_, x) => piece(x + 2, 'pawn', 'black', x, 9))]);
  const result = E.move(s, 0, 8, 0, 7);
  assert(result.ok);
  assert.equal(result.state.winner, 'red');
  assert.equal(result.state.endReason, 'no-legal-moves');
});
