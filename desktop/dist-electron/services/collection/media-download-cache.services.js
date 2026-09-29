import {createHash} from 'node:crypto';
import {mkdir,readdir,stat,rm,utimes,readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {prepareCollectorMediaFile} from './media-preparer.services.js';

// One instance belongs to the desktop TaskManager. Files are scoped to the
// signed-in account/API and their source, never to the displayed product SKU.
export function createCollectorMediaFilePreparer({root,maxCacheBytes=4*1024**3,retentionMs=7*24*60*60_000,
  prepareFile=prepareCollectorMediaFile}={}){
  const active=new Map(),held=new Map(),acknowledged=new Set(),itemRoot=join(root,'items');
  const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const ownerKey=(scope,owner)=>digest([scope,owner.runId,owner.sourceKey]);
  let owners=null,mutations=Promise.resolve();
  const mutate=work=>{
    const result=mutations.catch(()=>{}).then(async()=>{
      if(!owners){
        const loaded=new Map();
        const entries=await readdir(itemRoot).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
        for(const name of entries){
          if(!/^[a-f0-9]{64}\.json$/.test(name))continue;
          const saved=JSON.parse(await readFile(join(itemRoot,name),'utf8'));
          if(saved.version!==1||!saved.cacheScope||!saved.runId||!saved.sourceKey||!Array.isArray(saved.keys)
            ||saved.previousOwner&&(!saved.previousOwner.runId||!saved.previousOwner.sourceKey)
            ||saved.keys.some(key=>!/^[a-f0-9]{64}$/.test(key))||name!==ownerKey(saved.cacheScope,saved)+'.json')
            throw Object.assign(Error('COLLECTOR_MEDIA_CACHE_OWNERSHIP_INVALID'),{code:'COLLECTOR_MEDIA_CACHE_OWNERSHIP_INVALID'});
          loaded.set(name.slice(0,-5),saved);
        }
        owners=loaded;
        for(const saved of owners.values())for(const key of saved.keys)held.set(key,(held.get(key)||0)+1);
      }
      return work();
    });
    mutations=result.catch(()=>{});return result;
  };
  const retain=(key,cacheScope,cacheOwner,previousOwner)=>mutate(async()=>{
    const id=ownerKey(cacheScope,cacheOwner),previous=owners.get(id);
    const reuse=Boolean(key&&held.has(key)),addKey=key&&!previous?.keys.includes(key);
    const predecessor=previousOwner?.runId&&previousOwner?.sourceKey?previousOwner:previous?.previousOwner;
    if(previous&&!addKey&&JSON.stringify(predecessor)===JSON.stringify(previous.previousOwner))return reuse;
    const saved={version:1,cacheScope,runId:cacheOwner.runId,sourceKey:cacheOwner.sourceKey,keys:[...(previous?.keys||[]),...(addKey?[key]:[])],
      ...(predecessor?{previousOwner:{runId:predecessor.runId,sourceKey:predecessor.sourceKey}}:{})};
    await mkdir(itemRoot,{recursive:true,mode:0o700});
    await writeFile(join(itemRoot,id+'.json.tmp'),JSON.stringify(saved),{mode:0o600});
    await rename(join(itemRoot,id+'.json.tmp'),join(itemRoot,id+'.json'));
    owners.set(id,saved);
    if(addKey)held.set(key,(held.get(key)||0)+1);
    return reuse;
  });
  const prune=()=>mutate(async()=>{
      await mkdir(root,{recursive:true,mode:0o700});
      const saved=[];let total=0;
      for(const entry of await readdir(root,{withFileTypes:true})){
        if(!entry.isDirectory()||!/^[a-f0-9]{64}$/.test(entry.name))continue;
        const directory=join(root,entry.name),info=await stat(directory).catch(()=>null);if(!info)continue;
        let bytes=0;
        for(const file of await readdir(directory,{withFileTypes:true}).catch(()=>[]))
          if(file.isFile())bytes+=(await stat(join(directory,file.name)).catch(()=>null))?.size||0;
        total+=bytes;saved.push({key:entry.name,directory,bytes,usedAt:info.mtimeMs});
      }
      for(const entry of saved.sort((a,b)=>a.usedAt-b.usedAt)){
        if(active.has(entry.key)||held.has(entry.key))continue;
        if(!acknowledged.has(entry.key)&&Date.now()-entry.usedAt<=retentionMs&&total<=maxCacheBytes)continue;
        await rm(entry.directory,{recursive:true,force:true});total-=entry.bytes;
        acknowledged.delete(entry.key);
      }
      return total;
  });
  async function prepare(source,options={}){
    const {cacheScope,cacheOwner,previousOwner,signal,onProgress=()=>{},...fileOptions}=options;
    signal?.throwIfAborted();
    if(!cacheScope)return prepareFile(source,options);
    const key=digest([cacheScope,source.sourceUrl,source.purpose]);
    // Register before touching a file. Cancellation releases the live reader,
    // never the business owner that needs its bytes for a later retry.
    const reusePrepared=cacheOwner?.runId&&cacheOwner?.sourceKey?await retain(key,cacheScope,cacheOwner,previousOwner):false;
    signal?.throwIfAborted();
    let entry=active.get(key);
    // An all-cancelled transfer must finish closing its file before a new run
    // reads the durable checkpoint. A single cancelled subscriber cannot stop
    // other tasks still using that same download.
    if(entry?.controller.signal.aborted){
      await entry.promise.catch(()=>{});
      if(active.get(key)===entry)active.delete(key);
      return prepare(source,options);
    }
    if(!entry){
      entry={controller:new AbortController(),subscribers:new Set(),done:false,released:false,file:null,lastProgress:null};
      active.set(key,entry);
      const current=entry;
      current.release=async()=>{
        if(!current.done||current.subscribers.size||current.released)return;
        current.released=true;
        if(active.get(key)===current)active.delete(key);
        await current.file?.cleanup();
        await prune().catch(()=>{});
      };
      current.promise=Promise.resolve().then(async()=>{
        const bytes=await prune(),prefix=await stat(join(root,key,'source')).catch(()=>null);
        // This is an admission limit, not permission to discard unfinished
        // work. In-flight writes and already staged prefixes may still finish.
        if(bytes>=maxCacheBytes&&!(prefix?.isFile()&&prefix.size>0))
          throw Object.assign(Error('COLLECTOR_MEDIA_CACHE_FULL'),{code:'COLLECTOR_MEDIA_CACHE_FULL'});
        const file=await prepareFile(source,{...fileOptions,cacheDirectory:join(root,key),reusePrepared,signal:current.controller.signal,
          onProgress:progress=>{current.lastProgress=progress;for(const subscriber of current.subscribers){try{subscriber.progress(progress);}catch{/* UI progress is optional. */}}}});
        const now=new Date();await utimes(join(root,key),now,now).catch(()=>{});
        current.file=file;return file;
      }).then(file=>{current.done=true;return file;},error=>{current.done=true;throw error;});
      current.promise.then(()=>current.release(),()=>current.release()).catch(()=>{});
    }
    const current=entry,subscriber={progress:onProgress};current.subscribers.add(subscriber);
    if(current.lastProgress){try{onProgress({...current.lastProgress,phase:'sharing'});}catch{/* UI progress is optional. */}}
    return new Promise((resolve,reject)=>{
      const release=async()=>{
        if(!current.subscribers.delete(subscriber))return;
        if(!current.done&&!current.subscribers.size){
          current.controller.abort(signal?.reason);
          await current.promise.catch(()=>{});
        }
        await current.release();
      };
      const abort=()=>{void release().then(()=>reject(signal.reason),()=>reject(signal.reason));};
      signal?.addEventListener('abort',abort,{once:true});
      current.promise.then(file=>{
        signal?.removeEventListener('abort',abort);
        if(signal?.aborted){void release().catch(()=>{});reject(signal.reason);return;}
        resolve({...file,cleanup:release});
      },error=>{
        signal?.removeEventListener('abort',abort);
        void release().then(()=>reject(error),()=>reject(error));
      });
    });
  }
  prepare.retainItem=async({cacheScope,cacheOwner,previousOwner}={})=>{
    if(cacheScope&&cacheOwner?.runId&&cacheOwner?.sourceKey)await retain(null,cacheScope,cacheOwner,previousOwner);
  };
  prepare.acknowledge=async({cacheScope,cacheOwner,previousOwner}={})=>{
    if(!cacheScope||!cacheOwner?.runId||!cacheOwner?.sourceKey)return;
    await mutate(async()=>{
      const ordered=[],visited=new Set();
      const collect=owner=>{
        if(!owner?.runId||!owner?.sourceKey)return;
        const id=ownerKey(cacheScope,owner),saved=owners.get(id);if(!saved||visited.has(id))return;
        visited.add(id);collect(saved.previousOwner);ordered.push({id,saved});
      };
      collect(previousOwner);collect(cacheOwner);
      const current=ordered.find(entry=>entry.id===ownerKey(cacheScope,cacheOwner));
      if(current){
        // Keep both the retry entry point and the older assets reachable if a
        // later owner deletion fails or the app exits between deletions.
        const added=[...new Set(ordered.flatMap(entry=>entry.saved.keys))].filter(key=>!current.saved.keys.includes(key));
        if(added.length){
          current.saved={...current.saved,keys:[...current.saved.keys,...added]};
          await writeFile(join(itemRoot,current.id+'.json.tmp'),JSON.stringify(current.saved),{mode:0o600});
          await rename(join(itemRoot,current.id+'.json.tmp'),join(itemRoot,current.id+'.json'));
          owners.set(current.id,current.saved);
          for(const key of added)held.set(key,(held.get(key)||0)+1);
        }
        ordered.splice(ordered.indexOf(current),1);ordered.push(current);
      }
      for(const {id,saved} of ordered){
        await rm(join(itemRoot,id+'.json'),{force:true});owners.delete(id);
        for(const key of saved.keys){
          const remaining=held.get(key)-1;
          if(remaining>0)held.set(key,remaining);else held.delete(key);
          acknowledged.add(key);
        }
      }
    });
    await prune();
  };
  return prepare;
}
