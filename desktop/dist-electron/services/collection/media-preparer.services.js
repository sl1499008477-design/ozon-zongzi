import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,open,rm,readFile,writeFile,rename,stat,statfs,access} from 'node:fs/promises';
import {createReadStream,constants} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import sharp from 'sharp';
import {load} from 'cheerio';
import {ozonVideoContentType,probeOzonVideoFile,processOzonVideoFile} from '../../../../shared/ozon-video-processing.mjs';

const fail=code=>Object.assign(new Error(code),{code});
const invalidClaim=error=>[401,403].includes(error.status||error.response?.status)
  ||/^COLLECTOR_RUN_/.test(error.code||'')||['COLLECTOR_MEDIA_CLAIM_MISMATCH','COLLECTOR_MEDIA_RECOVERY_SCOPE','ACCOUNT_CHANGED'].includes(error.code);
const videoPurpose=purpose=>['video','video-cover','rich-video'].includes(purpose);
const hosted=url=>/^(?:www\.)?(?:youtube\.com|youtu\.be|rutube\.ru|vk\.com|vkvideo\.ru)$/i.test(new URL(url).hostname);
const ozonMediaCdnHost=hostname=>/^(?:(?:ir(?:-\d+)?|cdn\d+|v-\d+)\.ozone\.ru|ir(?:-\d+)?\.ozonstatic\.cn|cdnvideo\.v\.ozone\.ru)$/u.test(String(hostname||'').toLowerCase());
const benchmarkAddress=address=>{if(isIP(address)!==4)return false;const [a,b]=address.split('.').map(Number);return a===198&&[18,19].includes(b);};
const retryableDownload=error=>/^(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH|ERR_STREAM_PREMATURE_CLOSE|COLLECTOR_MEDIA_DOWNLOAD_TIMEOUT|COLLECTOR_MEDIA_DOWNLOAD_SLOW|COLLECTOR_MEDIA_SOURCE_INCOMPLETE|COLLECTOR_MEDIA_SOURCE_HTTP_(?:429|5\d\d))$/.test(error?.code||'');

// Mirrors the collector's public selector contract; no source field is rewritten.
export function listCollectorMedia(payload={}){
  const result=[],seen=new Set();
  for(const row of [payload,...(payload.variants||[]),...(payload.variantData?.variants||[])]){
    const sourceSku=String(row.sku||row.id||row.product_id||'');if(!sourceSku||seen.has(sourceSku))continue;seen.add(sourceSku);
    const counts={};
    const add=(value,purpose)=>{
      if(typeof value!=='string'||!/^https?:\/\//i.test(value))return;
      const index=counts[purpose]||0;counts[purpose]=index+1;
      try{if(videoPurpose(purpose)&&hosted(value))return;}catch{return;}
      result.push({sourceSku,purpose,index,sourceUrl:value});
    };
    add(row.color_image,'color');
    for(const video of row.videos||[]){add(typeof video==='string'?video:video.url,'video');add(video?.coverUrl,'video-poster');}
    if(!row.videos?.length)add(row.videoUrl,'video');
    add(row.videoCover,'video-poster');add(row.videoCoverUrl,'video-cover');
    const rich=(node,key='',parent='')=>{
      if(Array.isArray(node)){for(const child of node)rich(child,key,parent);return;}
      if(node&&typeof node==='object'){for(const field of Object.keys(node))rich(node[field],field,key);return;}
      if(typeof node!=='string')return;
      if((['src','srcMobile','srcDesktop','poster','backgroundImage'].includes(key)||(key==='url'&&/^(?:img|image|video)$/i.test(parent)))&&/^https?:\/\//i.test(node))
        add(node,(/video/i.test(parent)||/\.(?:mp4|mov)(?:[?#]|$)/i.test(node))&&key!=='poster'?'rich-video':'rich-image');
      for(const tag of node.matchAll(/<(img|video|source)\b[^>]*>/gi))for(const match of tag[0].matchAll(/\b(src|poster)\s*=\s*(["'])(.*?)\2/gi)){
        const decoded=load(`<i data-url=${match[2]}${match[3]}${match[2]}></i>`)('i').attr('data-url');
        add(decoded,/^(?:video|source)$/i.test(tag[1])&&match[1].toLowerCase()!=='poster'?'rich-video':'rich-image');
      }
    };
    let content=row.richContent??row.rich_content;
    if(content===undefined)content=(row.sourceCategory?.attributes||row.attributes||[]).find(a=>Number(a.id||a.key)===11254)?.values?.[0]?.value;
    if(typeof content==='string'){try{content=JSON.parse(content);}catch{ /* Rich HTML is a supported source. */ }}
    rich(content);
  }
  return result;
}

function publicAddress(address){
  // Pin downloads to an inspected public IPv4. IPv6-only sources can explicitly
  // use the existing server path; no private/local network probing is allowed.
  if(isIP(address)!==4)return false;
  const [a,b]=address.split('.').map(Number);
  return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31
    ||a===192&&[0,168].includes(b)||a===100&&b>=64&&b<=127||a===198&&[18,19,51].includes(b)||a===203&&b===0);
}

export async function prepareCollectorMediaFile(source,{signal,ffprobePath=process.env.COLLECTOR_MEDIA_FFPROBE_PATH||
  (process.resourcesPath?join(process.resourcesPath,'media-tools',process.platform==='win32'?'ffprobe.exe':'ffprobe'):''),
  ffmpegPath=process.env.OZON_VIDEO_FFMPEG_PATH||
  (process.resourcesPath?join(process.resourcesPath,'media-tools',process.platform==='win32'?'ffmpeg.exe':'ffmpeg'):''),
  processVideo=processOzonVideoFile,runVideoWork=work=>work(),request=https.request,lookupHost=lookup,temporaryRoot=tmpdir(),cacheDirectory,reusePrepared=false,
  downloadTimeoutMs=videoPurpose(source.purpose)?300_000:30_000,idleTimeoutMs=30_000,retryDelayMs=1000,
  lowSpeedWindowMs=30_000,minDownloadBytesPerSecond=videoPurpose(source.purpose)?16*1024:0,onProgress=()=>{}}={}){
  signal?.throwIfAborted();
  const video=videoPurpose(source.purpose),maxBytes=video?2*1024**3:10*1024**2;
  if(video){try{if(!ffprobePath)throw Error();await access(ffprobePath,constants.X_OK);}catch{throw fail('COLLECTOR_MEDIA_PROBE_UNAVAILABLE');}}
  const directory=cacheDirectory||await mkdtemp(join(temporaryRoot,'ozon-collector-media-'));
  if(cacheDirectory)await mkdir(directory,{recursive:true,mode:0o700});
  let path=join(directory,'source');
  const cleanup=()=>rm(directory,{recursive:true,force:true});
  const release=cacheDirectory?async()=>{}:cleanup;
  let response,file;
  try{
    const room=async required=>{const disk=await statfs(directory);if(Number(disk.bavail)*Number(disk.bsize)<required+64*1024**2)throw fail('COLLECTOR_MEDIA_TEMP_SPACE');};
    const startedAt=Date.now();let target=new URL(source.sourceUrl),size=0,expected=0,etag=null,hash=createHash('md5'),redirects=0;
    const identity=createHash('sha256').update(JSON.stringify([source.sourceUrl,source.purpose])).digest('hex');
    const urlHash=url=>createHash('sha256').update(String(url)).digest('hex');
    let targetHash=urlHash(target),prepared=null;
    let nextDiskCheck=64*1024**2,lastProgress=0,completed=false,lastError;
    const report=(phase,attempt,reason)=>{try{onProgress({phase,attempt,bytes:size,totalBytes:expected,elapsedMs:Date.now()-startedAt,sourceHost:target.hostname,...(reason?{reason}:{})});}catch{/* Progress cannot invalidate a transfer. */}};
    const checkpoint=async()=>{
      if(!cacheDirectory)return;
      await writeFile(join(directory,'download.json.tmp'),JSON.stringify({identity,etag,expected,targetHash,prepared}),{mode:0o600});
      await rename(join(directory,'download.json.tmp'),join(directory,'download.json'));
    };
    const reset=async()=>{size=0;expected=0;etag=null;prepared=null;hash=createHash('md5');nextDiskCheck=64*1024**2;
      await rm(join(directory,'source'),{force:true});await rm(join(directory,'prepared.mp4'),{force:true});};
    if(cacheDirectory){
      try{
        const saved=JSON.parse(await readFile(join(directory,'download.json'),'utf8')),info=await stat(path);
        if(saved.identity!==identity||!Number.isSafeInteger(saved.expected)
          ||saved.expected>maxBytes||!info.isFile()||info.size<=0||info.size>saved.expected)throw Error('stale checkpoint');
        size=info.size;expected=saved.expected;etag=saved.etag;targetHash=saved.targetHash;
        if(size===expected&&['source','prepared.mp4'].includes(saved.prepared?.name)){
          const ready=await stat(join(directory,saved.prepared.name)).catch(()=>null);
          if(ready?.isFile()&&ready.size===saved.prepared.size&&ready.mtimeMs===saved.prepared.mtimeMs)prepared=saved.prepared;
        }
        // A durable item owns these fully validated bytes until its save is
        // acknowledged. Recovery must not need the source to still be online.
        if(prepared&&reusePrepared){signal?.throwIfAborted();return {path:join(directory,prepared.name),size:prepared.size,contentType:prepared.contentType,md5:prepared.md5,cleanup:release};}
        if(!/^"[^"\r\n]+"$/.test(saved.etag||''))throw Error('checkpoint is not resumable');
        if(!prepared)for await(const chunk of createReadStream(path)){signal?.throwIfAborted();hash.update(chunk);}
      }catch(error){if(signal?.aborted)throw signal.reason;await reset();}
    }
    for(let attempt=1;attempt<=3&&!completed;attempt++){
      signal?.throwIfAborted();
      // A healthy transfer has no total deadline. A resumable video may switch
      // a persistently slow connection twice; the last attempt keeps progressing.
      const deadline=new AbortController();
      let progressTimer;
      const touch=(timeout=idleTimeoutMs)=>{clearTimeout(progressTimer);progressTimer=setTimeout(()=>deadline.abort(fail('COLLECTOR_MEDIA_DOWNLOAD_TIMEOUT')),timeout);};
      touch(downloadTimeoutMs);
      const downloadSignal=AbortSignal.any([deadline.signal,...(signal?[signal]:[])]);
      try{
        while(true){
          downloadSignal.throwIfAborted();
          if(target.protocol!=='https:'||target.username||target.password)throw fail('COLLECTOR_MEDIA_URL_BLOCKED');
          const addresses=await lookupHost(target.hostname,{all:true,family:4});
          downloadSignal.throwIfAborted();
          const benchmarkAllowed=!target.port&&ozonMediaCdnHost(target.hostname);
          if(!addresses.length||addresses.some(entry=>!publicAddress(entry.address)
            &&!(benchmarkAllowed&&benchmarkAddress(entry.address))))throw fail('COLLECTOR_MEDIA_URL_BLOCKED');
          const selected=addresses[(attempt-1)%addresses.length],resume=size>0&&etag&&expected>size;
          const verifyComplete=size>0&&etag&&expected===size;
          response=await new Promise((resolve,reject)=>{
            const req=request(target,{method:'GET',agent:false,signal:downloadSignal,
              lookup:(_host,options,callback)=>options?.all?callback(null,[selected]):callback(null,selected.address,4),
              headers:{'Accept-Encoding':'identity','User-Agent':'Ozon-Zongzi-Collector-Media/1.0',
                ...(resume?{Range:`bytes=${size}-`,'If-Range':etag}:verifyComplete?{'If-None-Match':etag}:{})}},res=>{touch();resolve(res);});
            req.on('error',reject);req.end();
          });
          if([301,302,303,307,308].includes(response.statusCode)&&response.headers.location){
            if(++redirects>3)throw fail('COLLECTOR_MEDIA_URL_BLOCKED');
            const next=new URL(response.headers.location,target);response.destroy();
            if(size&&urlHash(next)!==targetHash)await reset();target=next;continue;
          }
          if(verifyComplete&&response.statusCode===304){
            if(response.headers.etag&&response.headers.etag!==etag){await reset();throw fail('COLLECTOR_MEDIA_SOURCE_INCOMPLETE');}
            response.destroy();completed=true;report('cached',attempt);break;
          }
          if(resume&&[206,416].includes(response.statusCode)){
            const range=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(response.headers['content-range']||''));
            if(response.statusCode!==206||!range||response.headers.etag!==etag||Number(range[1])!==size
              ||Number(range[2])!==expected-1||Number(range[3])!==expected){
              response.destroy();await reset();throw fail('COLLECTOR_MEDIA_SOURCE_INCOMPLETE');
            }
          }else if(response.statusCode===200){if(size)await reset();}
          else throw fail('COLLECTOR_MEDIA_SOURCE_HTTP_'+response.statusCode);
          if(response.headers['content-encoding']&&response.headers['content-encoding']!=='identity')throw fail('COLLECTOR_MEDIA_FORMAT_INVALID');
          const length=Number(response.headers['content-length']||0);
          if(!Number.isSafeInteger(length)||length<0||length+size>maxBytes)throw fail('COLLECTOR_MEDIA_TOO_LARGE');
          if(size&&length&&length!==expected-size)throw fail('COLLECTOR_MEDIA_SOURCE_INCOMPLETE');
          if(!size){expected=length;etag=/^"[^"\r\n]+"$/.test(String(response.headers.etag||''))?response.headers.etag:null;targetHash=urlHash(target);}
          await checkpoint();
          await room(expected-size);file=await open(path,size?'a':'w',0o600);report(size?'resuming':'downloading',attempt);
          let rateStarted=Date.now(),rateBytes=size;
          for await(const chunk of response){
            downloadSignal.throwIfAborted();
            touch();
            if(size+chunk.length>maxBytes||expected&&size+chunk.length>expected)throw fail('COLLECTOR_MEDIA_TOO_LARGE');
            await file.writeFile(chunk);size+=chunk.length;hash.update(chunk);
            if(size>=nextDiskCheck){await room(0);nextDiskCheck=size+64*1024**2;}
            if(Date.now()-lastProgress>=5000){report('downloading',attempt);lastProgress=Date.now();}
            const elapsed=Date.now()-rateStarted;
            if(attempt<3&&etag&&minDownloadBytesPerSecond>0&&elapsed>=lowSpeedWindowMs){
              if((size-rateBytes)*1000/elapsed<minDownloadBytesPerSecond
                &&expected-size>minDownloadBytesPerSecond*lowSpeedWindowMs/1000)throw fail('COLLECTOR_MEDIA_DOWNLOAD_SLOW');
              rateStarted=Date.now();rateBytes=size;
            }
          }
          if(!size||expected&&expected!==size)throw fail('COLLECTOR_MEDIA_SOURCE_INCOMPLETE');
          completed=true;report('downloaded',attempt);break;
        }
      }catch(error){
        if(signal?.aborted)throw signal.reason;
        lastError=deadline.signal.aborted?fail('COLLECTOR_MEDIA_DOWNLOAD_TIMEOUT'):error;
        lastError.mediaDiagnostics={attempt,bytes:size,totalBytes:expected,elapsedMs:Date.now()-startedAt,sourceHost:target.hostname};
        if(!retryableDownload(lastError)||attempt===3)throw lastError;
        report('retrying',attempt,lastError.code);
      }finally{clearTimeout(progressTimer);response?.destroy();response=null;await file?.close();file=null;}
      if(!completed){
        if(!(etag&&size>0&&expected>=size))await reset();
        await wait(retryDelayMs*attempt,undefined,{signal});
      }
    }
    if(!completed)throw lastError||fail('COLLECTOR_MEDIA_SOURCE_INCOMPLETE');
    if(!expected)expected=size;
    if(prepared){signal?.throwIfAborted();return {path:join(directory,prepared.name),size:prepared.size,contentType:prepared.contentType,md5:prepared.md5,cleanup:release};}
    let contentType,md5=hash.digest('base64');
    if(video){
      const probe=await probeOzonVideoFile(path,{ffprobePath,signal});contentType=ozonVideoContentType(probe);
      const prepared=await runVideoWork(()=>processVideo({inputPath:path,purpose:source.purpose,contentType,size,probe,ffmpegPath,ffprobePath,
        outputPath:join(directory,'prepared.mp4'),signal}),{signal});
      if(prepared.processed){path=prepared.path;size=prepared.size;contentType=prepared.contentType;const preparedHash=createHash('md5');
        for await(const chunk of createReadStream(path)){signal?.throwIfAborted();preparedHash.update(chunk);}md5=preparedHash.digest('base64');}
    }else{
      try{
        const image=sharp(await readFile(path),{limitInputPixels:40_000_000,failOn:'warning'}),metadata=await image.metadata();
        contentType={jpeg:'image/jpeg',png:'image/png',webp:'image/webp'}[metadata.format];
        if(!contentType||metadata.pages>1)throw Error();await image.raw().toBuffer();
      }catch{throw fail('COLLECTOR_MEDIA_FORMAT_INVALID');}
    }
    if(cacheDirectory){prepared={name:basename(path),size,contentType,md5,mtimeMs:(await stat(path)).mtimeMs};await checkpoint();}
    signal?.throwIfAborted();return {path,size,contentType,md5,cleanup:release};
  }catch(error){
    response?.destroy();await file?.close().catch(()=>{});
    // A new run can reuse a strong-ETag prefix after network failure or cancel.
    // Invalid content is discarded; successful COS receipts are managed above.
    if(!cacheDirectory||!(signal?.aborted||retryableDownload(error)))await cleanup();
    if(signal?.aborted)throw signal.reason;throw error;
  }
}

export async function uploadCollectorMedia(ticket,file,{signal,request=https.request}={}){
  signal?.throwIfAborted();
  const url=new URL(ticket.url);
  if(url.protocol!=='https:'||!url.pathname.startsWith('/staging/collector/'))throw fail('COLLECTOR_MEDIA_UPLOAD_URL_INVALID');
  const body=createReadStream(file.path),uploadSignal=AbortSignal.any([AbortSignal.timeout(300_000),...(signal?[signal]:[])]);
  try{await new Promise((resolve,reject)=>{
    const req=request(url,{method:'PUT',agent:false,signal:uploadSignal,headers:{...ticket.headers,'Content-Length':file.size}},res=>{
      let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>16*1024)res.destroy(fail('COLLECTOR_MEDIA_UPLOAD_FAILED'));});
      res.on('error',reject);res.on('end',()=>res.statusCode>=200&&res.statusCode<300?resolve():reject(fail('COLLECTOR_MEDIA_UPLOAD_FAILED')));
    });
    req.on('error',reject);body.on('error',error=>{req.destroy(error);reject(error);});body.pipe(req);
  });}finally{body.destroy();}
}

// One TaskManager owns these network slots across all of its collection runs.
export function createCollectorMediaWorkQueue({concurrency=4,videoConcurrency=2}={}){
  const pending=[];let active=0,videos=0;
  const advance=()=>{
    while(active<concurrency){
      const index=pending.findIndex(job=>!job.video||videos<videoConcurrency);
      if(index<0)return;
      const job=pending.splice(index,1)[0];job.signal?.removeEventListener('abort',job.abort);
      if(job.signal?.aborted){job.reject(job.signal.reason);continue;}
      active++;if(job.video)videos++;
      Promise.resolve().then(()=>{job.signal?.throwIfAborted();return job.work();}).then(job.resolve,job.reject).finally(()=>{
        active--;if(job.video)videos--;advance();
      });
    }
  };
  return {run(work,{signal,source}={}){
    signal?.throwIfAborted();
    return new Promise((resolve,reject)=>{
      const job={work,signal,resolve,reject,video:videoPurpose(source?.purpose)};
      job.abort=()=>{const index=pending.indexOf(job);if(index<0)return;pending.splice(index,1);reject(signal.reason);};
      signal?.addEventListener('abort',job.abort,{once:true});pending.push(job);advance();
    });
  }};
}

export async function prepareCollectorMedia(item,{capabilities,runId,leaseToken,signal,issue,confirm,recovery,persistIntent,
  prepareFile=prepareCollectorMediaFile,upload=uploadCollectorMedia,onStatus=()=>{},chooseServerFallback,
  concurrency=1,runMediaWork=work=>work()}={}){
  if(capabilities?.mediaDirectUploadV1!==true)return item;
  signal?.throwIfAborted();
  if(!recovery&&(item.mediaPreparation?.status==='ready'||item.mediaPreparation?.mode==='server'))return item;
  const result=structuredClone(item);result.mediaObjects=[...(item.mediaObjects||[])];result.mediaIntents=[...(item.mediaIntents||[])];
  if(recovery)result.mediaRecovery={runId:recovery.runId,itemId:recovery.itemId};
  const sources=listCollectorMedia(item),shared=capabilities.mediaSharedReferencesV1===true;
  const slot=ref=>JSON.stringify([ref.sourceSku,ref.purpose,ref.index,ref.sourceUrl]);
  const asset=ref=>JSON.stringify([ref.purpose,ref.sourceUrl]);
  let recoveryCheckpointPending=false,recoveryCheckpointed=false;
  if(recovery){
    const sourceSlots=new Set(sources.map(slot)),seenSlots=new Set(),seenIds=new Set(),objects=[],intents=[];
    const add=(target,ref)=>{
      const key=slot(ref),id=ref?.uploadId;
      if(!sourceSlots.has(key)||seenSlots.has(key)||!shared&&typeof id==='string'&&seenIds.has(id))return;
      target.push(structuredClone(ref));seenSlots.add(key);if(typeof id==='string')seenIds.add(id);
    };
    for(const ref of result.mediaObjects)add(objects,ref);
    for(const ref of result.mediaIntents)add(intents,ref);
    for(const ref of recovery.mediaObjects||[]){if(sourceSlots.has(slot(ref)))recoveryCheckpointPending=true;add(objects,ref);}
    for(const ref of recovery.mediaIntents||[]){if(sourceSlots.has(slot(ref)))recoveryCheckpointPending=true;add(intents,ref);}
    result.mediaObjects=objects;result.mediaIntents=intents;
  }
  // Keep old receipts on recovery. Only new slots share a compatible receipt;
  // distinct legacy objects must remain accounted for instead of becoming orphans.
  const known=new Map([...result.mediaIntents,...result.mediaObjects].map(ref=>[slot(ref),ref]));
  const preferred=new Map();
  for(const ref of [...result.mediaObjects,...result.mediaIntents])if(!preferred.has(asset(ref)))preferred.set(asset(ref),ref);
  const groups=new Map();
  for(const source of sources){
    const ref=known.get(slot(source))||(shared?preferred.get(asset(source)):null);
    const key=shared?JSON.stringify([asset(source),ref?.uploadId||'new']):slot(source);
    if(!groups.has(key))groups.set(key,{sources:[]});groups.get(key).sources.push(source);
  }
  const jobs=[...groups.values()],controller=new AbortController();
  const workSignal=AbortSignal.any([controller.signal,...(signal?[signal]:[])]);
  let checkpointTail=Promise.resolve(),failure=null,fatal=null;
  const checkpoint=()=>{
    // Snapshot when this write reaches the queue, not when it was enqueued.
    // Every PUT waits for its own durable intent and no older write can win late.
    const next=checkpointTail.then(()=>{workSignal.throwIfAborted();return persistIntent?.(structuredClone({...result,mediaPreparation:{mode:'desktop',status:'preparing'}}));});
    checkpointTail=next.catch(()=>{});return next;
  };
  const setReferences=(job,id,intent)=>{
    const keys=new Set(job.sources.map(slot));
    result.mediaObjects=result.mediaObjects.filter(ref=>!keys.has(slot(ref)));
    result.mediaIntents=result.mediaIntents.filter(ref=>!keys.has(slot(ref)));
    const target=intent?result.mediaIntents:result.mediaObjects;
    for(const source of job.sources)target.push({...source,uploadId:id,...(intent?{size:intent.size,contentType:intent.contentType,md5:intent.md5}:{})});
  };
  const recordFailure=(error,source)=>{
    failure ||= {error,source};
    if(invalidClaim(error)){fatal ||= error;controller.abort(error);}
  };
  if(recoveryCheckpointPending&&persistIntent){
    try{await checkpoint();recoveryCheckpointed=true;}catch(error){recordFailure(error,sources[0]);}
  }
  const reconcile=async job=>{
    if(failure)return;
    const source=job.sources.find(value=>known.has(slot(value)))||job.sources[0],same=ref=>slot(ref)===slot(source);
    job.source=source;
    workSignal.throwIfAborted();
    const currentObject=result.mediaObjects.find(same),pending=result.mediaIntents.find(same);
    const previous=[...(recovery?.mediaObjects||[]),...(recovery?.mediaIntents||[])]
      .find(ref=>same(ref)&&(!(currentObject||pending)||ref.uploadId===(currentObject||pending).uploadId));
    if(currentObject&&!previous){setReferences(job,currentObject.uploadId);job.ready=true;return;}
    let ticket;
    if(currentObject&&recoveryCheckpointed)ticket=await issue(runId,leaseToken,{...source,resumeUploadId:currentObject.uploadId},{signal:workSignal});
    else if(pending&&(recoveryCheckpointed||!previous))ticket=await issue(runId,leaseToken,{...source,resumeUploadId:pending.uploadId},{signal:workSignal});
    else if(previous)ticket=await issue(runId,leaseToken,{...source,resumeUploadId:previous.uploadId,previousItemId:recovery.itemId},{signal:workSignal});
    else if(pending)ticket=await issue(runId,leaseToken,{...source,resumeUploadId:pending.uploadId},{signal:workSignal});
    else return;
    const expected=ticket.intent||pending||previous;
    setReferences(job,ticket.uploadId,expected);
    let confirmed=ticket.confirmed?{mediaObject:ticket.mediaObject}:null;
    if(!confirmed){try{confirmed=await confirm(runId,leaseToken,ticket.uploadId,{signal:workSignal});}catch(error){if(error.code!=='COLLECTOR_MEDIA_NOT_UPLOADED')throw error;}}
    if(confirmed){
      workSignal.throwIfAborted();setReferences(job,confirmed.mediaObject.uploadId);job.ready=true;
    }else{
      job.ticket=ticket;job.expected=expected;
    }
  };
  const stage=async job=>{
    if(failure||job.ready)return;
    const source=job.source;
    workSignal.throwIfAborted();onStatus(`正在本机准备素材：${source.sourceSku} ${source.purpose} ${source.index+1}`);
    job.file=await prepareFile(source,{signal:workSignal});workSignal.throwIfAborted();
    if(job.expected&&['size','contentType','md5'].some(key=>job.file[key]!==job.expected[key]))throw fail('COLLECTOR_MEDIA_SOURCE_CHANGED');
  };
  const transfer=async job=>{
    if(failure||job.ready)return;
    const {source,file}=job;
    workSignal.throwIfAborted();
    const ticket=job.ticket||await issue(runId,leaseToken,{...source,size:file.size,contentType:file.contentType,md5:file.md5},{signal:workSignal});
    const expected=ticket.intent||job.expected||file;
    setReferences(job,ticket.uploadId,expected);
    let confirmed=ticket.confirmed?{mediaObject:ticket.mediaObject}:null;
    if(!confirmed&&!job.ticket){try{confirmed=await confirm(runId,leaseToken,ticket.uploadId,{signal:workSignal});}catch(error){if(error.code!=='COLLECTOR_MEDIA_NOT_UPLOADED')throw error;}}
    if(!confirmed){
      if(['size','contentType','md5'].some(key=>file[key]!==expected[key]))throw fail('COLLECTOR_MEDIA_SOURCE_CHANGED');
      await checkpoint();workSignal.throwIfAborted();
      try{await upload(ticket,file,{signal:workSignal});}catch(error){workSignal.throwIfAborted();try{confirmed=await confirm(runId,leaseToken,ticket.uploadId,{signal:workSignal});}catch(confirmationError){throw invalidClaim(confirmationError)?confirmationError:error;}}
      confirmed ||= await confirm(runId,leaseToken,ticket.uploadId,{signal:workSignal});
    }
    workSignal.throwIfAborted();setReferences(job,confirmed.mediaObject.uploadId);
  };
  const phase=async work=>{
    let cursor=0;
    const worker=async()=>{
      while(!failure&&cursor<jobs.length){
        const job=jobs[cursor++];
        try{await runMediaWork(()=>work(job),{signal:workSignal,source:job.sources[0]});}
        catch(error){recordFailure(error,job.sources[0]);}
      }
    };
    await Promise.all(Array.from({length:Math.min(Math.max(1,concurrency),jobs.length)},worker));
  };
  try{
    // Existing receipts can be reconciled first; no new ticket or PUT is made
    // until every missing local file for this item has reached the barrier.
    // Each individual operation releases its queue slot before the next phase.
    await phase(reconcile);await phase(stage);await phase(transfer);
  }finally{
    // Cache cleanup releases a live reader; durable item ownership is released
    // separately, only after Collection receives the QUALIFIED save receipt.
    await Promise.all(jobs.map(job=>job.file?.cleanup()));
  }
  await checkpointTail;signal?.throwIfAborted();if(fatal)throw fatal;
  const order=new Map(sources.map((source,index)=>[slot(source),index]));
  for(const refs of [result.mediaObjects,result.mediaIntents])refs.sort((a,b)=>order.get(slot(a))-order.get(slot(b)));
  if(failure){
    const {error,source}=failure,code=/^[A-Z0-9_]{1,100}$/.test(error.code||'')?error.code:'COLLECTOR_MEDIA_PREPARATION_FAILED';
    const diagnostic={sourceSku:source?.sourceSku,purpose:source?.purpose,index:source?.index,code,
      ...(error.mediaDiagnostics?{download:error.mediaDiagnostics}:{})};
    onStatus(code==='COLLECTOR_MEDIA_CACHE_FULL'
      ?'本机未完成素材暂存已达容量上限，暂停下载新素材；已有资料已保留，可先完成已有任务或检查暂存空间。'
      :`素材未准备完成：${source?.sourceSku||''} ${code}；原始资料已保留，继续处理其他商品。`);
    const fallback=await chooseServerFallback?.(diagnostic);signal?.throwIfAborted();
    result.mediaPreparation={mode:fallback?'server':'desktop',status:fallback?'fallback':'waiting',diagnostics:[diagnostic]};
    return result;
  }
  result.mediaPreparation={mode:'desktop',status:'ready'};return result;
}
