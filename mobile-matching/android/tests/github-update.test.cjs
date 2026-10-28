'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const android = path.resolve(__dirname, '..'), root = path.resolve(android, '..');
const config = JSON.parse(fs.readFileSync(path.join(android, '.local/toolchain.json'), 'utf8').replace(/^\uFEFF/, ''));
test('the shipped Java GitHub updater follows approved release redirects and verifies a real APK with failure cleanup', () => {
  const classes = fs.mkdtempSync(path.join(os.tmpdir(), 'ChessGithubUpdate-'));
  function run(name, args) {
    const result = spawnSync(path.join(config.javaBin, name + '.exe'), args, { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr); return result.stdout;
  }
  run('javac', ['-encoding', 'UTF-8', '--release', '8', '-d', classes,
    path.join(android, 'java/cn/strangechess/mobile/UpdateChannel.java'), path.join(__dirname, 'UpdateChannelTest.java')]);
  const build = JSON.parse(fs.readFileSync(path.join(root, 'release/android-build-info.json'), 'utf8'));
  const output = run('java', ['-cp', classes, 'cn.strangechess.mobile.UpdateChannelTest', path.join(root, 'release', build.file)]);
  console.log(output.trim());
  assert.match(output, /GitHub update transport: \d+ checks passed/);
  const updater = fs.readFileSync(path.join(android, 'java/cn/strangechess/mobile/ApkUpdater.java'), 'utf8');
  for (const call of ['UpdateChannel.metadata(base)', 'UpdateChannel.download(base', 'UpdateChannel.copyVerified', 'verifyPackage(partial, code)']) assert.ok(updater.includes(call), call);
  assert.ok(updater.includes('APK 发布者签名不匹配'));
});
