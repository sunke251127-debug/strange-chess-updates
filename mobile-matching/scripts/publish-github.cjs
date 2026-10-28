'use strict';
// Explicit publisher: node scripts/publish-github.cjs --publish
// Without --publish this only reviews local files and validates the signed APK.
// Authentication stays in the user's OS Git credential manager, never in files.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),REPO='sunke251127-debug/strange-chess-updates';
const info=require('../release/android-build-info.json'),model=require('../assets/ai/model.json');
const tag='mobile-v'+info.versionName,APK_NAME='strange-chess-matching-android.apk';
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const gitSha=bytes=>crypto.createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
let token;
function credential(){
  if(token)return token;
  const result=spawnSync('git',['credential','fill'],{input:'protocol=https\nhost=github.com\n\n',encoding:'utf8',windowsHide:true,timeout:15000,env:{...process.env,GCM_INTERACTIVE:'Never',GIT_TERMINAL_PROMPT:'0'}});
  if(result.status!==0)throw Error('GitHub login is unavailable in the OS credential manager');
  token=result.stdout.split(/\r?\n/).find(line=>line.startsWith('password='))?.slice(9);
  if(!token)throw Error('GitHub login is unavailable');return token;
}
async function api(endpoint,{method='GET',json,file,name}={}){
  const url=new URL(endpoint,'https://api.github.com');
  if(url.protocol!=='https:'||!['api.github.com','uploads.github.com'].includes(url.hostname))throw Error('Unapproved GitHub API destination');
  if(name)url.searchParams.set('name',name);
  const response=await fetch(url,{method,redirect:'error',headers:{Authorization:'Bearer '+credential(),Accept:'application/vnd.github+json','User-Agent':'strange-chess-mobile-publisher','X-GitHub-Api-Version':'2022-11-28',
    ...(json?{'Content-Type':'application/json'}:{}),...(file?{'Content-Type':'application/octet-stream','Content-Length':String(fs.statSync(file).size)}:{})},
    body:file?fs.createReadStream(file):json?JSON.stringify(json):undefined,...(file?{duplex:'half'}:{}),signal:AbortSignal.timeout(file||json?300000:30000)});
  const data=response.status===204?null:await response.json();
  if(!response.ok){const error=Error('GitHub '+response.status+': '+(data?.message||'request failed'));error.status=response.status;throw error;}
  return data;
}
function files(){
  const entries=[];
  const excluded=new Set(['node_modules','.local','.git','screenshots','artifacts']);
  function walk(directory){
    for(const item of fs.readdirSync(directory,{withFileTypes:true})){
      if(excluded.has(item.name))continue;
      const file=path.join(directory,item.name),relative=path.relative(ROOT,file).replaceAll('\\','/');
      if(item.isSymbolicLink())throw Error('Refusing a symbolic link: '+relative);
      if(item.isDirectory()){walk(file);continue;}
      if(/\.(apk|idsig|log|pyc)$/i.test(relative)||relative.includes('__pycache__/'))continue;
      if(!/\.(js|cjs|mjs|json|html|css|java|xml|ps1|cmd|md|txt|svg|png|webmanifest|onnx|wasm|py)$/i.test(relative)&&!['.gitignore','android/.gitignore','CLOUDFLARED-LICENSE'].includes(relative))continue;
      if(/password|\.p12$|\.pem$|\.key$|toolchain\.json/i.test(relative))throw Error('Publisher identity files must never enter source sync');
      const bytes=fs.readFileSync(file),binary=/\.(onnx|wasm|png)$/i.test(relative);
      entries.push({path:'mobile-matching/'+relative,bytes,binary,sha:gitSha(bytes)});
    }
  }
  // An explicit source allowlist excludes local training runs and build caches.
  for(const directory of ['src','renderer','server','scripts','android','tests','validation','dht','assets','release'])walk(path.join(ROOT,directory));
  for(const name of ['package.json','package-lock.json','README.md','.gitignore','启动手机版.cmd','开启手机公网联机.cmd','CLOUDFLARED-LICENSE']){
    const file=path.join(ROOT,name);if(!fs.existsSync(file))continue;const bytes=fs.readFileSync(file);
    entries.push({path:'mobile-matching/'+name,bytes,binary:false,sha:gitSha(bytes)});
  }
  return entries.sort((a,b)=>a.path.localeCompare(b.path));
}
function validate(){
  const apk=path.join(ROOT,'release',info.file),bytes=fs.readFileSync(apk);
  if(bytes.length!==info.bytes||sha(bytes)!==info.sha256)throw Error('Signed APK and metadata differ');
  if(info.packageId!=='cn.strangechess.mobile.matching'||info.signerSha256!=='ce9a58357f5126eb3d7856387a07f8b89c89309930138a48e78a46914f50fee0')throw Error('Wrong upgrade identity');
  if(info.offlineModel.simulations!==1024||info.offlineModel.sha256!==model.sha256||model.source_status!=='completed')throw Error('Wrong offline model');
  if(sha(fs.readFileSync(path.join(ROOT,'assets/ai/model.onnx')))!==model.sha256)throw Error('Model changed');
  const manifest=require('../release/android-update.json');
  if(manifest.sha256!==info.sha256||manifest.bytes!==info.bytes||manifest.versionName!==info.versionName||manifest.url!==`https://github.com/${REPO}/releases/download/${tag}/${APK_NAME}`)throw Error('Update manifest differs');
  const {FILES,readAsset}=require('../server/mobile-assets.cjs');
  for(const [url,expected] of Object.entries(info.assetHashes)){
    let body=readAsset(url,FILES[url][0]);
    if(url==='/')body=Buffer.from(body.toString('utf8').replace('</body>','  <script src="android-shell.js"></script>\n</body>'));
    if(sha(body)!==expected)throw Error('Rebuild APK after changing '+url);
  }
  const verification=require('../release/offline-verification.json');
  if(verification.apkSha256!==info.sha256||verification.failed!==0||verification.simulations!==1024)throw Error('Current APK must pass verification before publishing');
  return apk;
}
async function publishSource(entries){
  const ref=await api(`/repos/${REPO}/git/ref/heads/main`),parent=ref.object.sha;
  const commit=await api(`/repos/${REPO}/git/commits/${parent}`),base=commit.tree.sha;
  const existing=await api(`/repos/${REPO}/git/trees/${base}?recursive=1`),known=new Map(existing.tree.map(entry=>[entry.path,entry.sha]));
  const readme=fs.readFileSync(path.join(ROOT,'release/github-README.md'));
  const readmeBase=path.join(ROOT,'android/.local/github-readme-base.json');
  if(fs.existsSync(readmeBase)&&known.get('README.md')!==JSON.parse(fs.readFileSync(readmeBase,'utf8')).sha&&known.get('README.md')!==gitSha(readme))throw Error('GitHub README changed after preparation; merge its new content before retrying');
  entries.push({path:'README.md',bytes:readme,binary:false,sha:gitSha(readme)});
  const changed=entries.filter(entry=>known.get(entry.path)!==entry.sha);
  if(!changed.length)return parent;
  const tree=[];
  for(const entry of changed){
    if(entry.binary){
      console.log('Uploading source asset '+entry.path+' ('+entry.bytes.length+' bytes)');
      let blob;
      // Creating an identical blob is idempotent, so an interrupted request
      // can be retried without duplicating or replacing remote user content.
      for(let attempt=0;attempt<3;attempt++){
        try{blob=await api(`/repos/${REPO}/git/blobs`,{method:'POST',json:{content:entry.bytes.toString('base64'),encoding:'base64'}});break;}
        catch(error){if(attempt===2)throw error;console.log('Retrying immutable source blob');}
      }
      if(blob.sha!==entry.sha)throw Error('GitHub source blob integrity mismatch');
      tree.push({path:entry.path,mode:'100644',type:'blob',sha:blob.sha});
    }else tree.push({path:entry.path,mode:'100644',type:'blob',content:entry.bytes.toString('utf8')});
  }
  const created=await api(`/repos/${REPO}/git/trees`,{method:'POST',json:{base_tree:base,tree}});
  const saved=await api(`/repos/${REPO}/git/commits`,{method:'POST',json:{message:'Add mobile offline model play with 1024 simulations per move',tree:created.sha,parents:[parent]}});
  const current=await api(`/repos/${REPO}/git/ref/heads/main`);
  if(current.object.sha!==parent)throw Error('GitHub main changed during sync; review the new head before retrying');
  await api(`/repos/${REPO}/git/refs/heads/main`,{method:'PATCH',json:{sha:saved.sha,force:false}});
  console.log('Source commit '+saved.sha);return saved.sha;
}
async function publishRelease(apk,commit){
  const body=fs.readFileSync(path.join(ROOT,`release/${info.versionName}-发布说明.md`),'utf8');
  let release;try{release=await api(`/repos/${REPO}/releases/tags/${tag}`);}catch(error){if(error.status!==404)throw error;}
  if(release&&!release.draft){
    const asset=release.assets.find(a=>a.name===APK_NAME);
    if(asset?.digest==='sha256:'+info.sha256&&asset.size===info.bytes)return release;
    throw Error('A different published release already uses '+tag);
  }
  if(!release)release=await api(`/repos/${REPO}/releases`,{method:'POST',json:{tag_name:tag,target_commitish:commit,name:'根本就没有这样的象棋 '+info.versionName+' · 本地模型单机对战',body,draft:true,prerelease:false}});
  for(const [name,file] of [[APK_NAME,apk],['android-update.json',path.join(ROOT,'release/android-update.json')],['SHA256SUMS.txt',path.join(ROOT,'release/SHA256SUMS.txt')]]){
    const digest='sha256:'+sha(fs.readFileSync(file)),size=fs.statSync(file).size,previous=release.assets.find(a=>a.name===name);
    if(previous?.state==='uploaded'&&previous.digest===digest&&previous.size===size)continue;
    if(previous)await api(`/repos/${REPO}/releases/assets/${previous.id}`,{method:'DELETE'});
    console.log('Uploading release '+name+' ('+size+' bytes)');
    const uploaded=await api(release.upload_url.replace(/\{.*$/,''),{method:'POST',file,name});
    if(uploaded.state!=='uploaded'||uploaded.size!==size||uploaded.digest!==digest)throw Error('Release asset integrity mismatch; draft remains unpublished');
  }
  const verified=await api(`/repos/${REPO}/releases/${release.id}`);
  if(![APK_NAME,'android-update.json','SHA256SUMS.txt'].every(name=>verified.assets.some(a=>a.name===name&&a.state==='uploaded')))throw Error('Release is incomplete');
  return api(`/repos/${REPO}/releases/${release.id}`,{method:'PATCH',json:{draft:false,make_latest:'true',body}});
}
async function main(){
  const apk=validate(),entries=files();
  console.log(JSON.stringify({version:info.versionName,apkBytes:info.bytes,apkSha256:info.sha256,sourceFiles:entries.length,sourceBytes:entries.reduce((n,e)=>n+e.bytes.length,0),model:model.id,simulations:1024}));
  if(!process.argv.includes('--publish'))return;
  const user=await api('/user');if(user.login!=='sunke251127-debug')throw Error('Wrong GitHub publisher account');
  const commit=await publishSource(entries),release=await publishRelease(apk,commit);
  const latest=await api(`/repos/${REPO}/releases/latest`);
  if(latest.id!==release.id||latest.tag_name!==tag)throw Error('Published release is not the current update feed');
  const result={published:true,commit,source:`https://github.com/${REPO}/tree/${commit}/mobile-matching`,release:release.html_url,apk:release.assets.find(a=>a.name===APK_NAME)?.browser_download_url,sha256:info.sha256};
  fs.writeFileSync(path.join(ROOT,'artifacts/offline-github-published.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
