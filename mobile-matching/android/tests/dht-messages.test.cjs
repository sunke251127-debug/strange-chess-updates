'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const android = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(android, '.local/toolchain.json'), 'utf8').replace(/^\uFEFF/, ''));
test('the actual Java IPC codec preserves fragmented UTF8 and partial writes and bounds stale-session buffers', () => {
  const classes = fs.mkdtempSync(path.join(os.tmpdir(), 'ChessDhtJava-'));
  function run(name, args) {
    const result = spawnSync(path.join(config.javaBin, name + '.exe'), args, { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr); return result.stdout;
  }
  run('javac', ['-encoding', 'UTF-8', '--release', '8', '-d', classes, path.join(android, 'java/cn/strangechess/mobile/DhtMessages.java'), path.join(__dirname, 'DhtMessagesTest.java')]);
  assert.match(run('java', ['-cp', classes, 'cn.strangechess.mobile.DhtMessagesTest']), /checks passed/);
});
