'use strict';
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { startChessServer, DEFAULT_PORT } = require('../server/server.cjs');
async function main() {
  const value = process.env.STRANGE_CHESS_MOBILE_PORT ?? process.env.PORT ?? DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口必须为 0 到 65535 的整数');
  const server = await startChessServer({ host: process.env.STRANGE_CHESS_MOBILE_HOST || '0.0.0.0', port,
    publicUrl: process.env.STRANGE_CHESS_PUBLIC_URL || null, quiet: true });
  let tunnel;
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    await tunnel?.stop(); await server.close();
  };
  process.once('SIGINT', () => stop().finally(() => process.exit(0)));
  process.once('SIGTERM', () => stop().finally(() => process.exit(0)));
  console.log('根本就没有这样的象棋 · 手机版');
  console.log('本机：' + server.url);
  for (const url of server.lanUrls) console.log('手机同一 Wi-Fi 打开：' + url);
  console.log('保持本窗口运行；Ctrl+C 关闭。添加到桌面与离线缓存请使用 HTTPS。');
  if (process.platform === 'win32' && !process.argv.includes('--no-browser')) {
    const child = spawn('cmd.exe', ['/d', '/c', 'start', '', server.url], { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => {}); child.unref();
  }
  if (process.argv.includes('--internet')) {
    const { LazyTunnel } = require('../server/lazy-tunnel.cjs');
    const { InternetHost } = require('../server/internet-host.cjs');
    tunnel = new LazyTunnel({ directory: path.join(process.env.LOCALAPPDATA || os.homedir(), 'StrangeChessMobile', 'components'), makeHost: binaryPath => new InternetHost({ binaryPath }) });
    tunnel.on('change', state => { if (state.status === 'starting') console.log(state.message); });
    const state = await tunnel.start(server.port);
    if (state.status !== 'ready' || !state.url) { await stop(); throw new Error(state.message || '公网入口启动失败'); }
    server.setPublicUrl(state.url);
    console.log('手机互联网入口：' + state.url);
    console.log('双方打开此 HTTPS 地址，再创建房间邀请或点击联机匹配。临时地址关闭后失效。');
  }
  return server;
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
