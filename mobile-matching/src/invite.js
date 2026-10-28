(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StrangeChessInvite = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function parseInvite(text) {
    if (typeof text !== 'string' || text.length > 4096) throw new Error('请粘贴好友提供的完整邀请链接或邀请信息');
    const candidates = text.match(/https?:\/\/[^\s<>"'，。；）)]+/gi) || [];
    for (const candidate of candidates) {
      let url;
      try { url = new URL(candidate); } catch { continue; }
      const codes = url.searchParams.getAll('room');
      if (url.username || url.password || codes.length !== 1 || !/^[A-Z2-9]{6}$/i.test(codes[0])) continue;
      return { serverUrl: url.origin, roomCode: codes[0].toUpperCase() };
    }
    throw new Error('邀请无效，请使用包含 ?room=六位房间码 的完整 HTTP/HTTPS 邀请链接');
  }

  return { parseInvite };
});
