(function (root, factory) {
  const engine = (typeof module === 'object' && module.exports)
    ? require('./game-engine.js')
    : root.StrangeChess;
  const api = factory(engine);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StrangeChessCheck = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (E) {
  'use strict';

  // Public-information check detection. It never inspects a concealed king's real identity:
  // only face-up kings are reported, and every attacker uses the engine's public owner/kind view.
  function detectChecks(state) {
    if (!state || state.winner || !Array.isArray(state.pieces)) return [];
    const results = [];
    for (const king of state.pieces) {
      if (!king.faceUp || king.kind !== 'king' || (king.color !== E.RED && king.color !== E.BLACK)) continue;
      const attackers = [];
      for (const piece of state.pieces) {
        if (piece.id === king.id) continue;
        if (E.owner(piece) === king.color) continue;
        if (!E.inside(piece.x, piece.y)) continue;
        if (E.canMove(state, piece, king.x, king.y)) {
          attackers.push({ x: piece.x, y: piece.y });
        }
      }
      if (attackers.length) {
        results.push({ color: king.color, x: king.x, y: king.y, attackers });
      }
    }
    return results;
  }

  return { detectChecks };
});
