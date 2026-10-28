'use strict';
// Optional regeneration in the training workspace. Generated browser files are
// committed so the mobile application builds without Python or the trainer.
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
let repetition = fs.readFileSync(path.join(ROOT, '../training/repetition-limit.cjs'), 'utf8')
  .replace("const {createHash}=require('node:crypto');", '')
  .replace("const E=require('../src/game-engine.js');", '')
  .replace("return createHash('sha256').update((state.turn==='red'?'r':'b')+board.join('')+'|'+captured.join(',')).digest('base64url');", "return (state.turn==='red'?'r':'b')+board.join('')+'|'+captured.join(',');")
  .replace("!/^[A-Za-z0-9_-]{43}$/.test(pair[0])", "!/^[rb][A-Za-z.]{90}\\|(?:\\d+,){13}\\d+$/.test(pair[0])")
  .replace('module.exports=', 'return ');
repetition = `// Generated from training/repetition-limit.cjs. Public board strings replace\n// SHA256 keys without changing occurrence counts or legality.\n(function(root,factory){\n if(typeof module==='object'&&module.exports)module.exports=factory(require('./game-engine.js'));\n else root.StrangeChessAIRepetition=factory(root.StrangeChess);\n})(globalThis,function(E){\n${repetition}\n});\n`;
fs.writeFileSync(path.join(ROOT, 'src/ai-repetition.js'), repetition);
let rules = fs.readFileSync(path.join(ROOT, '../training/check-limit.cjs'), 'utf8')
  .replace("const E=require('../src/game-engine.js');", '')
  .replace("const {detectChecks}=require('../src/check-detector.js');", 'const {detectChecks}=Check;')
  .replace("const Repetition=require('./repetition-limit.cjs');", '')
  .replace('module.exports=', 'return ');
rules = `// Generated from training/check-limit.cjs; only single-player uses these rules.\n(function(root,factory){\n if(typeof module==='object'&&module.exports)module.exports=factory(require('./game-engine.js'),require('./check-detector.js'),require('./ai-repetition.js'));\n else root.StrangeChessAIRules=factory(root.StrangeChess,root.StrangeChessCheck,root.StrangeChessAIRepetition);\n})(globalThis,function(E,Check,Repetition){\n${rules}\n});\n`;
fs.writeFileSync(path.join(ROOT, 'src/ai-rules.js'), rules);
console.log('Prepared single-player check/repetition rules');
