'use strict';
const fs = require('node:fs');
const path = require('node:path');
function browserRoom() {
  const original = fs.readFileSync(path.join(__dirname, 'game-room.cjs'), 'utf8');
  return `(function(root){'use strict';const module={exports:{}};const engineAdapter=Object.assign({},root.StrangeChess,{createGame:()=>root.SystemRandom.game(root.StrangeChess)});const cryptoAdapter={randomInt:(min,max)=>max===undefined?root.SystemRandom.integer(min):min+root.SystemRandom.integer(max-min),randomBytes:n=>({toString:encoding=>{if(encoding!=='base64url')throw Error('Unsupported encoding');return root.SystemRandom.id(Math.ceil(n*4/3));}})};const require=name=>{if(name==='node:crypto')return cryptoAdapter;if(name==='../src/game-engine.js')return engineAdapter;throw Error('Unknown module');};\n${original}\nroot.StrangeChessRooms=module.exports;})(globalThis);`;
}
module.exports = { browserRoom };
