(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StrangeChess = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const RED = 'red', BLACK = 'black';
  const BACK = ['rook', 'horse', 'elephant', 'advisor', 'king', 'advisor', 'elephant', 'horse', 'rook'];
  const NAMES = {
    red: { rook: '俥', horse: '傌', elephant: '相', advisor: '仕', king: '帅', cannon: '炮', pawn: '兵' },
    black: { rook: '車', horse: '馬', elephant: '象', advisor: '士', king: '将', cannon: '炮', pawn: '卒' }
  };
  const opposite = color => color === RED ? BLACK : RED;
  const inside = (x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < 9 && y >= 0 && y < 10;
  const at = (state, x, y) => state.pieces.find(p => p.x === x && p.y === y) || null;
  const owner = piece => piece.faceUp ? piece.color : piece.slotColor;
  const kind = piece => piece.faceUp ? piece.kind : piece.slotKind;
  const label = piece => NAMES[piece.color][piece.kind];
  const inPalace = (color, x, y) => x >= 3 && x <= 5 && (color === RED ? y >= 7 && y <= 9 : y >= 0 && y <= 2);

  function slots() {
    const result = [];
    for (const color of [BLACK, RED]) {
      const backY = color === BLACK ? 0 : 9;
      const cannonY = color === BLACK ? 2 : 7;
      const pawnY = color === BLACK ? 3 : 6;
      BACK.forEach((k, x) => result.push({ x, y: backY, slotKind: k, slotColor: color }));
      [1, 7].forEach(x => result.push({ x, y: cannonY, slotKind: 'cannon', slotColor: color }));
      [0, 2, 4, 6, 8].forEach(x => result.push({ x, y: pawnY, slotKind: 'pawn', slotColor: color }));
    }
    return result;
  }

  function createGame(random) {
    const rng = random || Math.random;
    const positions = slots();
    const identities = positions.map((p, id) => ({ id, kind: p.slotKind, color: p.slotColor }));
    for (let i = identities.length - 1; i > 0; i--) {
      const sample = rng();
      if (!(sample >= 0 && sample < 1)) throw new Error('随机数必须处于 [0, 1)');
      const j = Math.floor(sample * (i + 1));
      [identities[i], identities[j]] = [identities[j], identities[i]];
    }
    return {
      version: 1,
      pieces: positions.map((p, i) => Object.assign({}, p, identities[i], { faceUp: false })),
      turn: RED,
      winner: null,
      endReason: null,
      moveNumber: 0,
      revision: 0,
      lastMove: null,
      lastAction: null,
      captured: []
    };
  }

  function countBetween(state, from, x, y) {
    const stepX = Math.sign(x - from.x), stepY = Math.sign(y - from.y);
    let px = from.x + stepX, py = from.y + stepY, count = 0;
    while (px !== x || py !== y) {
      if (at(state, px, py)) count++;
      px += stepX; py += stepY;
    }
    return count;
  }

  function canMove(state, piece, x, y) {
    if (!piece || !inside(x, y) || (piece.x === x && piece.y === y)) return false;
    const target = at(state, x, y);
    if (target && owner(target) === owner(piece)) return false;
    const dx = x - piece.x, dy = y - piece.y, ax = Math.abs(dx), ay = Math.abs(dy);
    switch (kind(piece)) {
      case 'rook':
        return (dx === 0 || dy === 0) && countBetween(state, piece, x, y) === 0;
      case 'cannon':
        return (dx === 0 || dy === 0) && countBetween(state, piece, x, y) === (target ? 1 : 0);
      case 'horse':
        if (ax === 2 && ay === 1) return !at(state, piece.x + Math.sign(dx), piece.y);
        if (ax === 1 && ay === 2) return !at(state, piece.x, piece.y + Math.sign(dy));
        return false;
      case 'elephant':
        return ax === 2 && ay === 2 && !at(state, piece.x + dx / 2, piece.y + dy / 2);
      case 'advisor':
        return ax === 1 && ay === 1 && (piece.faceUp ||
          (inPalace(piece.slotColor, piece.x, piece.y) && inPalace(piece.slotColor, x, y)));
      case 'king':
        return ax + ay === 1;
      case 'pawn': {
        const color = owner(piece);
        const forward = color === RED ? -1 : 1;
        const crossed = color === RED ? piece.y <= 4 : piece.y >= 5;
        return (dx === 0 && dy === forward) || (crossed && ax === 1 && dy === 0);
      }
      default: return false;
    }
  }

  function legalMoves(state, x, y) {
    const piece = at(state, x, y);
    if (state.winner || !piece || owner(piece) !== state.turn) return [];
    const moves = [];
    for (let ty = 0; ty < 10; ty++) for (let tx = 0; tx < 9; tx++) {
      if (canMove(state, piece, tx, ty)) moves.push({ x: tx, y: ty });
    }
    return moves;
  }

  function hasMoves(state) {
    return state.pieces.some(p => owner(p) === state.turn && legalMoves(state, p.x, p.y).length > 0);
  }

  // Immutable transition: the concealed position determines this move; reveal only after arrival.
  function move(state, fromX, fromY, toX, toY) {
    if (state.winner) return { ok: false, error: '本局已结束' };
    const piece = at(state, fromX, fromY);
    if (!piece || owner(piece) !== state.turn) return { ok: false, error: '请选择当前一方的棋子' };
    if (!canMove(state, piece, toX, toY)) return { ok: false, error: '这里不能落子' };
    const next = JSON.parse(JSON.stringify(state));
    const moving = next.pieces.find(p => p.id === piece.id);
    const target = at(next, toX, toY);
    const revealed = !piece.faceUp;
    next.revision = (Number.isInteger(state.revision) ? state.revision : state.moveNumber || 0) + 1;
    // A concealed general is protected. An attempted capture only exposes it, without
    // moving/revealing the attacker or declaring a capture. This does consume a turn.
    if (target && !target.faceUp && target.kind === 'king') {
      target.faceUp = true;
      next.lastAction = {
        type: 'reveal-king', color: state.turn, pieceId: piece.id,
        fromX, fromY, toX, toY,
        targetId: target.id, targetColor: target.color, targetName: label(target)
      };
      next.moveNumber++;
      next.turn = opposite(state.turn);
      next.lastMove = Object.assign({}, next.lastAction, {
        revealed: false, switchedSide: false, capturedName: null, capturedColor: null
      });
      return { ok: true, state: next };
    }
    if (target) {
      next.pieces = next.pieces.filter(p => p.id !== target.id);
      next.captured.push(Object.assign({}, target, { faceUp: true, capturedBy: state.turn }));
      if (target.kind === 'king') {
        next.winner = opposite(target.color);
        next.endReason = target.color === state.turn ? 'own-king-captured' : 'king-captured';
      }
    }
    moving.x = toX; moving.y = toY; moving.faceUp = true;
    next.moveNumber++;
    next.turn = opposite(state.turn);
    next.lastMove = {
      fromX, fromY, toX, toY, color: state.turn, pieceId: piece.id,
      revealed, switchedSide: revealed && piece.color !== state.turn,
      pieceName: label(moving), pieceColor: moving.color,
      capturedName: target ? label(target) : null,
      capturedColor: target ? target.color : null
    };
    next.lastAction = Object.assign({ type: 'move' }, next.lastMove);
    if (!next.winner && !hasMoves(next)) {
      next.winner = state.turn;
      next.endReason = 'no-legal-moves';
    }
    return { ok: true, state: next };
  }

  return { RED, BLACK, NAMES, opposite, inside, at, owner, kind, label, slots, createGame, canMove, legalMoves, move };
});
