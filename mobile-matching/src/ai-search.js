(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(require('./game-engine.js'),require('./check-detector.js'),require('./ai-rules.js'));
  else root.StrangeChessAI=factory(root.StrangeChess,root.StrangeChessCheck,root.StrangeChessAIRules);
})(globalThis,function(E,Check,Rules){
  'use strict';
  const KINDS=['rook','horse','elephant','advisor','king','cannon','pawn'];
  const COUNTS=[2,2,2,2,1,2,5], SIZE=44*90, SIMULATIONS=1024;
  const POINTS={rook:10,horse:5,elephant:2,advisor:2,king:0,cannon:5,pawn:1};
  const copy=value=>JSON.parse(JSON.stringify(value));
  const square=p=>p.y*9+p.x;
  const opposite=color=>color==='red'?'black':'red';
  function seeded(seed){let n=seed>>>0;return ()=>{n=(Math.imul(1664525,n)+1013904223)>>>0;return n/4294967296;};}

  // This is the ONLY representation sent across the worker boundary. No IDs,
  // true concealed identities, full game objects or real-game RNG are allowed.
  function publicObservation(state){
    const result={turn:state.turn,winner:state.winner??null,endReason:state.endReason??null,moveNumber:state.moveNumber,
      pieces:state.pieces.map(p=>p.faceUp?{x:p.x,y:p.y,faceUp:true,color:p.color,kind:p.kind}:
        {x:p.x,y:p.y,faceUp:false,slotColor:p.slotColor,slotKind:p.slotKind}).sort((a,b)=>square(a)-square(b)),
      captured:state.captured.map(p=>({color:p.color,kind:p.kind})).sort((a,b)=>a.color.localeCompare(b.color)||a.kind.localeCompare(b.kind))};
    if(state.check_history)result.check_history=Rules.canonicalHistory(state.check_history,state.pieces);
    if(state.repetition_history)result.repetition_history=copy(state.repetition_history);
    return result;
  }
  function encode(observation){
    const planes=new Float32Array(SIZE),pool=[COUNTS.slice(),COUNTS.slice()];
    for(const p of observation.pieces){
      const color=p.faceUp?p.color:p.slotColor,kind=p.faceUp?p.kind:p.slotKind;
      const side=+(color!==observation.turn),k=KINDS.indexOf(kind);
      if(k<0||!E.inside(p.x,p.y))throw Error('Invalid public piece');
      planes[((p.faceUp?0:14)+side*7+k)*90+square(p)]=1;
      if(p.faceUp)pool[side][k]--;
    }
    for(const p of observation.captured){const k=KINDS.indexOf(p.kind);if(k<0)throw Error('Invalid capture');pool[+(p.color!==observation.turn)][k]--;}
    for(let side=0;side<2;side++)for(let k=0;k<7;k++){
      if(pool[side][k]<0)throw Error('Invalid public piece counts');
      planes.fill(pool[side][k]/COUNTS[k],(28+side*7+k)*90,(29+side*7+k)*90);
    }
    planes.fill(+(observation.turn==='red'),42*90,43*90);
    planes.fill(Math.min(observation.moveNumber/512,1),43*90);
    return planes;
  }
  function prepare(observation){
    const root=publicObservation(observation),pool=[COUNTS.slice(),COUNTS.slice()],occupied=new Set();
    if(!['red','black'].includes(root.turn)||!Number.isInteger(root.moveNumber)||root.moveNumber<0)throw Error('Invalid public root');
    const known=p=>{const side=+(p.color==='black'),k=KINDS.indexOf(p.kind);if(k<0||!['red','black'].includes(p.color)||--pool[side][k]<0)throw Error('Invalid hidden pool');};
    root.pieces.forEach((p,id)=>{
      if(!E.inside(p.x,p.y)||occupied.has(square(p)))throw Error('Invalid public square');
      occupied.add(square(p));p.id=id;
      if(p.faceUp){known(p);p.slotColor=p.color;p.slotKind=p.kind;}
      else if(!['red','black'].includes(p.slotColor)||!KINDS.includes(p.slotKind))throw Error('Invalid concealed slot');
    });
    root.captured.forEach((p,id)=>{known(p);p.id='captured_'+id;p.faceUp=true;});
    const identities=[];
    for(let side=0;side<2;side++)for(let k=0;k<7;k++)for(let n=0;n<pool[side][k];n++)identities.push({color:side?'black':'red',kind:KINDS[k]});
    if(identities.length!==root.pieces.filter(p=>!p.faceUp).length)throw Error('Hidden pool does not match board');
    return {root,identities};
  }
  function sample(prepared,seed){
    const random=seeded(seed),identities=prepared.identities.slice();
    for(let i=identities.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[identities[i],identities[j]]=[identities[j],identities[i]];}
    const state=copy(prepared.root);let index=0;
    for(const p of state.pieces)if(!p.faceUp)Object.assign(p,identities[index++]);
    return Object.assign(state,{version:1,revision:state.moveNumber,lastMove:null,lastAction:null});
  }
  function winningActions(observation,actions){
    const kings=new Set(observation.pieces.filter(p=>p.faceUp&&p.kind==='king'&&p.color!==observation.turn).map(square));
    return actions.map(action=>kings.has(action%90));
  }
  function pieceValue(p){return p.kind==='pawn'&&(p.color==='red'?p.y<=4:p.y>=5)?3:POINTS[p.kind];}
  function rewards(before,after,action,config){
    const result=[0,0];if(!config.capture_rewards)return result;
    let capture=0;
    if(after.captured.length>before.captured.length){
      const target=before.pieces.find(p=>square(p)===action%90);
      if(!target)throw Error('Capture target missing');
      if(!target.faceUp&&config.capture_rewards===3){
        const totals={red:0,black:0};for(const p of before.pieces)if(!p.faceUp)totals[p.color]+=pieceValue(p);
        const own=totals[before.turn],other=totals[opposite(before.turn)];
        capture=(own+other)?0.5*(other-own)/(own+other):0;
      }else capture=pieceValue(target)*(target.color===before.turn?-1:1);
    }
    result[0]=capture;result[1]=-capture;
    if(config.capture_rewards===3){
      const kingAlive=after.pieces.some(p=>p.faceUp&&p.kind==='king'&&p.color===before.turn);
      const checked=Check.detectChecks(before).some(c=>c.color===before.turn);
      const escaped=checked&&kingAlive&&(!after.winner||after.winner===before.turn)&&!Check.detectChecks({...after,winner:null}).some(c=>c.color===before.turn);
      if(escaped){result[0]+=30;if(!config.escape_reward_mode)result[1]-=30;}
    }
    return result.map(value=>value*config.process_weight/config.reward_scale);
  }
  class Node{
    constructor(actions,logits,value,observation,config){
      this.actions=actions;this.value=value;this.visits=new Uint32Array(actions.length);this.sums=new Float64Array(actions.length);this.pending=new Uint16Array(actions.length);
      this.winning=winningActions(observation,actions);this.hasWin=this.winning.some(Boolean);this.children=new Set();
      let maximum=-Infinity;for(const action of actions)maximum=Math.max(maximum,logits[action]);
      this.priors=actions.map(action=>Math.exp(logits[action]-maximum));const total=this.priors.reduce((a,b)=>a+b,0);
      if(!Number.isFinite(total)||total<=0||!value.every(Number.isFinite))throw Error('Non-finite model output');
      this.priors=this.priors.map(p=>p/total);
      if(this.hasWin)this.value=[config.value_unit,-config.value_unit];
    }
    select(config){
      let total=0;for(let i=0;i<this.actions.length;i++)total+=this.visits[i]+this.pending[i];
      const root=Math.sqrt(1+total);let best=0,score=-Infinity;
      for(let i=0;i<this.actions.length;i++){
        if(this.hasWin&&!this.winning[i])continue;
        const n=this.visits[i]+this.pending[i];
        const q=n?(this.sums[i]/config.value_unit-this.pending[i])/n:0;
        const next=q+config.c_puct*this.priors[i]*root/(1+n);
        if(next>score){best=i;score=next;}
      }
      return best;
    }
  }
  class Search{
    constructor(evaluate,metadata){
      this.evaluate=evaluate;
      const training=metadata.training_config;
      this.config={...training,...metadata.search,simulations:SIMULATIONS};
      this.config.value_unit=(training.capture_rewards?50:1)/training.reward_scale;
      this.reset();
    }
    reset(){this.nodes=new Map();}
    async nodesFor(positions){
      const batch=new Float32Array(positions.length*SIZE);
      positions.forEach((item,i)=>batch.set(encode(item.observation),i*SIZE));
      const outputs=await this.evaluate(batch,positions.length);
      return positions.map((item,i)=>{
        const own=outputs.value[i*2],other=this.config.escape_reward_mode?outputs.value[i*2+1]:-own;
        const scale=this.config.value_scale??1;
        return new Node(item.actions,outputs.policy.subarray(i*8100,(i+1)*8100),[own*scale,other*scale],item.observation,this.config);
      });
    }
    async run(input,seed,progress=()=>{}){
      const config=this.config,observation=publicObservation(input),key=JSON.stringify(observation),prepared=prepare(observation),rng=seeded(seed);
      if(observation.winner)throw Error('Cannot search a finished game');
      // Real games may outlive the training cap. Always keep a full search
      // horizon ahead instead of making the model stop moving at ply 256.
      const horizon=Math.max(config.max_plies,observation.moveNumber+config.max_depth+1);
      const world=sample(prepared,Math.floor(rng()*4294967296)),actions=Rules.legalActions(world);
      if(!actions.length)throw Error('No legal moves');
      if(!this.nodes.has(key))this.reset();
      else{
        const reachable=new Map(),pending=[key];
        while(pending.length){const current=pending.pop(),node=this.nodes.get(current);if(!node||reachable.has(current))continue;reachable.set(current,node);pending.push(...node.children);}
        this.nodes=reachable;
      }
      let root=this.nodes.get(key),evaluations=0,batches=0;
      if(!root){[root]=await this.nodesFor([{observation,actions}]);this.nodes.set(key,root);evaluations++;batches++;}
      if(JSON.stringify(root.actions)!==JSON.stringify(actions))throw Error('Public legal actions changed');
      const reused=root.visits.reduce((a,b)=>a+b,0);let depthSum=0,maximumDepth=0;
      try{
        for(let start=0;start<SIMULATIONS;start+=config.inference_batch_size){
          const pending=Array.from({length:Math.min(config.inference_batch_size,SIMULATIONS-start)},()=>({state:sample(prepared,Math.floor(rng()*4294967296)),path:[],rewards:[]}));
          const leaves=new Map();
          try{
            for(let depth=0;depth<=config.max_depth;depth++){
              let advanced=0;
              for(const item of pending){
                if(item.value||item.leaf)continue;
                const state=item.state;
                if(state.winner){const v=state.winner===state.turn?config.value_unit:-config.value_unit;item.value=[v,-v];continue;}
                const legal=Rules.legalActions(state);
                if(!legal.length){item.value=[-config.value_unit,config.value_unit];continue;}
                if(state.moveNumber>=horizon){item.value=[0,0];continue;}
                const obs=publicObservation(state),current=JSON.stringify(obs),node=this.nodes.get(current);
                if(!node){leaves.set(current,{observation:obs,actions:legal});item.leaf=current;continue;}
                if(depth===config.max_depth){item.value=node.value;continue;}
                const index=node.select(config),action=node.actions[index];node.pending[index]++;item.path.push([node,index]);
                const from=Math.floor(action/90),to=action%90,result=Rules.move(state,from%9,Math.floor(from/9),to%9,Math.floor(to/9));
                if(!result.ok)throw Error(result.error);
                item.rewards.push(rewards(state,result.state,action,config));
                node.children.add(JSON.stringify(publicObservation(result.state)));item.state=result.state;advanced++;
              }
              if(!advanced)break;
            }
            if(leaves.size){const nodes=await this.nodesFor([...leaves.values()]);let index=0;for(const leaf of leaves.keys())this.nodes.set(leaf,nodes[index++]);evaluations+=leaves.size;batches++;}
            for(const item of pending){
              let value=item.leaf?this.nodes.get(item.leaf).value:item.value;
              depthSum+=item.path.length;maximumDepth=Math.max(maximumDepth,item.path.length);
              for(let i=item.path.length-1;i>=0;i--){
                const [node,index]=item.path[i],reward=item.rewards[i];
                value=[reward[0]+value[1],reward[1]+value[0]];node.visits[index]++;node.sums[index]+=value[0];
              }
            }
          }finally{for(const item of pending)for(const [node,index] of item.path)node.pending[index]--;}
          progress({done:Math.min(SIMULATIONS,start+pending.length),total:SIMULATIONS,evaluations,batches,maximumDepth});
        }
      }catch(error){this.reset();throw error;}
      if(root.visits.reduce((a,b)=>a+b,0)-reused!==SIMULATIONS)throw Error('Incomplete 1024-simulation search');
      let best=0;for(let i=1;i<actions.length;i++)if(root.visits[i]>root.visits[best])best=i;
      const result={action:root.actions[best],simulations:SIMULATIONS,visits:Array.from(root.visits),actions:root.actions.slice(),
        evaluations,batches,reusedVisits:reused,meanDepth:depthSum/SIMULATIONS,maximumDepth};
      if(this.nodes.size>config.tree_node_limit)this.reset();
      return result;
    }
  }
  return {SIMULATIONS,INPUT_SIZE:SIZE,publicObservation,encode,prepare,sample,rewards,Search};
});
