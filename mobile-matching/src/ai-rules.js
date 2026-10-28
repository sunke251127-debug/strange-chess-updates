// Generated from training/check-limit.cjs; only single-player uses these rules.
(function(root,factory){
 if(typeof module==='object'&&module.exports)module.exports=factory(require('./game-engine.js'),require('./check-detector.js'),require('./ai-repetition.js'));
 else root.StrangeChessAIRules=factory(root.StrangeChess,root.StrangeChessCheck,root.StrangeChessAIRepetition);
})(globalThis,function(E,Check,Repetition){
'use strict';
// Model-only legality. Stable tokens come from public starting squares, never
// engine IDs or concealed identities. Opponent replies preserve each streak.

const {detectChecks}=Check;

const COLORS=['red','black'];
const square=p=>p.y*9+p.x;
const other=color=>color==='red'?'black':'red';

function validLimit(limit){
  if(!Number.isInteger(limit)||limit<0||limit>1000)throw Error('invalid check limit');
  return limit;
}

function canonicalHistory(value,pieces){
  if(value===undefined||value===null)return null;
  if(typeof value!=='object'||value.version!==1||!validLimit(value.limit))throw Error('invalid check history');
  if(!Array.isArray(value.tracks)||value.tracks.length!==pieces.length)throw Error('invalid public piece tracks');
  const occupied=new Set(pieces.map(square)),squares=new Set(),tokens=new Set();
  const tracks=value.tracks.map(pair=>{
    if(!Array.isArray(pair)||pair.length!==2||!pair.every(n=>Number.isInteger(n)&&n>=0&&n<90)||
       !occupied.has(pair[0])||squares.has(pair[0])||tokens.has(pair[1]))throw Error('invalid public piece track');
    squares.add(pair[0]);tokens.add(pair[1]);return pair.slice();
  }).sort((a,b)=>a[0]-b[0]);
  const history={version:1,limit:value.limit,tracks};
  for(const color of COLORS){
    const streak=value[color];
    if(!streak||!Number.isInteger(streak.count)||streak.count<0||streak.count>value.limit||
       !Array.isArray(streak.attackers)||streak.attackers.length>32||
       !streak.attackers.every(n=>Number.isInteger(n)&&n>=0&&n<90)||
       new Set(streak.attackers).size!==streak.attackers.length||
       Boolean(streak.count)!==Boolean(streak.attackers.length))throw Error('invalid checking streak');
    history[color]={count:streak.count,attackers:streak.attackers.slice().sort((a,b)=>a-b)};
  }
  return history;
}

function enable(state,limit,repetitionLimit=0){
  validLimit(limit);
  const {check_history,...plain}=state;
  const base=check_history?plain:state;
  const enabled=limit?{...base,check_history:{version:1,limit,
    tracks:state.pieces.map(p=>[square(p),square(p)]).sort((a,b)=>a[0]-b[0]),
    red:{count:0,attackers:[]},black:{count:0,attackers:[]}}}:base;
  return Repetition.enable(enabled,repetitionLimit);
}

function nextHistory(before,after,action,prepared){
  const history=canonicalHistory(prepared||before.check_history,before.pieces);
  if(!history)return null;
  const tracks=new Map(history.tracks);
  if(after.lastAction?.type!=='reveal-king'){
    const from=Math.floor(action/90),to=action%90,token=tracks.get(from);
    if(token===undefined)throw Error('missing public moving-piece track');
    tracks.delete(from);tracks.delete(to);tracks.set(to,token);
  }
  const actor=before.turn;
  const check=after.winner?null:detectChecks(after).find(item=>item.color===other(actor));
  const attackers=check?check.attackers.map(p=>tracks.get(square(p))).sort((a,b)=>a-b):[];
  if(attackers.some(token=>token===undefined))throw Error('missing public checking-piece track');
  const previous=history[actor];
  const same=attackers.length===previous.attackers.length&&attackers.every((token,i)=>token===previous.attackers[i]);
  history[actor]={count:attackers.length?(same?previous.count+1:1):0,attackers};
  history.tracks=[...tracks].sort((a,b)=>a[0]-b[0]);
  return history;
}

function baseActions(state){
  const actions=[];
  for(const p of state.pieces)for(const to of E.legalMoves(state,p.x,p.y))
    actions.push(square(p)*90+square(to));
  return actions.sort((a,b)=>a-b);
}

function hiddenPool(state){
  const counts={rook:2,horse:2,elephant:2,advisor:2,king:1,cannon:2,pawn:5};
  const pool=COLORS.flatMap(color=>Object.entries(counts).map(([kind,count])=>({color,kind,count})));
  for(const p of [...state.pieces.filter(p=>p.faceUp),...state.captured]){
    const item=pool.find(item=>item.color===p.color&&item.kind===p.kind);
    if(!item||--item.count<0)throw Error('invalid public hidden pool');
  }
  return pool.filter(item=>item.count>0);
}

function forbidden(state,action,history){
  if(!history||history[state.turn].count<history.limit)return false;
  const from=Math.floor(action/90),to=action%90;
  const moving=E.at(state,from%9,Math.floor(from/9)),target=E.at(state,to%9,Math.floor(to/9));
  if(!moving)return false; // The engine reports malformed moves separately.
  if(target?.faceUp&&target.kind==='king')return false;
  const pool=(!moving.faceUp||target&&!target.faceUp)?hiddenPool(state):[];
  const violates=(identity,captured)=>{
    const world={...state,pieces:state.pieces.map(p=>p===moving?{...p,...identity}:p===target?{...p,...captured}:p)};
    const result=E.move(world,from%9,Math.floor(from/9),to%9,Math.floor(to/9));
    if(!result.ok)throw Error(result.error);
    return !result.state.winner&&nextHistory(state,result.state,action,history)[state.turn].count>history.limit;
  };
  // Hidden kings reveal without moving the attacker; its identity is irrelevant.
  if(target&&!target.faceUp)for(const identity of pool.filter(item=>item.kind==='king'))
    if(violates({}, {color:identity.color,kind:'king'}))return true;
  const movers=moving.faceUp?[{color:moving.color,kind:moving.kind}]:pool;
  for(const identity of movers){
    let captured={};
    if(target&&!target.faceUp){
      // All non-king targets disappear. Only remaining inventory feasibility
      // matters, not their concealed identity or value.
      const possible=pool.find(item=>item.kind!=='king'&&item.count-
        (!moving.faceUp&&item.color===identity.color&&item.kind===identity.kind?1:0)>0);
      if(!possible)continue;
      captured={color:possible.color,kind:possible.kind};
    }
    if(violates({color:identity.color,kind:identity.kind},captured))return true;
  }
  return false;
}

function legalActions(state){
  const actions=baseActions(state);
  const history=canonicalHistory(state.check_history,state.pieces);
  const repeats=Repetition.canonicalHistory(state.repetition_history,state),blocked=Repetition.saturated(repeats);
  if((!history||history[state.turn].count<history.limit)&&!blocked.size)return actions;
  return actions.filter(action=>!forbidden(state,action,history)&&!Repetition.forbidden(state,action,repeats,blocked));
}

function normalize(state){
  if(state.winner||!state.check_history&&!state.repetition_history)return state;
  const history=canonicalHistory(state.check_history,state.pieces);
  const repeats=Repetition.canonicalHistory(state.repetition_history,state);
  if((history&&history[state.turn].count>=history.limit||Repetition.saturated(repeats).size)&&!legalActions(state).length)
    return {...state,winner:other(state.turn),endReason:history&&repeats?'model-rules-no-moves':history?'check-limit-no-moves':'repetition-limit-no-moves'};
  return state;
}

function move(state,fromX,fromY,toX,toY){
  const result=E.move(state,fromX,fromY,toX,toY);
  if(!result.ok||!state.check_history&&!state.repetition_history)return result;
  const action=(fromY*9+fromX)*90+toY*9+toX;
  const previous=canonicalHistory(state.check_history,state.pieces);
  if(forbidden(state,action,previous))
    return {ok:false,error:`同一枚或同一组棋子最多连续将军${previous.limit}次，请换一种走法`};
  const repeats=Repetition.canonicalHistory(state.repetition_history,state);
  if(Repetition.forbidden(state,action,repeats,null,result.state))
    return {ok:false,error:`同一局面最多出现${repeats.limit}次，请换一种走法`};
  const history=nextHistory(state,result.state,action,previous);
  if(history){
    if(history[state.turn].count>history.limit)throw Error('public check-limit prediction mismatch');
    result.state.check_history=history;
  }
  const nextRepeats=Repetition.nextHistory(state,result.state,action,repeats);
  if(nextRepeats){
    if(nextRepeats.counts.some(pair=>pair[1]>nextRepeats.limit))throw Error('public repetition prediction mismatch');
    result.state.repetition_history=nextRepeats;
  }
  result.state=normalize(result.state);
  return result;
}

return {canonicalHistory,enable,nextHistory,legalActions,normalize,move};

});
