'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { RoomManager, COLORS } = require('./game-room.cjs');
const { createClientDownload } = require('./client-download.cjs');
const { createMobileAssets } = require('./mobile-assets.cjs');
const { createAndroidDownload } = require('./android-download.cjs');
const SecureRandom = require('../src/system-random.js');
const Engine = require('../src/game-engine.js');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const RENDERER_ROOT = path.join(PROJECT_ROOT, 'renderer');
const DEFAULT_PORT = 38766;
const DEFAULT_HOST = '0.0.0.0';
const WS_PATH = '/ws';
const MAX_MESSAGE_BYTES = 4096;
const MAX_WS_PAYLOAD = 16 * 1024;

const STATIC_ROUTES = new Map([
  ['/', [path.join(RENDERER_ROOT, 'index.html'), 'text/html; charset=utf-8']],
  ['/index.html', [path.join(RENDERER_ROOT, 'index.html'), 'text/html; charset=utf-8']],
  ['/styles.css', [path.join(RENDERER_ROOT, 'styles.css'), 'text/css; charset=utf-8']],
  ['/polish.css', [path.join(RENDERER_ROOT, 'polish.css'), 'text/css; charset=utf-8']],
  ['/app.js', [path.join(RENDERER_ROOT, 'app.js'), 'text/javascript; charset=utf-8']],
  ['/game-engine.js', [path.join(PROJECT_ROOT, 'src', 'game-engine.js'), 'text/javascript; charset=utf-8']],
  ['/src/game-engine.js', [path.join(PROJECT_ROOT, 'src', 'game-engine.js'), 'text/javascript; charset=utf-8']],
  ['/check-detector.js', [path.join(PROJECT_ROOT, 'src', 'check-detector.js'), 'text/javascript; charset=utf-8']],
  ['/src/check-detector.js', [path.join(PROJECT_ROOT, 'src', 'check-detector.js'), 'text/javascript; charset=utf-8']],
  ['/src/invite.js', [path.join(PROJECT_ROOT, 'src', 'invite.js'), 'text/javascript; charset=utf-8']]
]);

function setCommonHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');
}

function isLocalBrowserRequest(req) {
  const remote = req.socket.remoteAddress || '';
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const proxied = Boolean(
    req.headers['cf-connecting-ip'] || req.headers['cf-ray'] || req.headers['cdn-loop'] ||
    req.headers['x-forwarded-for'] || req.headers['x-real-ip']
  );
  return loopback && !proxied;
}

function sendJson(res, statusCode, payload) {
  setCommonHeaders(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.statusCode = statusCode;
  res.end(JSON.stringify(payload));
}

function networkUrls(port) {
  const urls = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        urls.push(`http://${entry.address}:${port}/`);
      }
    }
  }
  return [...new Set(urls)];
}

function normalizePublicUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function listenWithFallback(server, host, requestedPort, attempts) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryPort = port => {
      const onError = error => {
        server.removeListener('listening', onListening);
        if (error.code === 'EADDRINUSE' && port !== 0 && attempt + 1 < attempts) {
          attempt++;
          tryPort(port + 1);
          return;
        }
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(server.address().port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    };
    tryPort(requestedPort);
  });
}

function createChessServer(options = {}) {
  let mobileAssets = createMobileAssets(options.assetOverrides);
  const handleAndroidDownload = createAndroidDownload(options.androidReleaseDirectory);
  const handleClientDownload = createClientDownload(options.downloadFile || process.env.STRANGE_CHESS_DOWNLOAD_FILE || path.join(PROJECT_ROOT, 'release', 'strange-chess-lite-windows-x64.exe'));
  const host = options.host || DEFAULT_HOST;
  const requestedPort = Number.isInteger(options.port) ? options.port : DEFAULT_PORT;
  const attempts = Number.isInteger(options.portAttempts) ? Math.max(1, options.portAttempts) : 8;
  const manager = new RoomManager({ initialStateFactory: options.initialStateFactory || (() => SecureRandom.game(Engine)) });
  const sessions = new Map();
  const socketsById = new Map();
  // One FIFO per server; private invitation rooms never enter this queue.
  const matchQueue = new Map();
  const quiet = Boolean(options.quiet);
  let configuredPublicUrl = normalizePublicUrl(options.publicUrl || process.env.STRANGE_CHESS_PUBLIC_URL);
  let port = null;
  let lanUrls = [];
  let cleanupTimer = null;
  let heartbeatTimer = null;

  function log(...args) {
    if (!quiet) console.log(...args);
  }

  function shareInfo() {
    const urls = [];
    if (configuredPublicUrl) urls.push(configuredPublicUrl);
    urls.push(...lanUrls);
    if (!urls.length) urls.push(`http://127.0.0.1:${port}/`);
    return {
      code: null,
      urls: [...new Set(urls)],
      lanUrls: lanUrls.slice(),
      websocketPath: WS_PATH,
      scope: configuredPublicUrl ? 'public' : 'lan'
    };
  }

  function roomShare(room) {
    return { ...shareInfo(), code: room.code };
  }

  function send(session, payload) {
    if (!session || session.closed) return;
    if (session.ws.readyState !== WebSocket.OPEN) return;
    try {
      session.ws.send(JSON.stringify(payload));
    } catch {
      session.ws.terminate();
    }
  }

  function sendError(session, code, message) {
    send(session, { type: 'error', code, message });
  }

  function sessionForSeat(room, seat) {
    const player = room.seats[seat];
    if (!player || !player.connected) return null;
    return socketsById.get(player.socketId) || null;
  }

  function broadcastRoom(room, extra = {}) {
    const share = roomShare(room);
    for (let seat = 0; seat < 2; seat++) {
      const session = sessionForSeat(room, seat);
      if (session) send(session, room.publicView(share, extra));
    }
  }

  function sessionForWs(ws) {
    return sessions.get(ws) || null;
  }

  function requireRoom(session) {
    if (!session.roomCode) {
      sendError(session, 'NOT_IN_ROOM', '请先创建或加入房间');
      return null;
    }
    const room = manager.getRoom(session.roomCode);
    if (!room) {
      session.roomCode = null;
      session.seat = null;
      sendError(session, 'ROOM_NOT_FOUND', '房间不存在或已结束');
      return null;
    }
    return room;
  }

  function joinSessionToRoom(session, room, added) {
    matchQueue.delete(session.id);
    session.roomCode = room.code;
    session.seat = added.seat;
    socketsById.set(session.id, session);
    send(session, {
      type: 'joined',
      roomCode: room.code,
      seat: added.seat,
      color: added.color,
      token: added.token,
      share: roomShare(room)
    });
    broadcastRoom(room);
  }

  function handleMatch(session) {
    if (session.roomCode) {
      sendError(session, 'ALREADY_IN_ROOM', '请先离开当前房间');
      return;
    }
    if (matchQueue.has(session.id)) {
      send(session, { type: 'matchStatus', status: 'waiting' });
      return;
    }
    for (const [id, candidate] of matchQueue) {
      matchQueue.delete(id);
      if (candidate.closed || candidate.ws.readyState !== WebSocket.OPEN || candidate.roomCode) continue;
      const room = manager.createRoom();
      // Add both seats before publishing a state so nobody sees a half-created match.
      const first = room.addPlayer(candidate.id);
      const second = room.addPlayer(session.id);
      for (const player of [candidate, session]) {
        send(player, { type: 'matchStatus', status: 'matched' });
      }
      joinSessionToRoom(candidate, room, first);
      joinSessionToRoom(session, room, second);
      return;
    }
    if (matchQueue.size >= 1000) {
      sendError(session, 'MATCH_QUEUE_FULL', '匹配人数较多，请稍后重试');
      return;
    }
    matchQueue.set(session.id, session);
    send(session, { type: 'matchStatus', status: 'waiting' });
  }

  function handleCancelMatch(session) {
    const cancelled = matchQueue.delete(session.id);
    // A pairing which already won the race is a room. Do not claim it was cancelled.
    send(session, { type: 'matchStatus', status: session.roomCode ? 'matched' : 'cancelled', cancelled });
  }

  function handleCreate(session) {
    if (session.roomCode) {
      sendError(session, 'ALREADY_IN_ROOM', '请先离开当前房间');
      return;
    }
    const room = manager.createRoom();
    const added = room.addPlayer(session.id);
    joinSessionToRoom(session, room, added);
    log(`[room ${room.code}] created by seat ${added.seat}`);
  }

  function handleJoin(session, message) {
    if (session.roomCode) {
      sendError(session, 'ALREADY_IN_ROOM', '请先离开当前房间');
      return;
    }
    const code = typeof message.roomCode === 'string' ? message.roomCode.trim().toUpperCase() : '';
    if (!/^[A-Z2-9]{6}$/.test(code)) {
      sendError(session, 'BAD_ROOM_CODE', '房间码应为 6 位大写字母或数字');
      return;
    }
    const room = manager.getRoom(code);
    if (!room) {
      sendError(session, 'ROOM_NOT_FOUND', '没有找到这个房间');
      return;
    }
    let added;
    try {
      added = room.addPlayer(session.id);
    } catch (error) {
      sendError(session, error.code || 'JOIN_FAILED', error.message);
      return;
    }
    joinSessionToRoom(session, room, added);
    log(`[room ${room.code}] seat ${added.seat} joined`);
  }

  function handleReconnect(session, message) {
    if (session.roomCode) {
      sendError(session, 'ALREADY_IN_ROOM', '已经在这个房间中');
      return;
    }
    const code = typeof message.roomCode === 'string' ? message.roomCode.trim().toUpperCase() : '';
    const room = manager.getRoom(code);
    if (!room) {
      sendError(session, 'ROOM_NOT_FOUND', '房间已失效，无法重连');
      return;
    }
    const result = room.reconnect(session.id, message.token);
    if (!result) {
      sendError(session, 'INVALID_TOKEN', '重连凭证无效');
      return;
    }
    if (result.previousSocketId && result.previousSocketId !== session.id) {
      const previous = socketsById.get(result.previousSocketId);
      if (previous) {
        previous.roomCode = null;
        previous.seat = null;
        send(previous, { type: 'sessionReplaced', message: '已在另一处重新连接' });
        try { previous.ws.close(4001, 'reconnected elsewhere'); } catch { /* noop */ }
      }
    }
    session.roomCode = room.code;
    session.seat = result.seat;
    socketsById.set(session.id, session);
    send(session, {
      type: 'joined',
      roomCode: room.code,
      seat: result.seat,
      color: result.color,
      token: message.token,
      reconnected: true,
      share: roomShare(room)
    });
    broadcastRoom(room);
    log(`[room ${room.code}] seat ${result.seat} reconnected`);
  }

  function handleMove(session, message) {
    const room = requireRoom(session);
    if (!room) return;
    const seat = room.playerSeat(session.id);
    if (seat < 0) {
      sendError(session, 'NOT_SEATED', '你不在这个房间中');
      return;
    }
    try {
      room.move(seat, message.fromX, message.fromY, message.toX, message.toY);
    } catch (error) {
      sendError(session, error.code || 'ILLEGAL_MOVE', error.message);
      return;
    }
    broadcastRoom(room);
  }

  function handleRestartRequest(session) {
    const room = requireRoom(session);
    if (!room) return;
    const seat = room.playerSeat(session.id);
    try {
      room.requestRestart(seat);
      broadcastRoom(room, { notice: '已发出再来一局请求，等待对方同意' });
    } catch (error) {
      sendError(session, error.code || 'RESTART_FAILED', error.message);
    }
  }

  function handleRestartResponse(session, message) {
    const room = requireRoom(session);
    if (!room) return;
    if (typeof message.accept !== 'boolean') {
      sendError(session, 'BAD_RESTART_RESPONSE', '请明确同意或拒绝');
      return;
    }
    const seat = room.playerSeat(session.id);
    try {
      const result = room.respondRestart(seat, message.accept, message.requestId);
      broadcastRoom(room, {
        notice: result.restarted ? '双方已同意，新一局开始' : '对方拒绝了再来一局'
      });
    } catch (error) {
      sendError(session, error.code || 'RESTART_FAILED', error.message);
    }
  }

  function handleUndo(session, message) {
    const room = requireRoom(session);
    if (!room) return;
    const seat = room.playerSeat(session.id);
    try {
      if (message.type === 'requestUndo') {
        room.requestUndo(seat);
        broadcastRoom(room, { notice: '已发出悔棋申请，等待对方同意' });
      } else {
        const result = room.respondUndo(seat, message.accept, message.requestId);
        broadcastRoom(room, { notice: result.undone ? '双方已同意，已撤销上一手' : '悔棋申请已拒绝，可以继续下棋' });
      }
    } catch (error) { sendError(session, error.code || 'UNDO_FAILED', error.message); }
  }

  function handleLeave(session) {
    const room = requireRoom(session);
    if (!room) {
      send(session, { type: 'left' });
      return;
    }
    const seat = room.playerSeat(session.id);
    const remaining = [];
    for (let other = 0; other < 2; other++) {
      if (other === seat) continue;
      const player = room.seats[other];
      if (!player) continue;
      remaining.push(player);
      const otherSession = socketsById.get(player.socketId);
      if (otherSession) {
        send(otherSession, { type: 'roomClosed', message: '对方已离开房间' });
        otherSession.roomCode = null;
        otherSession.seat = null;
      }
    }
    manager.deleteRoom(room.code);
    session.roomCode = null;
    session.seat = null;
    send(session, { type: 'left' });
    log(`[room ${room.code}] seat ${seat} left; room closed`);
  }

  function handleMessage(session, raw) {
    if (raw.length > MAX_MESSAGE_BYTES) {
      session.invalidMessages++;
      sendError(session, 'MESSAGE_TOO_LARGE', '消息过大');
      if (session.invalidMessages >= 5) session.ws.close(1009, 'message too large');
      return;
    }
    let message;
    try {
      message = JSON.parse(raw.toString('utf8'));
    } catch {
      session.invalidMessages++;
      sendError(session, 'BAD_JSON', '消息格式无效');
      if (session.invalidMessages >= 8) session.ws.close(1008, 'invalid messages');
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') {
      session.invalidMessages++;
      sendError(session, 'BAD_MESSAGE', '消息格式无效');
      return;
    }
    session.invalidMessages = 0;
    switch (message.type) {
      case 'findMatch': handleMatch(session); break;
      case 'cancelMatch': handleCancelMatch(session); break;
      case 'createRoom': handleCreate(session); break;
      case 'joinRoom': handleJoin(session, message); break;
      case 'reconnect': handleReconnect(session, message); break;
      case 'move': handleMove(session, message); break;
      case 'requestRestart': handleRestartRequest(session); break;
      case 'respondRestart': handleRestartResponse(session, message); break;
      case 'requestUndo':
      case 'respondUndo': handleUndo(session, message); break;
      case 'leaveRoom': handleLeave(session); break;
      case 'ping': send(session, { type: 'pong', time: Date.now() }); break;
      default:
        sendError(session, 'UNKNOWN_TYPE', '不支持的消息类型');
    }
  }

  async function requestHandler(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      setCommonHeaders(res);
      res.statusCode = 405;
      res.setHeader('Allow', 'GET, HEAD');
      res.end('Method Not Allowed');
      return;
    }
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      sendJson(res, 400, { error: 'bad request' });
      return;
    }
    if (await handleClientDownload(req, res, pathname)) return;
    if (await handleAndroidDownload(req, res, pathname)) return;
    if (mobileAssets.handle(req, res, pathname)) return;
    if (pathname === '/api/info') {
      // The detailed server card is for the local host only. A tunnel reaches this
      // process over loopback, so proxy headers must also disqualify the request.
      if (!isLocalBrowserRequest(req)) {
        sendJson(res, 403, { error: 'local host only' });
        return;
      }
      sendJson(res, 200, {
        name: '根本就没有这样的象棋',
        port,
        host,
        lanUrls,
        publicUrl: configuredPublicUrl,
        websocketPath: WS_PATH,
        isLocalHost: true,
        status: 'ok'
      });
      return;
    }
    if (pathname === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }
    const route = STATIC_ROUTES.get(pathname);
    if (!route) {
      setCommonHeaders(res);
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Not Found');
      return;
    }
    const [filePath, contentType] = route;
    fs.readFile(filePath, (error, data) => {
      if (error) {
        sendJson(res, 500, { error: 'static asset unavailable' });
        return;
      }
      setCommonHeaders(res);
      res.statusCode = 200;
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', data.length);
      if (req.method === 'HEAD') res.end();
      else res.end(data);
    });
  }

  const httpServer = http.createServer(requestHandler);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_PAYLOAD,
    perMessageDeflate: false
  });

  httpServer.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch { /* invalid */ }
    if (pathname !== WS_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });

  wss.on('connection', ws => {
    const session = {
      id: crypto.randomBytes(12).toString('base64url'),
      ws,
      roomCode: null,
      seat: null,
      closed: false,
      invalidMessages: 0,
      windowStart: Date.now(),
      messageCount: 0,
      isAlive: true
    };
    sessions.set(ws, session);
    send(session, { type: 'welcome', message: '已连接，可以创建或加入房间', time: Date.now() });
    ws.on('pong', () => { session.isAlive = true; });
    ws.on('message', (data, isBinary) => {
      if (session.closed) return;
      const now = Date.now();
      if (now - session.windowStart > 5000) {
        session.windowStart = now;
        session.messageCount = 0;
      }
      session.messageCount++;
      if (session.messageCount > 80) {
        session.ws.close(1008, 'too many messages');
        return;
      }
      if (isBinary) {
        sendError(session, 'BINARY_NOT_SUPPORTED', '只接受文本消息');
        return;
      }
      handleMessage(session, data);
    });
    ws.on('close', () => {
      session.closed = true;
      matchQueue.delete(session.id);
      sessions.delete(ws);
      if (!session.roomCode) {
        if (socketsById.get(session.id) === session) socketsById.delete(session.id);
        return;
      }
      const room = manager.getRoom(session.roomCode);
      if (room) {
        const seat = room.disconnect(session.id);
        if (seat !== null) {
          broadcastRoom(room, { notice: '一位玩家断线了，对局暂时暂停' });
        }
      }
      if (socketsById.get(session.id) === session) socketsById.delete(session.id);
      session.roomCode = null;
      session.seat = null;
    });
    ws.on('error', () => {});
  });

  return listenWithFallback(httpServer, host, requestedPort, attempts).then(actualPort => {
    port = actualPort;
    lanUrls = networkUrls(port);
    cleanupTimer = setInterval(() => {
      const roomsBefore = manager.rooms;
      for (const [code, room] of roomsBefore) {
        const info = room.cleanupInfo();
        if (info.empty || info.waitingExpired || info.finishedExpired || info.abandonedExpired) {
          for (let seat = 0; seat < 2; seat++) {
            const player = room.seats[seat];
            if (!player) continue;
            const session = socketsById.get(player.socketId);
            if (session) {
              send(session, { type: 'roomClosed', message: '房间已过期并清理' });
              session.roomCode = null;
              session.seat = null;
            }
          }
          manager.deleteRoom(code);
        }
      }
    }, 60 * 1000);
    cleanupTimer.unref();

    heartbeatTimer = setInterval(() => {
      for (const session of sessions.values()) {
        if (!session.isAlive) {
          session.ws.terminate();
          continue;
        }
        session.isAlive = false;
        try { session.ws.ping(); } catch { /* noop */ }
      }
    }, 30 * 1000);
    heartbeatTimer.unref();

    const info = {
      httpServer,
      wss,
      manager,
      reloadAssets() { mobileAssets = createMobileAssets(options.assetOverrides); return mobileAssets.build; },
      port,
      host,
      lanUrls,
      get urls() { return shareInfo().urls; },
      get publicUrl() { return configuredPublicUrl; },
      setPublicUrl(value) {
        const normalized = normalizePublicUrl(value);
        if (value && !normalized) throw new Error('公网地址必须使用 HTTP 或 HTTPS');
        configuredPublicUrl = normalized;
        for (const room of manager.rooms.values()) broadcastRoom(room);
        return configuredPublicUrl;
      },
      url: `http://127.0.0.1:${port}/`,
      async close() {
        clearInterval(cleanupTimer);
        clearInterval(heartbeatTimer);
        for (const session of sessions.values()) {
          try { session.ws.close(1001, 'server shutting down'); } catch { /* noop */ }
        }
        await new Promise(resolve => wss.close(() => resolve()));
        await new Promise(resolve => httpServer.close(() => resolve()));
      }
    };
    log(`[strange-chess] listening on http://${host}:${port}/`);
    if (lanUrls.length) log(`[strange-chess] LAN: ${lanUrls.join('  ')}`);
    else log('[strange-chess] LAN: no non-loopback IPv4 address found');
    if (configuredPublicUrl) log(`[strange-chess] public URL: ${configuredPublicUrl}`);
    return info;
  });
}

async function startChessServer(options = {}) {
  return createChessServer(options);
}

if (require.main === module) {
  const envPort = process.env.STRANGE_CHESS_PORT ?? process.env.PORT;
  const port = envPort === undefined ? DEFAULT_PORT : Number(envPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('Invalid STRANGE_CHESS_PORT; expected an integer from 0 to 65535.');
    process.exit(1);
  }
  startChessServer({
    host: process.env.STRANGE_CHESS_HOST || DEFAULT_HOST,
    port,
    publicUrl: process.env.STRANGE_CHESS_PUBLIC_URL || null
  }).then(info => {
    console.log(`[strange-chess] open ${info.url} for the browser debug entry.`);
    console.log('[strange-chess] Press Ctrl+C to stop.');
    const stop = async () => {
      await info.close();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }).catch(error => {
    console.error(`[strange-chess] failed to start: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  createChessServer,
  startChessServer,
  networkUrls,
  normalizePublicUrl,
  STATIC_ROUTES,
  DEFAULT_PORT,
  WS_PATH
};
