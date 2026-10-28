'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const E=require('../src/game-engine.js');
const R=require('../src/ai-rules.js');
const AI=require('../src/ai-search.js');
const metadata=require('../assets/ai/model.json');
const emptyModel=async(_,batch)=>({policy:new Float32Array(batch*8100),value:new Float32Array(batch*2)});
function fixture(pieces,turn='red'){
  const captured=[];
  for(const color of ['red','black'])for(const [kind,count] of Object.entries({rook:2,horse:2,elephant:2,advisor:2,king:1,cannon:2,pawn:5})){
    const remaining=count-pieces.filter(p=>p.color===color&&p.kind===kind).length;
    for(let i=0;i<remaining;i++)captured.push({id:'c'+captured.length,color,kind,faceUp:true});
  }
  return R.enable({version:1,revision:0,pieces:pieces.map((p,i)=>({id:i,faceUp:true,slotKind:p.kind,slotColor:p.color,...p})),captured,turn,winner:null,endReason:null,moveNumber:0,lastMove:null,lastAction:null},8,3);
}
test('the complete FP32 deployment is pinned to a completed historical snapshot',()=>{
  assert.equal(metadata.source_status,'completed');assert.equal(metadata.iteration,50);
  assert.equal(metadata.source_run,'dashboard-train-20261028-120845-2ac09955');
  assert.equal(metadata.search.simulations,1024);assert.equal(metadata.precision,'float32');
  const bytes=fs.readFileSync(path.join(__dirname,'../assets/ai/model.onnx'));
  assert.equal(bytes.length,metadata.bytes);assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),metadata.sha256);
  assert.deepEqual(metadata.outputs,['policy','value','process_value']);
});
test('hidden identities, IDs and game RNG never enter observations, encoding or sampled roots',()=>{
  const state=R.enable(E.createGame(()=>.45),8,3),altered=JSON.parse(JSON.stringify(state));
  altered.pieces.forEach(p=>{p.id='private-'+p.id;p.color=p.color==='red'?'black':'red';p.kind='king';});
  altered.privateSeed=1234;
  assert.deepEqual(AI.publicObservation(state),AI.publicObservation(altered));
  assert.deepEqual(AI.encode(AI.publicObservation(state)),AI.encode(AI.publicObservation(altered)));
  const prepared=AI.prepare(AI.publicObservation(state));
  const a=AI.sample(prepared,42),b=AI.sample(prepared,42),c=AI.sample(prepared,43);
  assert.deepEqual(a,b);assert.notDeepEqual(a.pieces,c.pieces);
  a.captured.push({kind:'pawn',color:'red'});assert.equal(b.captured.length,0);assert.equal(prepared.root.captured.length,0);
});
test('a completed move always adds exactly 1024 simulations, including after tree reuse',async()=>{
  const state=R.enable(E.createGame(()=>.45),8,3),search=new AI.Search(emptyModel,metadata),root=AI.publicObservation(state);
  const first=await search.run(root,5);assert.equal(first.simulations,1024);assert.equal(first.visits.reduce((a,b)=>a+b,0),1024);
  assert.ok(R.legalActions(state).includes(first.action));
  const next=await search.run(root,6);assert.equal(next.simulations,1024);assert.equal(next.reusedVisits,1024);assert.equal(next.visits.reduce((a,b)=>a+b,0),2048);
  for(const node of search.nodes.values())assert.ok([...node.pending].every(n=>n===0));
});
test('visible king capture wins even against hostile model priors and still completes 1024 simulations',async()=>{
  const state=fixture([{kind:'king',color:'red',x:0,y:9},{kind:'rook',color:'red',x:4,y:1},{kind:'king',color:'black',x:4,y:0}]);
  const win=(1*9+4)*90+4;
  const model=async(_,n)=>{const outputs=await emptyModel(_,n);for(let i=0;i<n;i++)outputs.policy[i*8100+win]=-100;return outputs;};
  const search=new AI.Search(model,metadata),result=await search.run(AI.publicObservation(state),10);
  assert.equal(result.action,win);assert.equal(result.simulations,1024);
  const moved=R.move(state,4,1,4,0);assert.equal(moved.state.winner,'red');
});
test('failed inference discards partial tree and reservations; no random fallback move',async()=>{
  let calls=0;const search=new AI.Search(async(data,n)=>{if(++calls>1)throw Error('inference unavailable');return emptyModel(data,n);},metadata);
  await assert.rejects(search.run(AI.publicObservation(R.enable(E.createGame(()=>.4),8,3)),2),/inference unavailable/);
  assert.equal(search.nodes.size,0);
});
test('games beyond the training horizon can still request 1024 legal simulations',async()=>{
  const state=fixture([{kind:'king',color:'red',x:0,y:9},{kind:'rook',color:'red',x:4,y:1},{kind:'king',color:'black',x:4,y:0}]);
  state.moveNumber=300;
  const result=await new AI.Search(emptyModel,metadata).run(AI.publicObservation(state),4);
  assert.equal(result.simulations,1024);assert.ok(R.legalActions(state).includes(result.action));
});
const trainer=path.resolve(__dirname,'../../training/check-limit.cjs');
test('mobile single-player legality matches the original training rules over a real trajectory',{skip:!fs.existsSync(trainer)},()=>{
  const T=require(trainer);let a=R.enable(E.createGame(()=>.37),8,3),b=T.enable(JSON.parse(JSON.stringify(a)),8,3);
  for(let i=0;i<160&&!a.winner;i++){
    const actions=R.legalActions(a);assert.deepEqual(actions,T.legalActions(b));if(!actions.length)break;
    const action=actions[(i*17)%actions.length],from=Math.floor(action/90),to=action%90;
    a=R.move(a,from%9,Math.floor(from/9),to%9,Math.floor(to/9)).state;
    b=T.move(b,from%9,Math.floor(from/9),to%9,Math.floor(to/9)).state;
    assert.equal(a.winner,b.winner);assert.equal(a.turn,b.turn);
  }
});
