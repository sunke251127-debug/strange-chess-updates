(function () {
  'use strict';

  const E = window.StrangeChess;
  const CheckDetector = window.StrangeChessCheck;
  const STORAGE_KEY = 'strange-chess-offline-v1';
  const SOLO_STORAGE_KEY = 'strange-chess-solo-v1';
  const MODE_KEY = 'strange-chess-mode-v1';
  const AIRules = window.StrangeChessAIRules;
  const AI = window.StrangeChessAI;
  const COLOR_KEY = 'strange-chess-next-color-v1';
  let updateState = null;
  let directLink = null;
  let directPending = false;
  const pieceNodes = new Map();
  let pieceBoardKey = '';
  let boardPerspective = null;
  let boardAnalysis = null;
  let captureKey = null;
  let rememberedRound = '';
  if (!E || !CheckDetector) {
    document.body.textContent = '棋规引擎加载失败，请通过项目启动入口打开。';
    return;
  }

  const $ = id => document.getElementById(id);
  const boardGrid = $('boardGrid');
  const turnPill = $('turnPill');
  const turnText = $('turnText');
  const moveNumberLabel = $('moveNumber');
  const modeLabel = $('modeLabel');
  const checkBanner = $('checkBanner');
  const checkText = $('checkText');
  const selectionHint = $('selectionHint');
  const capturedRed = $('capturedRed');
  const capturedBlack = $('capturedBlack');
  const undoBtn = $('undoBtn');
  const shuffleBtn = $('shuffleBtn');
  const localModeBtn = $('localModeBtn');
  const onlineModeBtn = $('onlineModeBtn');
  const rulesBtn = $('rulesBtn');
  const rulesDialog = $('rulesDialog');
  const resultDialog = $('resultDialog');
  const requestDialog = $('onlineRequestDialog');
  const inviteInput = $('inviteInput');
  const joinInviteBtn = $('joinInviteBtn');
  const onlineFormMessage = $('onlineFormMessage');
  const randomMatchStatus = $('randomMatchStatus');
  const onlineSetup = $('onlineSetup');
  const roomPanel = $('roomPanel');
  const seatBadge = $('seatBadge');
  const roomStatusText = $('roomStatusText');
  const playersLine = $('playersLine');
  const shareUrl = $('shareUrl');
  const restartNotice = $('restartNotice');
  const onlineRestartBtn = $('onlineRestartBtn');
  const leaveRoomBtn = $('leaveRoomBtn');
  const connBadge = $('connBadge');
  const toastEl = $('toast');
  const liveRegion = $('liveRegion');

  const colorName = color => color === E.RED ? '红方' : '黑方';
  const colorShort = color => color === E.RED ? '红' : '黑';
  const coordinate = (x, y) => `${x + 1}·${y + 1}`;
  const clone = value => JSON.parse(JSON.stringify(value));

  function emptyLocalGame() {
    return { state: window.SystemRandom.game(E), undoStack: [], moveLog: [] };
  }

  function isPlausibleState(state) {
    return state && Array.isArray(state.pieces) && Array.isArray(state.captured) &&
      state.pieces.length + state.captured.length === 32 &&
      (state.turn === E.RED || state.turn === E.BLACK);
  }

  // Older local saves predate revision/lastAction. Fill them in without changing the
  // visible position so undo snapshots and restored games keep working.
  function normalizeSavedState(state) {
    if (!state || typeof state !== 'object') return state;
    if (!Number.isInteger(state.revision)) {
      state.revision = Number.isInteger(state.moveNumber) ? state.moveNumber : 0;
    }
    if (state.lastMove && !state.lastAction) {
      state.lastAction = state.lastMove.type ? state.lastMove : Object.assign({ type: 'move' }, state.lastMove);
    }
    return state;
  }

  function restoreLocalGame(key = STORAGE_KEY) {
    try {
      const raw = (key === SOLO_STORAGE_KEY && window.AndroidShell?.getGameSave?.(key)) || localStorage.getItem(key);
      if (!raw) return emptyLocalGame();
      const saved = JSON.parse(raw);
      if (!saved || !isPlausibleState(saved.state)) return emptyLocalGame();
      return {
        state: normalizeSavedState(saved.state),
        humanColor: saved.humanColor === E.BLACK ? E.BLACK : E.RED,
        undoStack: Array.isArray(saved.undoStack)
          ? saved.undoStack.filter(isPlausibleState).map(normalizeSavedState).slice(-35)
          : [],
        moveLog: Array.isArray(saved.moveLog) ? saved.moveLog.slice(-90) : []
      };
    } catch {
      return emptyLocalGame();
    }
  }

  let localGame = restoreLocalGame();
  let soloGame = restoreLocalGame(SOLO_STORAGE_KEY);
  soloGame.humanColor ||= E.RED;
  let soloClient = null, soloThinking = false, soloGeneration = 0;
  let soloStatus = { phase: 'idle' }, lastSoloSearch = null;
  let mode = 'local';
  try { if ((window.AndroidShell?.getGameSave?.(MODE_KEY) || localStorage.getItem(MODE_KEY)) === 'solo') mode = 'solo'; } catch { /* private browsing */ }
  let selected = null;
  let legalMoves = [];
  let boardFocus = { x: 4, y: 9 };
  let resultShownKey = null;
  let toastTimer = null;
  let activeChecks = [];
  let lastCheckKey = '';
  let online = {
    ws: null,
    status: 'idle',
    connected: false,
    roomCode: null,
    seat: null,
    seatColor: null,
    room: null,
    moveLog: [],
    lastMoveNumber: -1,
    sending: false,
    leaveTimer: null,
    matchPhase: 'idle',
    matchNotice: ''
  };

  const MATCH_PHASE_LABELS = {
    searching: '正在寻找',
    hosting: '临时匹配节点',
    waiting: '等待对手',
    introducing: '正在建连',
    retry: '重试匹配',
    notice: '匹配提示',
    paired: '正在进入对局',
    reconnecting: '正在重连',
    connected: '已连接'
  };

  function matchPhaseLabel() {
    return MATCH_PHASE_LABELS[online.matchPhase] || '正在匹配';
  }

  function activeState() {
    return mode === 'solo' ? soloGame.state : mode === 'local' ? localGame.state : (online.room ? online.room.state : localGame.state);
  }

  function activeMoveLog() {
    return mode === 'solo' ? soloGame.moveLog : mode === 'local' ? localGame.moveLog : online.moveLog;
  }

  function clearSelection() {
    selected = null;
    legalMoves = [];
  }

  function lockedReason() {
    if (mode === 'local') return null;
    if (mode === 'solo') return soloGame.state.winner ? '本局已结束' : soloGame.state.turn !== soloGame.humanColor ? (soloStatus.phase === 'error' ? '模型暂未就绪，请点击重试' : '模型正在手机上思考') : null;
    if (!online.room) return '请先开始随机匹配或邀请好友';
    if (!online.connected) return '连接已断开，正在尝试重连';
    if (online.sending) return '等待直连对局确认落子';
    if (online.room.status === 'waiting') return '等待第二位玩家加入';
    if (online.room.status === 'ended') return '本局已结束';
    if (online.room.paused) return '对手断线，对局暂停';
    if (online.room.state.turn !== online.seatColor) return '等待对方走棋';
    return null;
  }

  function showToast(message, duration = 2600) {
    if (!message) return;
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), duration);
  }

  function announce(message) {
    liveRegion.textContent = '';
    requestAnimationFrame(() => { liveRegion.textContent = message; });
  }

  function setFormMessage(message, ok = false) {
    onlineFormMessage.textContent = message || '';
    onlineFormMessage.classList.toggle('ok', Boolean(ok));
  }

  function persistLocal() {
    try {
      const game = mode === 'solo' ? soloGame : localGame;
      const key = mode === 'solo' ? SOLO_STORAGE_KEY : STORAGE_KEY;
      const saved = JSON.stringify({
        version: 1,
        state: game.state,
        humanColor: game.humanColor,
        undoStack: game.undoStack.slice(-35),
        moveLog: game.moveLog.slice(-90),
        savedAt: Date.now()
      });
      if (mode === 'solo') window.AndroidShell?.setGameSave?.(key, saved);
      localStorage.setItem(key, saved);
    } catch {
      showToast('本地存档写入失败，可能是存储空间不足');
    }
  }

  function buildBoard() {
    const fragment = document.createDocumentFragment();
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 9; x++) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'cell';
        cell.dataset.x = String(x);
        cell.dataset.y = String(y);
        cell.setAttribute('role', 'gridcell');
        cell.setAttribute('aria-rowindex', String(y + 1));
        cell.setAttribute('aria-colindex', String(x + 1));
        cell.tabIndex = -1;
        cell.addEventListener('click', () => onCellActivate(x, y));
        cell.addEventListener('focus', () => { boardFocus = { x, y }; });
        fragment.append(cell);
      }
    }
    boardGrid.append(fragment);
  }

  function cellAt(x, y) {
    return boardGrid.children[y * 9 + x];
  }

  function blackPerspective() {
    return mode === 'solo' ? soloGame.humanColor === E.BLACK : mode === 'online' && Boolean(online.room) && online.seatColor === E.BLACK;
  }

  function analyzeBoard(state) {
    if (!boardAnalysis || boardAnalysis.state !== state) {
      boardAnalysis = { state, squares: new Map(state.pieces.map(piece => [piece.y * 9 + piece.x, piece])), moves: new Map(), checks: null };
    }
    return boardAnalysis;
  }

  function movesAt(state, x, y) {
    const analysis = analyzeBoard(state), key = y * 9 + x;
    if (!analysis.moves.has(key)) {
      if (mode === 'solo') {
        analysis.aiActions ||= new Set(AIRules.legalActions(state));
        analysis.moves.set(key, E.legalMoves(state, x, y).filter(to => analysis.aiActions.has(key * 90 + to.y * 9 + to.x)));
      } else analysis.moves.set(key, E.legalMoves(state, x, y));
    }
    return analysis.moves.get(key);
  }

  function boardKeyNavigation(event) {
    const target = event.target.closest('.cell');
    if (!target) return;
    const x = Number(target.dataset.x);
    const y = Number(target.dataset.y);
    let nx = x;
    let ny = y;
    const step = blackPerspective() ? -1 : 1;
    if (event.key === 'ArrowLeft') nx = Math.max(0, Math.min(8, x - step));
    else if (event.key === 'ArrowRight') nx = Math.max(0, Math.min(8, x + step));
    else if (event.key === 'ArrowUp') ny = Math.max(0, Math.min(9, y - step));
    else if (event.key === 'ArrowDown') ny = Math.max(0, Math.min(9, y + step));
    else if (event.key === 'Home') nx = step === 1 ? 0 : 8;
    else if (event.key === 'End') nx = step === 1 ? 8 : 0;
    else return;
    event.preventDefault();
    boardFocus = { x: nx, y: ny };
    for (const cell of boardGrid.children) {
      cell.tabIndex = Number(cell.dataset.x) === nx && Number(cell.dataset.y) === ny ? 0 : -1;
    }
    cellAt(nx, ny).focus();
  }

  function pieceAriaLabel(piece, x, y, isSelected, isLegal, isCapture, inCheck) {
    let label;
    if (!piece) label = `空位，第${x + 1}列第${y + 1}行`;
    else if (piece.faceUp) {
      label = `${colorName(piece.color)}${E.NAMES[piece.color][piece.kind]}，第${x + 1}列第${y + 1}行`;
    } else {
      label = `${colorName(piece.slotColor)}初始点位的暗子，按${E.NAMES[piece.slotColor][piece.slotKind]}走法，第${x + 1}列第${y + 1}行`;
    }
    if (isSelected) label += '，已选中';
    if (isLegal) label += isCapture ? '，可吃子' : '，可落点';
    if (inCheck) label += '，正在被将军';
    return label;
  }

  function updateCheckState(state) {
    const analysis = state ? analyzeBoard(state) : null;
    if (analysis && !analysis.checks) analysis.checks = state.winner ? [] : CheckDetector.detectChecks(state);
    activeChecks = analysis ? analysis.checks : [];
    const key = activeChecks
      .map(check => `${check.color}:${check.x},${check.y}:${check.attackers.map(a => `${a.x},${a.y}`).join('|')}`)
      .join(';');
    if (!activeChecks.length) {
      checkBanner.hidden = true;
      checkBanner.classList.remove('just-check');
      lastCheckKey = '';
      return;
    }
    const entered = Boolean(key && key !== lastCheckKey);
    lastCheckKey = key;
    checkBanner.hidden = false;
    checkText.textContent = activeChecks.length > 1
      ? '红方、黑方同时被将军'
      : `${colorName(activeChecks[0].color)}被将军`;
    if (entered) {
      checkBanner.classList.remove('just-check');
      void checkBanner.offsetWidth;
      checkBanner.classList.add('just-check');
      announce(activeChecks.length > 1 ? '将军，红黑双方同时被将军' : `将军，${colorName(activeChecks[0].color)}被将军`);
    }
  }

  function appendMoveTag(cell, kind) {
    const tag = document.createElement('span');
    tag.className = `move-tag ${kind}`;
    tag.textContent = kind === 'from' ? '起' : kind === 'king' ? '亮' : '终';
    tag.setAttribute('aria-hidden', 'true');
    cell.append(tag);
  }

  function renderBoard() {
    const state = activeState();
    if (!state) return;
    const analysis = analyzeBoard(state);
    const reversed = blackPerspective();
    if (boardPerspective !== reversed) {
      boardPerspective = reversed;
      boardGrid.dataset.perspective = reversed ? 'black' : 'red';
      for (let y = 0; y < 10; y++) for (let x = 0; x < 9; x++) {
        const cell = cellAt(x, y), row = reversed ? 10 - y : y + 1, column = reversed ? 9 - x : x + 1;
        cell.style.gridRow = String(row); cell.style.gridColumn = String(column);
        cell.setAttribute('aria-rowindex', String(row)); cell.setAttribute('aria-colindex', String(column));
      }
    }
    const boardKey = mode + ':' + (online.roomCode || 'local');
    if (pieceBoardKey !== boardKey) { pieceNodes.clear(); pieceBoardKey = boardKey; }
    if (selected) {
      const piece = E.at(state, selected.x, selected.y);
      if (!piece || E.owner(piece) !== state.turn) clearSelection();
    }
    if (state.winner) clearSelection();
    const lastMove = state.lastMove;
    const lastRevealKing = state.lastAction && state.lastAction.type === 'reveal-king' ? state.lastAction : null;
    const selectionAt = selected;
    const activeLegal = legalMoves;
    const locked = modeLocked();

    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 9; x++) {
        const cell = cellAt(x, y);
        const piece = analysis.squares.get(y * 9 + x);
        const isSelected = Boolean(selectionAt && selectionAt.x === x && selectionAt.y === y);
        const legalIndex = activeLegal.findIndex(move => move.x === x && move.y === y);
        const isLegal = legalIndex >= 0;
        const isCapture = isLegal && Boolean(piece);
        const inCheck = Boolean(piece && piece.faceUp && activeChecks.some(check => check.x === x && check.y === y));
        const isRevealTarget = Boolean(lastRevealKing && lastRevealKing.toX === x && lastRevealKing.toY === y);
        let className = 'cell';
        if (isSelected) className += ' is-selected';
        if (isLegal) className += isCapture ? ' is-legal is-capture' : ' is-legal';
        if (lastMove && lastMove.fromX === x && lastMove.fromY === y) className += ' last-from';
        if (lastMove && lastMove.toX === x && lastMove.toY === y) {
          className += isRevealTarget ? ' last-king' : ' last-to';
        }
        if (inCheck) className += ' is-in-check';
        // The move affordance only highlights pieces that have a destination.
        // Blocked pieces remain inspectable, without suggesting they can move.
        if (!state.winner && !locked && piece && E.owner(piece) === state.turn && movesAt(state, x, y).length) className += ' is-selectable';
        if (cell.className !== className) cell.className = className;
        const tabIndex = boardFocus.x === x && boardFocus.y === y ? 0 : -1;
        if (cell.tabIndex !== tabIndex) cell.tabIndex = tabIndex;
        const label = pieceAriaLabel(piece, x, y, isSelected, isLegal, isCapture, inCheck);
        if (cell.getAttribute('aria-label') !== label) cell.setAttribute('aria-label', label);
        if (cell.getAttribute('aria-pressed') !== String(isSelected)) cell.setAttribute('aria-pressed', String(isSelected));
        // Preserve stationary piece nodes so selection does not cancel/restart
        // an in-flight flip. Only decorations are rebuilt on each render.
        for (const child of Array.from(cell.children)) if (!child.classList.contains('piece')) child.remove();

        if (piece) {
          let pieceEl = pieceNodes.get(piece.id);
          const flip = Boolean(pieceEl && pieceEl.dataset.face === 'down' && piece.faceUp);
          if (!pieceEl) {
            pieceEl = document.createElement('span');
            pieceEl.addEventListener('animationend', event => { if (event.animationName === 'mobile-piece-flip') pieceEl.classList.remove('flip-running'); });
            pieceNodes.set(piece.id, pieceEl);
          }
          const ongoingFlip = pieceEl.classList.contains('flip-running') && piece.faceUp;
          if (piece.faceUp) {
            pieceEl.className = `piece face-up ${piece.color}${flip || ongoingFlip ? ' flip-running' : ''}`;
            const symbol = E.NAMES[piece.color][piece.kind];
            if (pieceEl.dataset.symbol !== symbol || pieceEl.dataset.face !== 'up') {
              const front = document.createElement('span'); front.className = 'piece-front';
              const glyph = document.createElement('span'); glyph.className = 'piece-glyph';
              glyph.append(window.StrangeChessGlyphs.create(symbol));
              front.append(glyph);
              const back = document.createElement('span'); back.className = 'piece-back';
              pieceEl.replaceChildren(front, back); pieceEl.dataset.symbol = symbol;
            }
            pieceEl.dataset.face = 'up';
          } else {
            pieceEl.className = `piece face-down slot-${piece.slotColor} slot-tick`;
            if (pieceEl.dataset.face !== 'down') pieceEl.replaceChildren();
            pieceEl.dataset.face = 'down'; pieceEl.dataset.symbol = '';
          }
          pieceEl.setAttribute('aria-hidden', 'true');
          const previousPiece = cell.querySelector('.piece');
          if (previousPiece && previousPiece !== pieceEl) previousPiece.remove();
          if (pieceEl.parentElement !== cell) cell.append(pieceEl);
        } else { cell.querySelector('.piece')?.remove(); }
        if (lastMove && lastMove.fromX === x && lastMove.fromY === y) appendMoveTag(cell, 'from');
        if (lastMove && lastMove.toX === x && lastMove.toY === y) {
          appendMoveTag(cell, isRevealTarget ? 'king' : 'to');
        }
        if (inCheck) {
          const badge = document.createElement('span');
          badge.className = 'check-badge';
          badge.textContent = '将';
          badge.setAttribute('aria-hidden', 'true');
          cell.append(badge);
        }
      }
    }
    const live = new Set(state.pieces.map(piece => piece.id));
    for (const id of pieceNodes.keys()) if (!live.has(id)) pieceNodes.delete(id);
  }

  function modeLocked() {
    return Boolean(lockedReason());
  }

  function renderStatus() {
    const state = activeState();
    if (!state) return;
    turnPill.classList.remove('red', 'black', 'ended');
    if (state.winner) {
      turnPill.classList.add('ended');
      turnText.textContent = `${colorName(state.winner)}胜`;
    } else {
      turnPill.classList.add(state.turn);
      turnText.textContent = `${colorName(state.turn)}行棋`;
    }
    moveNumberLabel.textContent = `第 ${state.moveNumber} 手`;

    if (mode === 'local') {
      modeLabel.textContent = '本地双人 · 同屏轮流';
    } else if (mode === 'solo') {
      modeLabel.textContent = `单机对战 · 你执${soloGame.humanColor === E.RED ? '红' : '黑'} · 每手${AI.SIMULATIONS}次`;
    } else if (online.room) {
      modeLabel.textContent = `${(online.room?.random || online.room?.transport === 'dht') ? '随机联机' : '好友直连'} · 你是${online.seatColor ? colorName(online.seatColor).replace('方', '') + '方' : '观战方'}`;
    } else if ((directLink?.randomMatch || directLink?.transport === 'dht')) {
      modeLabel.textContent = `随机联机 · ${matchPhaseLabel()}`;
    } else {
      modeLabel.textContent = '好友直连 · 尚未连接';
    }

    const reason = lockedReason();
    if (selected) {
      const piece = E.at(state, selected.x, selected.y);
      if (piece) {
        if (piece.faceUp) {
          selectionHint.innerHTML = `已翻明：<strong>${colorName(piece.color)} ${E.NAMES[piece.color][piece.kind]}</strong>。按真实棋种行棋。`;
        } else if (piece.slotKind === 'advisor') {
          selectionHint.innerHTML = `暗子 · <span class="slot-kind">${colorShort(piece.slotColor)}位 · ${E.NAMES[piece.slotColor][piece.slotKind]}</span>：未翻面时只能在己方九宫斜走一格；翻面后按实际棋种，若翻出明士仍可全盘斜行。`;
        } else {
          selectionHint.innerHTML = `暗子 · 此次按 <span class="slot-kind">${colorShort(piece.slotColor)}位 · ${E.NAMES[piece.slotColor][piece.slotKind]}</span> 的点位规则走，落子后翻面。`;
        }
        if (legalMoves.length === 0) selectionHint.innerHTML += ' 当前没有合法落点。';
      } else {
        selectionHint.textContent = '点选一枚棋子，查看它这一次能怎么走。';
      }
    } else if (mode === 'online' && reason) {
      selectionHint.textContent = reason;
    } else if (state.winner) {
      selectionHint.textContent = '本局已结束，可以查看棋盘，或再来一局。';
    } else {
      selectionHint.textContent = '点选一枚棋子，查看它这一次能怎么走。';
    }

    const canRequest = online.connected && online.room?.bothConnected && !pendingOnlineAction();
    undoBtn.disabled = mode === 'solo' ? !soloGame.undoStack.some(state => state.turn === soloGame.humanColor) : mode === 'local' ? localGame.undoStack.length === 0 : !canRequest || !online.room?.canUndo;
    undoBtn.textContent = mode === 'online' ? '申请悔棋' : '悔棋';
    undoBtn.title = mode === 'solo' ? '撤销到你上次落子前，模型思考也会取消' : mode === 'local' ? (localGame.undoStack.length ? '撤销上一手本地棋' : '还没有可撤销的棋') : '申请撤销上一手，需对方同意';
    shuffleBtn.disabled = mode === 'online' && !canRequest;
    shuffleBtn.title = mode === 'online' ? '申请开始新棋局，需对方同意' : '清空本局，重新随机洗牌';
  }

  function renderCaptures() {
    const state = activeState();
    const key = JSON.stringify(state.captured);
    if (key === captureKey) return;
    captureKey = key;
    const groups = { red: [], black: [] };
    for (const piece of state.captured) {
      if (groups[piece.color]) groups[piece.color].push(piece);
    }
    for (const [color, target] of [[E.RED, capturedRed], [E.BLACK, capturedBlack]]) {
      target.replaceChildren();
      if (!groups[color].length) {
        const empty = document.createElement('span');
        empty.className = 'empty-tray';
        empty.textContent = '暂无';
        target.append(empty);
        continue;
      }
      target.title = `${colorName(color)}折损：${groups[color].map(piece => E.NAMES[piece.color][piece.kind]).join('、')}`;
      for (const piece of groups[color]) {
        const mini = document.createElement('span');
        mini.className = `mini-piece ${piece.color}`;
        mini.append(window.StrangeChessGlyphs.create(E.NAMES[piece.color][piece.kind]));
        mini.title = `${colorName(piece.color)}${E.NAMES[piece.color][piece.kind]}`;
        target.append(mini);
      }
    }
  }

  function logEntry(lastMove, number) {
    return {
      type: lastMove.type === 'reveal-king' ? 'reveal-king' : 'move',
      number,
      color: lastMove.color,
      pieceName: lastMove.pieceName,
      pieceColor: lastMove.pieceColor,
      fromX: lastMove.fromX,
      fromY: lastMove.fromY,
      toX: lastMove.toX,
      toY: lastMove.toY,
      revealed: Boolean(lastMove.revealed),
      switchedSide: Boolean(lastMove.switchedSide),
      capturedName: lastMove.capturedName || null,
      capturedColor: lastMove.capturedColor || null,
      targetColor: lastMove.targetColor || null,
      targetName: lastMove.targetName || null
    };
  }

  function appendMoveLog(lastMove, number) {
    const log = activeMoveLog();
    log.push(logEntry(lastMove, number));
    if (log.length > 90) log.splice(0, log.length - 90);
  }

  function renderRandomStatus() {
    const matching = Boolean(!online.room && directPending && (directLink?.randomMatch || directLink?.transport === 'dht'));
    const failed = online.status === 'error' && directLink?.randomMatch;
    randomMatchStatus.hidden = !(matching || failed);
    randomMatchStatus.dataset.phase = failed ? 'error' : matching ? online.matchPhase : '';
    randomMatchStatus.textContent = failed ? online.matchNotice : matching ? (online.matchNotice || `${matchPhaseLabel()}，可以随时取消。`) : '';
  }

  function renderOnline() {
    const connected = online.connected && online.status === 'online';
    const matching = Boolean(!online.room && directPending && (directLink?.randomMatch || directLink?.transport === 'dht'));
    connBadge.className = 'conn-badge ' + (
      matching ? 'connecting' :
        online.status === 'connecting' ? 'connecting' :
          connected ? 'online' :
            online.status === 'offline' ? 'connecting' :
              online.status === 'error' ? 'error' : 'offline'
    );
    connBadge.textContent = matching ? matchPhaseLabel() :
      online.status === 'connecting' ? '连接中' :
        connected ? '已连接' :
          online.status === 'offline' ? '重连中' :
            online.status === 'error' ? '连接失败' : '未连接';
    renderRandomStatus();

    if (!online.room) {
      onlineSetup.hidden = false;
      roomPanel.hidden = true;
      return;
    }

    const room = online.room;
    onlineSetup.hidden = true;
    roomPanel.hidden = false;
    if (online.seatColor) {
      seatBadge.className = `seat-badge ${online.seatColor}`;
      seatBadge.textContent = `你是${colorName(online.seatColor)}`;
    } else {
      seatBadge.className = 'seat-badge spectator';
      seatBadge.textContent = '观战';
    }

    if (!connected) {
      roomStatusText.textContent = online.status === 'offline' || online.status === 'connecting' ? '正在重连，棋局已保留；网络恢复后继续。' : '连接已关闭，请离开后重新邀请好友。';
    } else if (room.status === 'waiting') {
      roomStatusText.textContent = '等待好友直连。';
    } else if (room.status === 'ended') {
      roomStatusText.textContent = '本局已结束。再来一局必须双方同意。';
    } else if (room.paused) {
      roomStatusText.textContent = '对手断线，对局暂停；对手重连后才能继续走棋。';
    } else {
      roomStatusText.textContent = `对局进行中 · 轮到${colorName(room.state.turn)}。`;
    }

    shareUrl.textContent = (room.random || room.transport === 'dht') ? '随机联机 · 对局使用双方独立连接' : room.transport === 'relay' ? '加密中继 · 棋局仅由双方设备处理' : '好友直连 · 棋局不经过游戏服务器';
    playersLine.replaceChildren();
    for (const player of room.players) {
      const chip = document.createElement('span');
      chip.className = `player-chip ${player.color}${player.connected ? '' : ' disconnected'}`;
      const stone = document.createElement('span');
      stone.className = 'tiny-stone';
      const text = `${colorName(player.color)}${player.occupied ? (player.connected ? ' 在线' : ' 断线') : ' 虚位'}`;
      chip.append(stone, document.createTextNode(text));
      playersLine.append(chip);
    }

    const pending = pendingOnlineAction();
    if (pending) {
      restartNotice.hidden = false;
      const action = pending.kind === 'undo' ? '撤销上一手' : '开始新棋局';
      restartNotice.textContent = pending.requestedBy === online.seat
        ? `已申请${action}，等待对方同意；继续落子会使本次申请失效。`
        : `对方申请${action}，只有你同意后才会执行。`;
    } else {
      restartNotice.hidden = true;
      restartNotice.textContent = '';
    }

    if (room.status === 'ended' || room.status === 'playing') {
      onlineRestartBtn.hidden = false;
      onlineRestartBtn.textContent = pending ? '等待申请处理' : room.status === 'ended' ? '再来一局' : '申请新棋局';
      onlineRestartBtn.disabled = Boolean(pending) || !connected || !room.bothConnected;
    } else {
      onlineRestartBtn.hidden = true;
      onlineRestartBtn.disabled = true;
    }
  }

  function pendingOnlineAction() {
    const room = online.room;
    return room?.pendingAction || (room?.pendingRestart ? { ...room.pendingRestart, kind: 'restart' } : null);
  }

  function renderOnlineRequest() {
    const pending = pendingOnlineAction();
    if (!pending || pending.requestedBy === online.seat || !online.connected || !online.room.bothConnected) {
      if (requestDialog.open) requestDialog.close();
      return;
    }
    requestDialog.dataset.requestId = pending.id || 'legacy-restart';
    $('onlineRequestTitle').textContent = pending.kind === 'undo' ? '对方申请悔棋' : '对方申请新棋局';
    $('onlineRequestText').textContent = pending.kind === 'undo'
      ? '同意后撤销双方最近的一手，恢复到这一步之前的局面；拒绝则保留当前棋局。'
      : '同意后清空当前棋局并重新洗牌；拒绝则保留当前棋局。';
    if (resultDialog.open) resultDialog.close();
    if (!requestDialog.open) requestDialog.showModal();
  }

  function renderAll() {
    updateTabs();
    $('directCreateBtn').disabled = Boolean(online.roomCode) || directPending;
    joinInviteBtn.disabled = Boolean(online.roomCode) || (directPending && (directLink?.randomMatch || directLink?.transport === 'dht'));
    const randomAvailable = Boolean(window.StrangeChessRandom?.Link.available());
    $('randomMatchBtn').disabled = !randomAvailable || Boolean(online.roomCode) || directPending;
    $('cancelRandomBtn').hidden = !(directPending && (directLink?.randomMatch || directLink?.transport === 'dht'));
    $('randomMatchHint').textContent = !randomAvailable
      ? '当前系统的 WebView 缺少安全联机组件，请更新系统 WebView 后重试。'
      : directPending && (directLink?.randomMatch || directLink?.transport === 'dht')
        ? '连接建立后，匹配节点会释放临时记录；对局走棋只经过双方手机。'
        : '自动寻找在线对手，无需交换邀请。';
    updateCheckState(activeState());
    renderBoard();
    renderStatus();
    renderCaptures();
    renderOnline();
    renderOnlineRequest();
    renderUpdateState();
    renderSoloStatus();
    window.dispatchEvent(new CustomEvent('chess-state', { detail: {
      roomCode: online.roomCode, status: online.room?.status, mode
    } }));
    if (mode === 'solo') void maybePlaySolo();
  }

  function cancelSoloTurn() {
    soloGeneration++;
    soloClient?.cancel();
    soloThinking = false;
    soloStatus = { phase: soloClient?.metadata ? 'ready' : 'idle' };
  }

  function renderSoloStatus() {
    const box = $('aiStatus'), progress = $('aiProgress'), text = $('aiStatusText');
    box.hidden = mode !== 'solo';
    if (mode !== 'solo') return;
    const phase = soloStatus.phase;
    box.dataset.phase = phase;
    box.dataset.completed = String(lastSoloSearch?.simulations || 0);
    box.dataset.model = lastSoloSearch?.modelId || soloClient?.metadata?.id || '';
    progress.hidden = phase !== 'thinking';
    progress.value = soloStatus.done || 0;
    progress.max = AI.SIMULATIONS;
    $('retryAiBtn').hidden = phase !== 'error';
    if (phase === 'error') text.textContent = soloStatus.message;
    else if (phase === 'loading' || phase === 'idle') text.textContent = '正在加载手机本地模型…';
    else if (phase === 'thinking') text.textContent = `模型思考中 · ${soloStatus.done || 0} / ${AI.SIMULATIONS}`;
    else if (soloGame.state.winner) text.textContent = '本局结束 · 历史模型第50轮';
    else text.textContent = lastSoloSearch ? `轮到你了 · 已搜索${AI.SIMULATIONS}次 · ${lastSoloSearch.seconds.toFixed(1)}秒` : '历史模型第50轮 · 轮到你了';
  }

  function ensureSoloModel() {
    if (!soloClient) soloClient = new window.StrangeChessLocalModel(status => {
      soloStatus = status;
      renderSoloStatus();
      if (status.phase === 'ready' && mode === 'solo') void maybePlaySolo();
    });
    if (soloClient.metadata) soloStatus = { phase: 'ready' };
    soloClient.start();
    renderSoloStatus();
    void maybePlaySolo();
  }

  async function maybePlaySolo() {
    if (mode !== 'solo' || soloThinking || soloGame.state.winner ||
        soloGame.state.turn === soloGame.humanColor || !soloClient?.metadata || soloStatus.phase === 'error') return;
    const generation = soloGeneration, state = soloGame.state;
    soloThinking = true;
    clearSelection();
    renderBoard(); renderStatus();
    try {
      const result = await soloClient.think(AI.publicObservation(state));
      if (generation !== soloGeneration || mode !== 'solo' || soloGame.state !== state) return;
      if (result.simulations !== AI.SIMULATIONS || !AIRules.legalActions(state).includes(result.action)) throw Error('模型返回了无效落子，请重试');
      lastSoloSearch = result;
      soloThinking = false;
      const from = Math.floor(result.action / 90), to = result.action % 90;
      if (!makeLocalMove(from % 9, Math.floor(from / 9), to % 9, Math.floor(to / 9))) throw Error('模型落子未完成，请重试');
    } catch (error) {
      if (generation !== soloGeneration || mode !== 'solo') return;
      soloStatus = { phase: 'error', message: error.message || '本地模型暂时无法落子，请重试' };
    } finally {
      if (generation === soloGeneration) { soloThinking = false; renderSoloStatus(); }
    }
  }

  function openSoloDialog() {
    if (online.roomCode) { showToast('请先离开联机房间'); return; }
    $('continueSoloBtn').hidden = soloGame.state.moveNumber === 0 || Boolean(soloGame.state.winner);
    const radio = document.querySelector(`input[name="soloColor"][value="${soloGame.humanColor}"]`);
    if (radio) radio.checked = true;
    $('soloDialog').showModal();
  }

  function rememberMode(value) {
    try { window.AndroidShell?.setGameSave?.(MODE_KEY, value); localStorage.setItem(MODE_KEY, value); } catch { /* private browsing */ }
  }

  function activateSolo(newGame) {
    if (online.roomCode) return;
    if (directPending) resetOnlineRoom();
    cancelSoloTurn();
    mode = 'solo';
    rememberMode(mode);
    if (newGame) {
      soloGame = { ...emptyLocalGame(), humanColor: document.querySelector('input[name="soloColor"]:checked').value };
      soloGame.state = AIRules.enable(soloGame.state, 8, 3);
      soloClient?.reset(); lastSoloSearch = null;
    }
    clearSelection(); resultShownKey = null;
    if (resultDialog.open) resultDialog.close();
    $('soloDialog').close();
    $('mobilePanel').classList.remove('is-open');
    persistLocal();
    renderAll();
    ensureSoloModel();
  }

  function setFeedback(_kicker, message, announceIt = false) {
    // Keep screen-reader move announcements without a visible move-detail row.
    if (announceIt) announce(message);
  }

  function moveFeedbackText(lastMove) {
    if (lastMove.type === 'reveal-king') {
      const target = `${lastMove.targetColor ? colorShort(lastMove.targetColor) : ''}${lastMove.targetName || '将'}`;
      return `${colorName(lastMove.color)}尝试吃 ${coordinate(lastMove.toX, lastMove.toY)} 的暗将：${target}原地亮出，攻击棋子留在原位。本步已计一手，轮到${colorName(E.opposite(lastMove.color))}。`;
    }
    const parts = [];
    const mover = colorName(lastMove.color);
    const pieceName = lastMove.pieceName || '棋子';
    if (lastMove.capturedName) {
      parts.push(`${mover}的${pieceName}从 ${coordinate(lastMove.fromX, lastMove.fromY)} 走到 ${coordinate(lastMove.toX, lastMove.toY)}，吃掉${colorName(lastMove.capturedColor)}${lastMove.capturedName}`);
    } else {
      parts.push(`${mover}的${pieceName}从 ${coordinate(lastMove.fromX, lastMove.fromY)} 走到 ${coordinate(lastMove.toX, lastMove.toY)}`);
    }
    if (lastMove.revealed) {
      parts.push(lastMove.switchedSide
        ? `翻面后归${colorName(lastMove.pieceColor)}所有`
        : `翻面确认为${colorName(lastMove.pieceColor)}棋子`);
    }
    return parts.join('；') + '。';
  }

  function feedbackForMove(lastMove) {
    const kicker = lastMove.type === 'reveal-king' ? '亮将' : lastMove.capturedName ? '吃子' : lastMove.revealed ? '翻面' : '行棋';
    setFeedback(kicker, moveFeedbackText(lastMove), true);
  }

  function makeLocalMove(fromX, fromY, toX, toY) {
    const game = mode === 'solo' ? soloGame : localGame;
    const state = game.state;
    const result = (mode === 'solo' ? AIRules : E).move(state, fromX, fromY, toX, toY);
    if (!result.ok) {
      showToast(result.error);
      return false;
    }
    game.undoStack.push(clone(state));
    if (game.undoStack.length > 35) game.undoStack.shift();
    game.state = result.state;
    appendMoveLog(result.state.lastMove, result.state.moveNumber);
    clearSelection();
    persistLocal();
    renderAll();
    feedbackForMove(result.state.lastMove);
    showResultIfNeeded();
    return true;
  }

  function selectPiece(x, y) {
    const state = activeState();
    const piece = E.at(state, x, y);
    selected = { x, y };
    legalMoves = movesAt(state, x, y);
    boardFocus = { x, y };
    renderBoard();
    renderStatus();
    announce(selectionHint.textContent || '');
  }

  function onCellActivate(x, y) {
    const state = activeState();
    if (!state) return;
    const reason = lockedReason();
    if (reason) {
      showToast(reason);
      return;
    }
    const piece = E.at(state, x, y);
    if (selected) {
      if (selected.x === x && selected.y === y) {
        clearSelection();
        renderAll();
        return;
      }
      if (legalMoves.some(move => move.x === x && move.y === y)) {
        if (mode !== 'online') makeLocalMove(selected.x, selected.y, x, y);
        else sendOnlineMove(selected.x, selected.y, x, y);
        return;
      }
      if (piece && E.owner(piece) === state.turn) {
        selectPiece(x, y);
        return;
      }
      showToast('这个位置不在当前棋子的合法落点内');
      return;
    }
    if (piece && E.owner(piece) === state.turn) {
      selectPiece(x, y);
      return;
    }
    if (piece) {
      showToast(state.winner ? '本局已经结束' : `现在轮到${colorName(state.turn)}，这枚棋暂不可操作`);
      return;
    }
    showToast('请先选择一枚当前一方的棋子');
  }

  function startNewLocalGame() {
    if (mode === 'solo') {
      cancelSoloTurn();
      soloGame = { ...emptyLocalGame(), humanColor: soloGame.humanColor };
      soloGame.state = AIRules.enable(soloGame.state, 8, 3);
      soloClient?.reset();
      lastSoloSearch = null;
      ensureSoloModel();
    } else localGame = emptyLocalGame();
    clearSelection();
    resultShownKey = null;
    if (resultDialog.open) resultDialog.close();
    persistLocal();
    renderAll();
    setFeedback('新局', '已重新洗牌。红先，所有棋子背面朝上。', true);
    showToast('已重新洗牌');
  }

  function undoLocalMove() {
    if (mode === 'solo') {
      if (!soloGame.undoStack.some(state => state.turn === soloGame.humanColor)) return;
      cancelSoloTurn();
      do { soloGame.state = soloGame.undoStack.pop(); soloGame.moveLog.pop(); } while (soloGame.state.turn !== soloGame.humanColor && soloGame.undoStack.length);
      lastSoloSearch = null;
      soloClient?.reset();
      clearSelection(); resultShownKey = null;
      if (resultDialog.open) resultDialog.close();
      persistLocal(); renderAll();
      return;
    }
    if (mode !== 'local') {
      requestOnlineAction('undo');
      return;
    }
    if (!localGame.undoStack.length) {
      showToast('还没有可以悔的棋');
      return;
    }
    localGame.state = localGame.undoStack.pop();
    localGame.moveLog.pop();
    clearSelection();
    resultShownKey = null;
    if (resultDialog.open) resultDialog.close();
    persistLocal();
    renderAll();
    setFeedback('悔棋', '已撤销上一手，暗子重新盖回。', true);
  }

  function resultReasonText(state) {
    const loser = state.winner === E.RED ? E.BLACK : E.RED;
    if (state.endReason === 'king-captured') {
      return `${colorName(loser)}的明面将帅被吃，本局结束。`;
    }
    if (state.endReason === 'no-legal-moves') {
      return `${colorName(loser)}没有合法走法，判负。`;
    }
    return `${colorName(state.winner)}取得了本局胜利。`;
  }

  function showResultIfNeeded() {
    const state = activeState();
    if (!state || !state.winner) {
      if (resultDialog.open) resultDialog.close();
      return;
    }
    const key = `${mode}:${online.roomCode || 'local'}:${state.moveNumber}:${state.winner}:${state.endReason}`;
    if (resultShownKey === key) return;
    resultShownKey = key;
    $('resultMark').textContent = '胜';
    $('resultTitle').textContent = `${colorName(state.winner)}胜`;
    $('resultReason').textContent = resultReasonText(state);
    $('playAgainBtn').textContent = mode === 'online' ? '发起再来一局' : '再来一局';
    if (!resultDialog.open) resultDialog.showModal();
    announce(`${colorName(state.winner)}胜。${resultReasonText(state)}`);
  }

  function socketSend(payload) {
    if (!online.ws || online.ws.readyState !== 1) return false;
    try {
      online.ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  function resetOnlineRoom(closeSocket = true) {
    clearTimeout(online.leaveTimer); online.leaveTimer = null;
    if (closeSocket && online.ws) {
      const previous = online.ws; online.ws = null;
      try { previous.close(); } catch { /* noop */ }
    }
    online.ws = null;
    online.connected = false;
    online.status = 'idle';
    online.roomCode = null;
    online.seat = null;
    online.seatColor = null;
    online.room = null;
    online.moveLog = [];
    online.lastMoveNumber = -1;
    online.sending = false;
    online.matchPhase = 'idle';
    online.matchNotice = '';
    directLink = null; directPending = false;
    $('directInvitePanel').hidden = true;
    $('directInviteOutput').value = '';
    inviteInput.value = '';
    clearSelection();
  }

  function acceptRoom(room) {
    const previousMoveNumber = online.lastMoveNumber;
    const sameBoard = online.room?.roomCode === room.roomCode && JSON.stringify(online.room?.state) === JSON.stringify(room.state);
    if (sameBoard) room.state = online.room.state;
    online.room = room;
    const myColor = room.players?.find(player => player.seat === online.seat)?.color;
    if (myColor === E.RED || myColor === E.BLACK) online.seatColor = myColor;
    const round = room.roomCode + ':' + (room.round || 1);
    if (rememberedRound !== round && online.seatColor) {
      rememberedRound = round;
      try { localStorage.setItem(COLOR_KEY, E.opposite(online.seatColor)); } catch { /* rotation within this connection still works */ }
    }
    online.roomCode = room.roomCode || online.roomCode;
    online.connected = !directLink || directLink.readyState === 1;
    online.status = online.connected ? 'online' : 'offline';
    online.sending = false;
    if (room.state.moveNumber < previousMoveNumber) {
      online.moveLog = [];
      resultShownKey = null;
      if (resultDialog.open) resultDialog.close();
    }
    if (room.state.moveNumber > previousMoveNumber) {
      if (room.state.moveNumber > previousMoveNumber + 1) online.moveLog = [];
      if (room.state.lastMove) {
        online.moveLog.push(logEntry(room.state.lastMove, room.state.moveNumber));
        if (online.moveLog.length > 90) online.moveLog.shift();
        feedbackForMove(room.state.lastMove);
      }
    }
    online.lastMoveNumber = room.state.moveNumber;
    if (!room.state.winner && resultDialog.open) resultDialog.close();
    // Reconnect may deliver several identical snapshots. Keep a selection made
    // between them; only a changed board or paused game invalidates its moves.
    if (!sameBoard || room.paused || !room.bothConnected) clearSelection();
    renderAll();
    if (room.notice) showToast(room.notice);
    showResultIfNeeded();
  }

  function handleServerMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'welcome') return;
    if (message.type === 'joined') {
      online.roomCode = message.roomCode;
      online.seat = message.seat;
      online.seatColor = message.color;
      online.connected = !directLink || directLink.readyState === 1;
      online.status = online.connected ? 'online' : 'offline';
      renderAll();
      return;
    }
    if (message.type === 'room') {
      acceptRoom(message);
      return;
    }
    if (message.type === 'error') {
      online.sending = false;
      const text = message.message || '操作失败';
      setFormMessage(text);
      showToast(text);
      renderAll();
      return;
    }
    if (message.type === 'roomClosed') {
      resetOnlineRoom();
      setFormMessage(message.message || '房间已关闭');
      renderAll();
      showToast(message.message || '房间已关闭');
      return;
    }
    if (message.type === 'left') {
      resetOnlineRoom();
      setFormMessage('已离开房间', true);
      renderAll();
      showToast('已离开房间');
      return;
    }
    if (message.type === 'sessionReplaced') {
      resetOnlineRoom();
      online.status = 'error';
      setFormMessage(message.message || '连接已在另一处打开');
      renderAll();
      showToast(message.message || '连接已在另一处打开');
    }
  }

  function ensureOnlineMode() {
    if (mode === 'online') return;
    cancelSoloTurn();
    soloClient?.close(); soloClient = null;
    rememberMode('local');
    mode = 'online';
    clearSelection();
    if (resultDialog.open) resultDialog.close();
    updateTabs();
  }

  function prepareDirect(random = false) {
    if (online.roomCode) throw new Error('请先离开当前对局');
    resetOnlineRoom(); ensureOnlineMode();
    let initialHostColor = E.RED;
    try { if (localStorage.getItem(COLOR_KEY) === E.BLACK) initialHostColor = E.BLACK; } catch { /* private browsing */ }
    const options = { initialHostColor };
    const link = random ? new window.StrangeChessRandom.Link(options) : new window.StrangeChessDirect.Link(options);
    directLink = link; directPending = true; online.ws = link; online.status = 'connecting';
    $('directInvitePanel').hidden = random; $('directInviteOutput').value = '';
    $('directInviteHint').textContent = '正在准备直连信息…'; $('copyDirectBtn').disabled = true;
    link.addEventListener('message', event => {
      if (online.ws !== link) return;
      const message = JSON.parse(event.data);
      if (message.type === 'joined') { directPending = false; $('directInvitePanel').hidden = true; }
      handleServerMessage(message);
    });
    link.addEventListener('matchstatus', event => {
      if (online.ws !== link || !random) return;
      const detail = event.detail || {};
      online.matchPhase = detail.phase || 'searching';
      online.matchNotice = detail.message || '';
      if (['searching', 'hosting', 'waiting', 'introducing', 'retry', 'notice'].includes(online.matchPhase)) {
        online.connected = false;
        online.status = 'connecting';
        setFormMessage(online.matchNotice || '正在匹配，可以随时取消。');
      }
      renderAll();
    });
    link.addEventListener('state', event => {
      if (online.ws !== link) return;
      if (event.detail === 'searching') {
        online.connected = false; online.status = 'connecting';
        setFormMessage('正在寻找在线对手，可以随时取消匹配。'); renderAll(); return;
      }
      if (event.detail === 'relay-connecting') {
        online.connected = false; online.status = online.room ? 'offline' : 'connecting';
        setFormMessage('正在尝试加密中继，连接不同网络的好友…'); renderAll(); return;
      }
      if (event.detail === 'closed') return;
      online.connected = event.detail === 'connected'; online.status = online.connected ? 'online' : 'offline';
      setFormMessage(online.connected ? '' : '正在自动重连，棋局已保留'); renderAll();
    });
    link.addEventListener('close', event => {
      if (online.ws !== link) return;
      directPending = false; online.connected = false; online.status = 'error';
      const reason = typeof event.detail === 'string' && event.detail ? event.detail : random ? '随机联机已关闭，可以重新匹配。' : '直连已关闭';
      online.matchPhase = random ? 'error' : 'idle'; online.matchNotice = random ? reason : '';
      setFormMessage(reason); renderAll();
    });
    renderAll(); return link;
  }
  function startRandomMatch() {
    let link;
    try {
      if (!window.StrangeChessRandom?.Link.available()) throw new Error('当前系统缺少安全联机组件，请更新系统 WebView');
      link = prepareDirect(true); link.start(); renderAll();
      setTimeout(() => {
        if (online.ws === link && directPending && !online.room && online.matchPhase === 'searching') {
          online.matchNotice = '尚未发现可连接的对手，正在继续寻找。公共发现节点或当前网络也可能暂不可达；可以取消后重试。';
          setFormMessage(online.matchNotice);
          renderAll();
        }
      }, 25000);
    } catch (error) {
      if (link && online.ws === link) resetOnlineRoom();
      setFormMessage(error.message); renderAll();
    }
  }
  function showDirectCode(code, answer) {
    $('directInvitePanel').hidden = false; $('directInviteOutput').value = code; $('copyDirectBtn').disabled = false;
    $('directInviteHint').textContent = answer
      ? '将回复码发给房主。房主粘贴回复码并点击加入后，双方自动进入棋盘。'
      : '将邀请发给好友。收到好友回复码后，粘贴到邀请框并点击加入。';
    $('copyDirectBtn').textContent = answer ? '复制回复码发给房主' : '复制邀请发给好友';
    setFormMessage(answer ? '回复码已生成，等待房主确认' : '邀请已生成，等待好友回复码', true);
  }
  async function createDirectInvite() {
    let link;
    try {
      link = prepareDirect(); setFormMessage('正在生成直连邀请…');
      const code = await link.offer(); if (online.ws === link) showDirectCode(code, false);
    } catch (error) {
      if (link && online.ws === link) { resetOnlineRoom(); setFormMessage(error.message); renderAll(); }
      else if (!link) setFormMessage(error.message);
    }
  }
  async function acceptDirectInvite() {
    try {
      if (online.roomCode) throw new Error('请先离开当前对局');
      const code = inviteInput.value, value = window.StrangeChessDirect.decode(code);
      let link = directLink;
      if (value.type === 'offer') {
        if (directPending) throw new Error('请先取消自己的邀请，再加入好友');
        link = prepareDirect();
      } else if (!link) throw new Error('请先创建邀请，再粘贴好友回复码');
      setFormMessage('正在处理直连信息…');
      const answer = await link.accept(code);
      if (online.ws !== link) return;
      if (answer) showDirectCode(answer, true); else setFormMessage('回复码已接受，正在建立直连…', true);
    } catch (error) { setFormMessage(error.message); }
    renderAll();
  }

  function sendOnlineMove(fromX, fromY, toX, toY) {
    if (!online.ws || online.ws.readyState !== 1) {
      showToast('连接已断开，暂时不能落子');
      return;
    }
    const sent = socketSend({ type: 'move', fromX, fromY, toX, toY });
    if (!sent) {
      showToast('落子发送失败');
      return;
    }
    online.sending = true;
    clearSelection();
    setFeedback('落子', '已发送落子，等待直连对局确认并翻面。', false);
    renderAll();
  }

  function requestOnlineRestart() {
    requestOnlineAction('restart');
  }

  function requestOnlineAction(kind) {
    if (!online.room || !online.connected || !online.room.bothConnected) { showToast('请等待双方连接后再申请'); return; }
    if (pendingOnlineAction()) { showToast('请先处理当前申请'); return; }
    if (kind === 'undo' && !online.room.canUndo) { showToast('还没有可以撤销的棋'); return; }
    if (socketSend({ type: kind === 'undo' ? 'requestUndo' : 'requestRestart' })) {
      showToast(kind === 'undo' ? '已发出悔棋申请，等待对方同意' : '已发出新棋局申请，等待对方同意');
    }
  }

  function respondOnlineAction(accept) {
    const pending = pendingOnlineAction();
    if (!pending || (pending.id || 'legacy-restart') !== requestDialog.dataset.requestId || pending.requestedBy === online.seat) {
      if (requestDialog.open) requestDialog.close();
      return;
    }
    if (socketSend({ type: pending.kind === 'undo' ? 'respondUndo' : 'respondRestart', requestId: pending.id, accept })) requestDialog.close();
  }

  function leaveRoom() {
    if (!online.roomCode) return;
    if (!online.ws || online.ws.readyState !== 1) {
      resetOnlineRoom();
      setFormMessage('已离开房间');
      renderAll();
      return;
    }
    if (!socketSend({ type: 'leaveRoom' })) {
      resetOnlineRoom();
      setFormMessage('已离开房间');
      renderAll();
      return;
    }
    online.leaveTimer = setTimeout(() => {
      if (!online.roomCode) return;
      resetOnlineRoom();
      setFormMessage('已离开房间');
      renderAll();
    }, 1200);
  }

  async function copyText(text) {
    try {
      if (window.desktopBridge?.writeClipboard && await window.desktopBridge.writeClipboard(text)) return true;
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.append(textarea);
        textarea.select();
        const ok = document.execCommand('copy');
        textarea.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }

  function updateTabs() {
    document.body.dataset.mode = mode;
    localModeBtn.classList.toggle('active', mode === 'local');
    $('soloModeBtn').classList.toggle('active', mode === 'solo');
    onlineModeBtn.classList.toggle('active', mode === 'online');
    localModeBtn.setAttribute('aria-selected', String(mode === 'local'));
    $('soloModeBtn').setAttribute('aria-selected', String(mode === 'solo'));
    onlineModeBtn.setAttribute('aria-selected', String(mode === 'online'));
    localModeBtn.disabled = mode === 'online' && Boolean(online.roomCode);
    $('soloModeBtn').disabled = mode === 'online' && Boolean(online.roomCode);
    onlineModeBtn.disabled = false;
  }

  function setMode(next) {
    if (next === 'local' && directPending && !online.roomCode) resetOnlineRoom();
    if (next === mode) return;
    if (next === 'local' && directPending) { showToast('请先取消直连邀请'); return; }
    if (next === 'local' && online.roomCode) {
      showToast('请先离开房间，再切回本地双人');
      return;
    }
    mode = next;
    cancelSoloTurn();
    if (next !== 'solo') { soloClient?.close(); soloClient = null; }
    rememberMode(mode === 'solo' ? 'solo' : 'local');
    clearSelection();
    if (resultDialog.open) resultDialog.close();
    updateTabs();
    renderAll();
  }

  function renderUpdateState() {
    if (!updateState) return;
    const state = updateState;
    const busy = state.status === 'checking' || state.status === 'downloading';
    const ready = state.status === 'ready';
    const playing = Boolean(online.roomCode && online.room?.status !== 'ended');
    $('updateVersion').textContent = `v${state.currentVersion}`;
    $('updateMessage').textContent = state.message || '启动后自动检查，后台下载，退出时更新。';
    $('updateProgress').hidden = state.status !== 'downloading';
    $('updateProgress').value = Math.max(0, Math.min(100, Number(state.progress) || 0));
    $('updateCheckBtn').hidden = state.status === 'disabled';
    $('updateCheckBtn').disabled = busy || ready;
    $('updateCheckBtn').textContent = state.status === 'checking' ? '检查中…' : state.status === 'error' ? '重试更新' : '检查更新';
    $('updateRestartBtn').hidden = !ready;
    $('updateRestartBtn').disabled = playing;
    $('updateDuringGame').hidden = !ready || !playing;
  }

  async function initializeUpdater() {
    const bridge = window.desktopBridge?.updater;
    if (!bridge) return;
    $('updateCard').hidden = false;
    const receive = state => { updateState = state; renderUpdateState(); };
    bridge.onState(receive);
    try { receive(await bridge.state()); }
    catch { $('updateMessage').textContent = '更新服务暂不可用，可继续游玩。'; }
    $('updateCheckBtn').addEventListener('click', async () => {
      try { receive(await bridge.check()); }
      catch { $('updateMessage').textContent = '检查失败，可继续游玩，稍后重试。'; }
    });
    $('updateRestartBtn').addEventListener('click', async () => {
      if (online.roomCode && online.room?.status !== 'ended') return;
      try {
        if (!await bridge.restart()) $('updateMessage').textContent = '更新尚未准备好，请稍后重试。';
      } catch { $('updateMessage').textContent = '暂时无法重启，关闭游戏后仍会尝试更新。'; }
    });
  }

  function initializeDialogs() {
    $('acceptOnlineRequestBtn').addEventListener('click', () => respondOnlineAction(true));
    $('declineOnlineRequestBtn').addEventListener('click', () => respondOnlineAction(false));
    requestDialog.addEventListener('cancel', event => { event.preventDefault(); respondOnlineAction(false); });
    const openRules = () => { if (!rulesDialog.open) rulesDialog.showModal(); };
    rulesBtn.addEventListener('click', openRules);
    $('closeRulesBtn').addEventListener('click', () => rulesDialog.close());
    $('rulesDoneBtn').addEventListener('click', () => rulesDialog.close());
    rulesDialog.addEventListener('click', event => {
      if (event.target === rulesDialog) rulesDialog.close();
    });
    resultDialog.addEventListener('click', event => {
      if (event.target === resultDialog) resultDialog.close();
    });
    $('reviewBtn').addEventListener('click', () => resultDialog.close());
    $('playAgainBtn').addEventListener('click', () => {
      if (mode !== 'online') {
        resultDialog.close();
        startNewLocalGame();
      } else {
        resultDialog.close();
        requestOnlineRestart();
      }
    });
  }

  function initializeControls() {
    $('randomMatchBtn').addEventListener('click', startRandomMatch);
    $('cancelRandomBtn').addEventListener('click', () => {
      if (directPending && (directLink?.randomMatch || directLink?.transport === 'dht') && !online.roomCode) { resetOnlineRoom(); setFormMessage('已取消匹配'); renderAll(); }
    });
    $('directCreateBtn').addEventListener('click', createDirectInvite);
    $('copyDirectBtn').addEventListener('click', async () => { showToast(await copyText($('directInviteOutput').value) ? '已复制，请发给好友' : '复制失败，请手动复制'); });
    $('cancelDirectBtn').addEventListener('click', () => { if (!online.roomCode) { resetOnlineRoom(); setFormMessage('已取消直连'); renderAll(); } });
    localModeBtn.addEventListener('click', () => setMode('local'));
    $('soloModeBtn').addEventListener('click', openSoloDialog);
    $('closeSoloBtn').addEventListener('click', () => $('soloDialog').close());
    $('startSoloBtn').addEventListener('click', () => activateSolo(true));
    $('continueSoloBtn').addEventListener('click', () => activateSolo(false));
    $('retryAiBtn').addEventListener('click', () => { soloClient?.close(); soloClient = null; soloStatus = {phase:'idle'}; ensureSoloModel(); });
    onlineModeBtn.addEventListener('click', () => setMode('online'));
    undoBtn.addEventListener('click', undoLocalMove);
    shuffleBtn.addEventListener('click', () => {
      if (mode === 'online') {
        requestOnlineRestart();
        return;
      }
      if (activeState().moveNumber > 0 && !window.confirm('开始新棋局会清空当前对局，确定吗？')) return;
      startNewLocalGame();
    });
    joinInviteBtn.addEventListener('click', acceptDirectInvite);
    onlineRestartBtn.addEventListener('click', requestOnlineRestart);
    leaveRoomBtn.addEventListener('click', leaveRoom);
    boardGrid.addEventListener('keydown', boardKeyNavigation);
  }

  async function initialize() {
    buildBoard();
    initializeDialogs();
    initializeControls();
    updateTabs();
    renderAll();
    if (mode === 'solo') {
      if (!soloGame.state.check_history) soloGame.state = AIRules.enable(soloGame.state, 8, 3);
      ensureSoloModel();
    }
    // The mobile edition has its own web updater and home-screen installation.
    void initializeUpdater();

    if (localGame.state.moveNumber > 0) {
      const lm = localGame.state.lastMove;
      if (lm) {
        announce(`已恢复上次本地对局，第 ${localGame.state.moveNumber} 手。${moveFeedbackText(lm)}`);
      }
    }
    if (localGame.state.winner) showResultIfNeeded();

  }

  window.mobileGame = {
    isBusy: () => Boolean(online.roomCode || directPending || (activeState().moveNumber > 0 && !activeState().winner)),
    isOnline: () => mode === 'online',
    isSolo: () => mode === 'solo',
    hasRoom: () => Boolean(online.roomCode),
    undo: undoLocalMove
  };
  initialize();
})();
