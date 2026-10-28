// Generated from training/repetition-limit.cjs. Public board strings replace
// SHA256 keys without changing occurrence counts or legality.
(function(root,factory){
 if(typeof module==='object'&&module.exports)module.exports=factory(require('./game-engine.js'));
 else root.StrangeChessAIRepetition=factory(root.StrangeChess);
})(globalThis,function(E){
'use strict';
// Public-board occurrence counts. Irreversible transitions discard positions
// that can no longer recur; checking counters and private piece IDs are absent.


const KINDS=['rook','horse','elephant','advisor','king','cannon','pawn'];
const SYMBOLS='ABCDEFGHIJKLMNOPQRSTUVWXYZab';
const square=p=>p.y*9+p.x;

function validLimit(limit){
 if(!Number.isInteger(limit)||limit<0||limit>1000)throw Error('invalid repetition limit');
 return limit;
}

function positionKey(state){
 const board=Array(90).fill('.'),captured=Array(14).fill(0);
 for(const p of state.pieces){
  const index=KINDS.indexOf(E.kind(p)),color=E.owner(p);
  if(index<0||!['red','black'].includes(color))throw Error('invalid public piece');
  board[square(p)]=SYMBOLS[index+(color==='black'?7:0)+(p.faceUp?0:14)];
 }
 for(const p of state.captured){
  const index=KINDS.indexOf(p.kind);
  if(index<0||!['red','black'].includes(p.color))throw Error('invalid public capture');
  captured[index+(p.color==='black'?7:0)]++;
 }
 return (state.turn==='red'?'r':'b')+board.join('')+'|'+captured.join(',');
}

function canonicalHistory(value,state){
 if(value===undefined||value===null)return null;
 if(typeof value!=='object'||value.version!==1||!validLimit(value.limit)||!Array.isArray(value.counts)||!value.counts.length)
  throw Error('invalid repetition history');
 const seen=new Set();
 const counts=value.counts.map(pair=>{
  if(!Array.isArray(pair)||pair.length!==2||typeof pair[0]!=='string'||!/^[rb][A-Za-z.]{90}\|(?:\d+,){13}\d+$/.test(pair[0])||
     !Number.isInteger(pair[1])||pair[1]<1||pair[1]>value.limit||seen.has(pair[0]))throw Error('invalid repetition count');
  seen.add(pair[0]);return pair.slice();
 }).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
 if(!seen.has(positionKey(state)))throw Error('current position absent from repetition history');
 return {version:1,limit:value.limit,counts};
}

function enable(state,limit){
 validLimit(limit);
 if(!limit){const {repetition_history,...plain}=state;return repetition_history?plain:state;}
 return {...state,repetition_history:{version:1,limit,counts:[[positionKey(state),1]]}};
}

function irreversible(before,after,action){
 if(before.captured.length!==after.captured.length||
    before.pieces.filter(p=>!p.faceUp).length!==after.pieces.filter(p=>!p.faceUp).length)return true;
 const from=Math.floor(action/90),moving=E.at(before,from%9,Math.floor(from/9));
 return Boolean(moving?.faceUp&&moving.kind==='pawn'&&Math.floor(from/9)!==Math.floor((action%90)/9));
}

function nextHistory(before,after,action,prepared){
 const previous=prepared||canonicalHistory(before.repetition_history,before);
 if(!previous)return null;
 const key=positionKey(after);
 const counts=irreversible(before,after,action)?new Map():new Map(previous.counts);
 counts.set(key,(counts.get(key)||0)+1);
 return {version:1,limit:previous.limit,counts:[...counts].sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0)};
}

function saturated(history){return new Set(history?history.counts.filter(pair=>pair[1]>=history.limit).map(pair=>pair[0]):[]);}

function forbidden(state,action,history,blockedKeys,after){
 if(!history)return false;
 const blocked=blockedKeys||saturated(history);if(!blocked.size)return false;
 const from=Math.floor(action/90),to=action%90;
 const moving=E.at(state,from%9,Math.floor(from/9)),target=E.at(state,to%9,Math.floor(to/9));
 // Every hidden move, capture or protected-king reveal is irreversible. Only
 // fully public, non-capturing moves can return to a previously seen board.
 if(!moving||!moving.faceUp||target||moving.kind==='pawn'&&Math.floor(from/9)!==Math.floor(to/9))return false;
 if(!after){const result=E.move(state,from%9,Math.floor(from/9),to%9,Math.floor(to/9));if(!result.ok)throw Error(result.error);after=result.state;}
 return !after.winner&&blocked.has(positionKey(after));
}

return {positionKey,canonicalHistory,enable,nextHistory,saturated,forbidden};

});
