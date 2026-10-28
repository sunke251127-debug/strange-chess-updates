'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const expected = {
  // Current 1.7.5 baseline, including its 炮 label and consensual room actions.
  'src/game-engine.js': '9647c20fbbdb1727e51f36a76b9b64eb068603e93c556a0159d53effcb5bed07',
  'src/check-detector.js': 'd9ef050bddda8d6ca098ff121d53ca484d3e7e360993bec7d44873a2892eb437',
  'src/invite.js': 'adf46c1209da5814e64621cf692eee6af625a6e91624306093effd93ccbd83cf',
  'server/game-room.cjs': '632ac3070f9a9fef08167746373e4e8a722c701903efb9cd4a3624aa00b620a4',
  'tests/core-browser.test.cjs': '70760a5c6fb0f4f3b56f01552d4af0dd398307f37f039a06f898d6671d9550c3',
  'tests/matchmaking.test.cjs': 'f8f50c9b91abe81571a4e16ae9ce7c91c25ee4aa527e5d68945150e2ab19618e',
  'tests/game-engine.test.cjs': '222209f3eec073958ee1a9e5b591169fa2456bf4d6c4999f5da19228b51ef9df',
  'tests/rule-update.test.cjs': '0de35a8295f57481dd88a9523ea4570044b67e19870fbfacb8bd4c766e545085',
  'tests/reveal-king.test.cjs': '875856d7a55c2d83e4264ad6465f962ca72642274e6fe1d490162a99b9647154',
  'tests/server.test.cjs': 'de15fdb410236ff1aef743de334ab424d20882f0c93e653218d087f94c5dfdf5',
  'tests/server-privacy.test.cjs': '5c9093a25ef075902a49450ad3c91f56432f51802077b7ecfd96569045e5ad28'
};
test('original rule modules and current browser/server regression contracts are preserved byte for byte', () => {
  for (const [file, hash] of Object.entries(expected)) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', file))).digest('hex');
    assert.equal(actual, hash, file);
  }
});
