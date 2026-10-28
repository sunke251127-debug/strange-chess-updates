(function(){
  'use strict';
  class LocalModel{
    constructor(onStatus){this.onStatus=onStatus;this.serial=0;this.worker=null;this.pending=null;this.metadata=null;}
    start(){
      if(this.worker)return;
      if(!window.Worker||!window.WebAssembly){this.onStatus({phase:'error',message:'当前系统 WebView 不支持本地模型，请更新系统 WebView'});return;}
      this.onStatus({phase:'loading',message:'正在加载手机本地模型…'});
      try{this.worker=new Worker('/ai-worker.js');}
      catch(error){this.onStatus({phase:'error',message:'本地模型启动失败：'+error.message});return;}
      const worker=this.worker;
      worker.onmessage=event=>{
        if(this.worker!==worker)return;
        const message=event.data;
        if(message.type==='ready'){this.metadata=message.metadata;this.onStatus({phase:'ready',metadata:this.metadata});return;}
        if(message.type==='error'){
          if(message.id&&message.id!==this.pending?.id)return;
          const pending=this.pending;this.pending=null;pending?.reject(Error(message.message));
          worker.terminate();this.worker=null;this.metadata=null;
          this.onStatus({phase:'error',message:message.message});return;
        }
        if(message.id!==this.pending?.id)return;
        if(message.type==='progress')this.onStatus({phase:'thinking',...message});
        if(message.type==='result'){
          const pending=this.pending;this.pending=null;
          this.onStatus({phase:'ready',result:message,metadata:this.metadata});pending.resolve(message);
        }
      };
      worker.onerror=event=>{
        if(this.worker!==worker)return;
        event.preventDefault();const pending=this.pending;this.pending=null;worker.terminate();this.worker=null;this.metadata=null;
        const message='本地模型加载失败，请更新系统 WebView 后重试';pending?.reject(Error(message));this.onStatus({phase:'error',message});
      };
    }
    think(observation){
      if(!this.worker||!this.metadata||this.pending)return Promise.reject(Error('本地模型尚未就绪'));
      const id=++this.serial,seed=crypto.getRandomValues(new Uint32Array(1))[0];
      this.onStatus({phase:'thinking',done:0,total:1024});
      return new Promise((resolve,reject)=>{
        this.pending={id,resolve,reject};this.worker.postMessage({type:'search',id,observation,seed});
      });
    }
    cancel(){
      // Termination interrupts an outstanding WASM call as well as JS search;
      // stale messages can never move a restarted or different game.
      const pending=this.pending;this.pending=null;this.serial++;
      if(pending){this.worker?.terminate();this.worker=null;this.metadata=null;pending.reject(Error('cancelled'));}
    }
    reset(){this.cancel();this.worker?.postMessage({type:'reset'});}
    close(){this.cancel();this.worker?.terminate();this.worker=null;this.metadata=null;}
  }
  window.StrangeChessLocalModel=LocalModel;
})();
