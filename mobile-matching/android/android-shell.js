(function () {
  'use strict';
  if (!window.AndroidShell) return;
  const $ = id => document.getElementById(id);
  $('webVersion').textContent = 'APK v' + AndroidShell.getVersion();
  const source = document.createElement('details'); source.className = 'update-source';
  source.innerHTML = '<summary>更新来源（默认官方 GitHub）</summary><label class="field-label" for="updateSource">GitHub 仓库或 HTTPS 更新地址</label><input id="updateSource" type="url" autocomplete="off" spellcheck="false" placeholder="https://github.com/sunke251127-debug/strange-chess-updates"><button id="saveUpdateSourceBtn" type="button" class="soft-btn">保存更新地址</button><p class="helper-text">默认从官方仓库检查更新，无需填写。安装更新需要系统确认，不影响好友联机。</p>';
  $('webUpdateCheckBtn').after(source);
  $('updateSource').value = AndroidShell.getServer().replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  $('saveUpdateSourceBtn').addEventListener('click', () => {
    try {
      const url = new URL($('updateSource').value.trim());
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('请输入完整的 HTTPS 更新地址');
      const value = url.hostname === 'github.com' ? url.href.replace(/\/$/, '') : url.origin + '/';
      AndroidShell.setServer(value); $('updateSource').value = AndroidShell.getServer() || value; receive();
    } catch { $('webUpdateMessage').textContent = '请输入完整的 HTTPS 更新地址，例如 https://更新站点。'; }
  });
  const install = document.createElement('button');
  install.id = 'apkInstallBtn'; install.type = 'button'; install.className = 'soft-btn'; install.textContent = '安装更新'; install.hidden = true;
  $('webUpdateCheckBtn').after(install);
  function receive() {
    try {
      const state = JSON.parse(AndroidShell.getUpdateState());
      $('webUpdateMessage').textContent = state.message || '本地棋盘已就绪。';
      $('webUpdateCheckBtn').disabled = ['checking', 'downloading'].includes(state.status);
      install.hidden = state.status !== 'ready';
      install.disabled = window.mobileGame.isBusy();
    } catch { $('webUpdateMessage').textContent = '更新服务暂不可用，可继续游玩。'; }
  }
  $('webUpdateCheckBtn').addEventListener('click', () => { AndroidShell.checkUpdate(); receive(); });
  install.addEventListener('click', () => { if (!window.mobileGame.isBusy()) AndroidShell.installUpdate(); });
  window.addEventListener('chess-state', receive);
  window.receiveNativeInvite = text => {
    $('onlineModeBtn').click(); $('inviteInput').value = String(text).slice(0, 32768);
    $('onlineFormMessage').textContent = '直连信息已填入，点击“加入 / 连接”继续。';
  };
  window.addEventListener('online', () => AndroidShell.checkUpdate());
  receive(); AndroidShell.checkUpdate(); setInterval(receive, 2000); setInterval(() => AndroidShell.checkUpdate(), 6 * 60 * 60 * 1000);
})();
