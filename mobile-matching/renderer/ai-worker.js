'use strict';
// Both the search and complete neural network run in this phone's worker.
importScripts('/src/game-engine.js','/src/check-detector.js','/src/ai-repetition.js','/src/ai-rules.js','/src/ai-search.js','/ai/ort.wasm.min.js');
let session,search,metadata,busy=false;
const ready=(async()=>{
  const response=await fetch('/ai/model.json');
  if(!response.ok)throw Error('历史模型信息无法读取，请重新安装完整 APK');
  metadata=await response.json();
  if(metadata.source_status!=='completed'||metadata.search.simulations!==1024)throw Error('历史模型配置无效');
  const modelResponse=await fetch('/ai/model.onnx');
  if(!modelResponse.ok)throw Error('本地模型无法读取，请重新安装完整 APK');
  const bytes=await modelResponse.arrayBuffer();
  if(bytes.byteLength!==metadata.bytes)throw Error('本地模型不完整');
  if(!self.crypto?.subtle)throw Error('当前系统 WebView 缺少本地模型校验能力，请更新系统 WebView');
  const sha=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
  if(sha!==metadata.sha256)throw Error('本地模型校验失败，请重新安装完整 APK');
  ort.env.wasm.numThreads=1;
  ort.env.wasm.proxy=false;
  ort.env.wasm.wasmPaths=new URL('/ai/',self.location.href).href;
  ort.env.logLevel='error';
  session=await ort.InferenceSession.create(bytes,{executionProviders:['wasm'],graphOptimizationLevel:'all'});
  search=new StrangeChessAI.Search(async(data,batch)=>{
    const input=new ort.Tensor('float32',data,[batch,44,10,9]);
    try{
      const result=await session.run({observations:input},['policy','value']);
      const outputs={policy:new Float32Array(result.policy.data),value:new Float32Array(result.value.data)};
      Object.values(result).forEach(tensor=>tensor.dispose());
      return outputs;
    }finally{input.dispose();}
  },metadata);
  self.postMessage({type:'ready',metadata});
})();
ready.catch(error=>self.postMessage({type:'error',message:error.message||String(error)}));
self.onmessage=async event=>{
  const message=event.data;
  if(message?.type==='reset'){try{await ready;search.reset();}catch{}return;}
  if(!message||message.type!=='search')return;
  if(busy){self.postMessage({type:'error',id:message.id,message:'模型仍在思考'});return;}
  busy=true;
  try{
    await ready;
    const started=performance.now();
    const result=await search.run(message.observation,message.seed,progress=>self.postMessage({type:'progress',id:message.id,...progress}));
    self.postMessage({type:'result',id:message.id,...result,modelId:metadata.id,seconds:(performance.now()-started)/1000});
  }catch(error){self.postMessage({type:'error',id:message.id,message:error.message||String(error)});}
  finally{busy=false;}
};
