'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
module.exports = { hashFile };
