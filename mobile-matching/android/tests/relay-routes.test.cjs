'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
test('native WebView permits only the two TLS relays and serves fixed glyph/relay assets', () => {
  const android = path.resolve(__dirname, '..');
  const cfg = JSON.parse(fs.readFileSync(path.join(android,'.local/toolchain.json'),'utf8').replace(/^\uFEFF/,''));
  const out = fs.mkdtempSync(path.join(os.tmpdir(),'chess-relay-java-'));
  const run = (name,args) => { const r = spawnSync(path.join(cfg.javaBin,name + '.exe'),args,{encoding:'utf8',windowsHide:true}); assert.equal(r.status,0,r.stdout + r.stderr); return r.stdout; };
  run('javac',['-encoding','UTF-8','--release','8','-d',out,path.join(android,'java/cn/strangechess/mobile/LocalRoutes.java'),path.join(__dirname,'RelayRoutesTest.java')]);
  assert.match(run('java',['-cp',out,'cn.strangechess.mobile.RelayRoutesTest']),/routes passed/);
});
