(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const panel = $('mobilePanel');
  const status = $('mobileStatus');
  for (const id of ['turnPill', 'moveNumber', 'modeLabel', 'checkBanner']) status.append($(id));
  const boardFrame = document.querySelector('.board-frame');
  const captureCard = document.querySelector('.capture-card');
  boardFrame.after(captureCard);
  captureCard.setAttribute('aria-label', '双方被吃掉的棋子');
  captureCard.querySelector('.red-text').textContent = '红方被吃';
  captureCard.querySelector('.dark-text').textContent = '黑方被吃';
  const onlineCard = $('onlineCard'); panel.querySelector('.panel-heading').after(onlineCard);
  const more = document.createElement('details'); more.className = 'extra-tools'; more.id = 'extraTools';
  const summary = document.createElement('summary'); summary.textContent = '更新'; more.append(summary);
  for (const card of panel.querySelectorAll('.mobile-settings, .update-card')) more.append(card);
  panel.append(more);
  function metrics() {
    document.documentElement.style.setProperty('--board-cell', (document.querySelector('#board').clientWidth / 9) + 'px');
    window.dispatchEvent(new Event('strange-chess-board-metrics'));
  }
  if (window.ResizeObserver) new ResizeObserver(metrics).observe(document.querySelector('#board'));
  window.addEventListener('resize', metrics); metrics();
  let lastRoom = null;
  function showPanel(open, view = panel.dataset.view || 'settings') {
    panel.dataset.view = view;
    const settings = view === 'settings';
    onlineCard.hidden = settings;
    more.hidden = !settings;
    $('mobilePanelTitle').textContent = settings ? '设置' : '联机对战';
    panel.setAttribute('aria-label', settings ? '设置' : '联机对战');
    panel.classList.toggle('is-open', open);
    $('toolsBtn').setAttribute('aria-expanded', String(open && settings));
    if (open) { panel.scrollTop = 0; panel.focus({ preventScroll: true }); }
  }
  $('toolsBtn').addEventListener('click', () => showPanel(!panel.classList.contains('is-open') || panel.dataset.view !== 'settings', 'settings'));
  $('closePanelBtn').addEventListener('click', () => showPanel(false));
  $('onlineModeBtn').addEventListener('click', () => { more.open = false; showPanel(true, 'online'); });
  $('localModeBtn').addEventListener('click', () => { if (!window.mobileGame.hasRoom()) showPanel(false); });
  $('soloModeBtn').addEventListener('click', () => { if (!window.mobileGame.hasRoom()) showPanel(false); });
  $('quickUndoBtn').addEventListener('click', () => window.mobileGame.undo());
  window.addEventListener('chess-state', event => {
    const state = event.detail;
    $('quickUndoBtn').disabled = $('undoBtn').disabled;
    $('quickUndoBtn').textContent = state.mode === 'online' ? '申请悔棋' : '悔棋';
    if (state.roomCode && state.status === 'playing' && lastRoom !== state.roomCode) { lastRoom = state.roomCode; showPanel(false); }
    if (!state.roomCode) lastRoom = null;
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') showPanel(false); });

  window.addEventListener('beforeinstallprompt', event => event.preventDefault());
  const message = $('webUpdateMessage');
  if (window.AndroidShell) { message.textContent = '本地棋盘已就绪，正在读取 APK 更新状态…'; return; }
  let registration = null;
  let checking = false;
  let failed = false;
  let initialInstalled = false;
  function updateLabel() {
    if (!registration) return;
    if (registration.waiting) message.textContent = '新版已下载。关闭此站点的所有游戏窗口，再打开即自动更新；当前对局不受影响。';
    else if (failed) message.textContent = '更新暂未完成，已保留当前版，可稍后重试。';
    else if (registration.installing) message.textContent = '正在后台准备完整棋盘…';
    else message.textContent = '离线棋盘已就绪。联网时自动检查更新，对局中保持当前版本。';
  }
  function watchWorker(worker) {
    if (!worker) return;
    const changed = () => {
      if (worker.state === 'redundant') failed = true;
      if (worker.state === 'installed' || worker.state === 'activated') failed = false;
      updateLabel();
    };
    worker.addEventListener('statechange', changed); changed();
  }
  async function checkUpdate() {
    if (!registration || checking) return;
    checking = true; $('webUpdateCheckBtn').disabled = true;
    try { await registration.update(); failed = false; updateLabel(); }
    catch { failed = true; updateLabel(); }
    finally { checking = false; $('webUpdateCheckBtn').disabled = false; }
  }
  $('webUpdateCheckBtn').addEventListener('click', checkUpdate);
  if (!window.isSecureContext || !('serviceWorker' in navigator)) {
    message.textContent = '当前浏览器或地址不支持离线缓存。联网可直接玩；桌面安装与离线更新请使用支持的浏览器和 HTTPS 地址。';
    $('webUpdateCheckBtn').disabled = true;
    return;
  }
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // First install claims the existing page without a reload. Later activation
    // occurs after old windows close; no active game is ever forcibly refreshed.
    initialInstalled = true; updateLabel();
  });
  navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then(async reg => {
    registration = reg;
    watchWorker(reg.installing);
    reg.addEventListener('updatefound', () => { failed = false; watchWorker(reg.installing); updateLabel(); });
    await navigator.serviceWorker.ready;
    initialInstalled = true; updateLabel();
    const target = navigator.serviceWorker.controller || reg.active;
    if (target) {
      const channel = new MessageChannel();
      channel.port1.onmessage = event => { $('webVersion').textContent = (event.data.version ? 'v' + event.data.version + ' · ' : '') + String(event.data.build).slice(0, 6); channel.port1.close(); };
      target.postMessage({ type: 'BUILD' }, [channel.port2]);
    }
    void checkUpdate();
    setInterval(checkUpdate, 60 * 60 * 1000);
    window.addEventListener('online', checkUpdate);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void checkUpdate(); });
  }).catch(() => {
    message.textContent = initialInstalled ? '暂时无法检查更新，可继续使用当前版。' : '离线缓存尚未就绪，请联网后重新打开；当前可继续游玩。';
  });
})();
