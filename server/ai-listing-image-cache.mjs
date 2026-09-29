import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open,readFile,readdir,rename,rm,stat,statfs} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';

const hash=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const error=code=>Object.assign(new Error(code),{code,stage:'upload'});
const scope=(input,mode)=>[input.accountId,input.taskId,input.sku,mode,mode==='GRID'?null:input.index,
  ...(mode==='GRID'&&input.gridGroup?.id?[input.gridGroup.id]:[])];
const fingerprint=(input,mode)=>hash([mode==='GRID'?input.sources:input.sourceUrl,input.prompt,input.image,
  ...(input.imagePolicy?[input.imagePolicy,input.gridGroup||null]:[])]);

// Earlier saves hashed the gateway's Uint8Array as JSON but wrote raw bytes.
// Match that exact historical checksum without expanding a large image into one JSON string.
function legacyUint8ArrayHash(bytes){
  const digest=createHash('sha256').update('{');
  for(let start=0;start<bytes.length;start+=4096){
    let chunk='';
    for(let index=start;index<Math.min(start+4096,bytes.length);index++)chunk+=`${index?',':''}"${index}":${bytes[index]}`;
    digest.update(chunk);
  }
  return digest.update('}').digest('hex');
}

// The spool contains bounded local geometry facts, never upstream bodies or URLs.
function gridDiagnostic(value){
  if(value?.stage!=='slicing')return null;
  const kept={stage:'slicing'};
  if(['separator_count','tile_rectangle','tile_dimensions','image_decode'].includes(value.reason))kept.reason=value.reason;
  for(const [group,keys] of Object.entries({actual:['width','height'],expected:['columns','rows','width','height','count','tileWidth','tileHeight'],
    detected:['verticalBands','horizontalBands'],tile:['index','width','height']})){
    if(value[group])kept[group]=Object.fromEntries(keys.filter(key=>Number.isSafeInteger(value[group][key])).map(key=>[key,value[group][key]]));
  }
  return kept;
}

// One worker owns this private spool. Known successful results are never evicted:
// only a durable task checkpoint acknowledges them. Full spools stop paid admission.
export function createAiListingResultStore({directory=join(tmpdir(),'ozon-ai-listing-results'),maxBytes=256*1024**2,
  maxEntries=64,maxResultBytes=32*1024**2,minFreeBytes=512*1024**2,clock=Date.now}={}){
  let pending=Promise.resolve();
  const serial=work=>{const job=pending.then(work);pending=job.catch(()=>{});return job;};
  const key=(input,mode)=>hash(scope(input,mode));
  const metadataPath=id=>join(directory,`${id}.json`),bytesPath=id=>join(directory,`${id}.bin`);
  async function metadata(id){try{return JSON.parse(await readFile(metadataPath(id),'utf8'));}catch(caught){if(caught.code==='ENOENT')return null;throw error('AI_LISTING_RESULT_CHECKPOINT_INVALID');}}
  async function atomic(path,bytes){
    const temporary=`${path}.${randomUUID()}.tmp`;let file;
    try{file=await open(temporary,'wx',0o600);await file.writeFile(bytes);await file.sync();await file.close();file=null;await rename(temporary,path);}
    finally{await file?.close();await rm(temporary,{force:true});}
  }
  async function remove(id){await rm(bytesPath(id),{force:true});await rm(metadataPath(id),{force:true});}
  async function scan(){
    let bytes=0,entries=0;
    for(const name of await readdir(directory)){
      // Clean only abandoned atomic-write scratch files and never known results.
      if(/^[a-f0-9]{64}\.(?:bin|json)\.[\w-]+\.tmp$/.test(name)){
        const path=join(directory,name),info=await stat(path);if(clock()-info.mtimeMs>3600_000)await rm(path,{force:true});continue;
      }
      if(!/^[a-f0-9]{64}\.json$/.test(name))continue;
      const id=name.slice(0,-5),value=await metadata(id);
      if(value.state==='reserved'&&clock()-value.createdAt>24*3600_000){await remove(id);continue;}
      bytes+=value.size||maxResultBytes;entries++;
    }
    return {bytes,entries};
  }
  return {
    async load(input,mode){
      const id=key(input,mode),value=await metadata(id);if(!value||value.state==='reserved')return null;
      if(value.fingerprint!==fingerprint(input,mode))throw error('AI_LISTING_RESULT_INPUT_CHANGED');
      let info,bytes;try{info=await stat(bytesPath(id));if(info.size>maxResultBytes||info.size!==value.size)throw Error();bytes=await readFile(bytesPath(id));}catch{throw error('AI_LISTING_RESULT_CHECKPOINT_INVALID');}
      if(hash(bytes)!==value.sha256&&legacyUint8ArrayHash(bytes)!==value.sha256)throw error('AI_LISTING_RESULT_CHECKPOINT_INVALID');
      return {...value.result,bytes,originRequestKey:value.requestKey,...(value.diagnostic?{diagnostic:value.diagnostic}:{})};
    },
    reserve(input,mode){return serial(async()=>{
      await mkdir(directory,{recursive:true,mode:0o700});
      const totals=await scan(),id=key(input,mode),existing=await metadata(id);
      if(existing&&existing.state!=='reserved')throw error('AI_LISTING_RESULT_ALREADY_SAVED');
      const disk=await statfs(directory);
      if(totals.bytes-(existing?maxResultBytes:0)+maxResultBytes>maxBytes||totals.entries-(existing?1:0)>=maxEntries
        ||disk.bavail*disk.bsize<minFreeBytes+maxResultBytes)throw error('AI_LISTING_RESULT_SPOOL_FULL');
      await atomic(metadataPath(id),JSON.stringify({state:'reserved',createdAt:clock(),fingerprint:fingerprint(input,mode),requestKey:input.requestKey}));
    });},
    save(input,mode,result){return serial(async()=>{
      if(!result.bytes?.length||result.bytes.length>maxResultBytes||!['image/png','image/jpeg','image/webp'].includes(result.contentType))throw error('AI_LISTING_STORAGE_FAILED');
      const bytes=Buffer.isBuffer(result.bytes)?result.bytes:Buffer.from(result.bytes);
      const id=key(input,mode),reserved=await metadata(id);
      if(!reserved)throw error('AI_LISTING_RESULT_RESERVATION_MISSING');
      const kept=Object.fromEntries(['contentType','requestId','gatewayRequestId','usage','generationConfig','layout'].filter(name=>result[name]!==undefined).map(name=>[name,result[name]]));
      const value={state:'writing',createdAt:reserved.createdAt,fingerprint:fingerprint(input,mode),requestKey:input.requestKey,size:bytes.length,sha256:hash(bytes),result:kept};
      // Metadata first: a crash cannot turn a known result into permission to repay.
      await atomic(metadataPath(id),JSON.stringify(value));
      await atomic(bytesPath(id),bytes);
      await atomic(metadataPath(id),JSON.stringify({...value,state:'ready'}));
    });},
    release(input,mode){return serial(async()=>{const id=key(input,mode),value=await metadata(id);if(value?.state==='reserved')await remove(id);});},
    recordFailure(input,mode,diagnostic){return serial(async()=>{
      const id=key(input,mode),value=await metadata(id),kept=gridDiagnostic(diagnostic);
      if(!value||value.state==='reserved'||!kept)return;
      if(value.fingerprint!==fingerprint(input,mode))throw error('AI_LISTING_RESULT_INPUT_CHANGED');
      await atomic(metadataPath(id),JSON.stringify({...value,diagnostic:kept}));
    });},
    acknowledge(input){return serial(()=>remove(key(input,input.generationMode==='GRID'?'GRID':'SINGLE')));},
  };
}

// Exact source URLs are intentionally not normalized: signed URLs and variants
// are distinct. Both image bytes and OCR strings share the same bounded LRU.
export function createAiListingSourceCache({maxBytes=48*1024**2,maxEntries=64,ttlMs=15*60_000,clock=Date.now}={}){
  const entries=new Map();let bytes=0;
  const key=(input,url)=>hash([input.accountId,input.taskId,url]);
  function remove(id){const item=entries.get(id);if(item){bytes-=item.size;entries.delete(id);}}
  function get(id){const item=entries.get(id);if(!item)return null;if(clock()-item.at>ttlMs){remove(id);return null;}entries.delete(id);entries.set(id,item);return item;}
  function save(id,value){remove(id);const size=value.buffer.length+Buffer.byteLength(value.text||'');if(size>maxBytes)return;
    while(entries.size>=maxEntries||bytes+size>maxBytes)remove(entries.keys().next().value);
    entries.set(id,{...value,size,at:clock()});bytes+=size;
  }
  return {
    async source(input,url,download){const id=key(input,url),cached=get(id);if(cached)return {buffer:cached.buffer,contentType:cached.contentType};
      const downloaded=await download();save(id,downloaded);return downloaded;},
    async facts(input,urls,buffers,recognize){
      const cached=urls.map(url=>get(key(input,url))),missing=cached.map((item,index)=>item?.text===undefined?index:-1).filter(index=>index>=0);
      const facts=cached.map(item=>item?.text||'');
      if(missing.length){const values=await recognize(missing.map(index=>buffers[index]));
        for(let i=0;i<missing.length;i++){const index=missing[i];facts[index]=String(values[i]||'');const item=cached[index]||{buffer:buffers[index]};save(key(input,urls[index]),{...item,text:facts[index]});}}
      return facts;
    },
    snapshot(){return {bytes,entries:entries.size};},
  };
}

export async function retryListingUpload(write,{sleep=delay}={}){
  for(let attempt=0;;attempt++)try{return await write();}catch(caught){
    const transient=['ECONNRESET','ETIMEDOUT','EAI_AGAIN','ECONNREFUSED','EPIPE','ENETUNREACH','ERR_STREAM_PREMATURE_CLOSE','RequestTimeout','SlowDown','ServiceUnavailable','InternalError'].includes(caught?.code)
      ||[429,500,502,503,504].includes(Number(caught?.statusCode||caught?.status));
    if(!transient||attempt>=2)throw caught;
    await sleep(250*2**attempt);
  }
}
