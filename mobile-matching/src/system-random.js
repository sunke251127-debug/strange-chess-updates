(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('node:crypto').webcrypto);
  else root.SystemRandom = factory(root.crypto);
})(globalThis, function (source) {
  'use strict';
  function bytes(size) {
    if (!Number.isInteger(size) || size < 1 || size > 4096) throw new Error('随机数据长度无效');
    if (!source || typeof source.getRandomValues !== 'function') throw new Error('系统安全随机源不可用，请更新系统 WebView');
    return source.getRandomValues(new Uint8Array(size));
  }
  function integer(bound) {
    if (!Number.isInteger(bound) || bound < 1 || bound > 0x100000000) throw new Error('随机数范围无效');
    const limit = Math.floor(0x100000000 / bound) * bound;
    let value;
    do { const b = bytes(4); value = (b[0] * 0x1000000 + (b[1] << 16) + (b[2] << 8) + b[3]); } while (value >= limit);
    return value % bound;
  }
  function id(size = 18) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    return Array.from(bytes(size), value => alphabet[value & 63]).join('');
  }
  function game(engine) {
    let bound = engine.slots().length;
    // Preserve the exact game engine while feeding its Fisher–Yates shuffle
    // unbiased integers from the operating system's cryptographic random source.
    return engine.createGame(() => { const n = bound--; return (integer(n) + .5) / n; });
  }
  return { bytes, integer, id, game };
});
