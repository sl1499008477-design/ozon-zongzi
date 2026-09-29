import https from 'node:https';
import {mkdtemp,rm,statfs,open} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {validateHttpTarget,resolveAllowedAddresses} from './collector-excel-service.mjs';

const fail=code=>Object.assign(new Error(code),{code});
const transient=error=>/^(?:VIDEO_DOWNLOAD_(?:TIMEOUT|INCOMPLETE|HTTP_5\d\d)|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EPIPE|ERR_STREAM_PREMATURE_CLOSE|COLLECTOR_EXCEL_IMAGE_DNS_FAILED)$/.test(error?.code||'');
const contentLength=value=>value===undefined?0:/^\d+$/.test(String(value))&&Number.isSafeInteger(Number(value))?Number(value):NaN;

// Three regular attempts and three redirects remain the fallback budget. A
// large, explicitly range-capable source may additionally use four parts once.
export async function downloadOzonListingVideo(value,{request=https.request,lookupHost,
  timeoutMs=300_000,maxBytes=2*1024**3,checkControl=async()=>{},onProgress=()=>{},temporaryRoot=tmpdir()}={}){
  const dir=await mkdtemp(join(temporaryRoot,'ozon-listing-video-'));
  const path=join(dir,'source.mp4'),cleanup=()=>rm(dir,{recursive:true,force:true});
  const startedAt=Date.now(),deadline=startedAt+timeoutMs;
  const diagnostics={requests:0,redirects:0,networkBytes:0,discardedBytes:0,resumedBytes:0,downloadMs:0,
    dnsMs:0,connectMs:null,tlsMs:null,headersMs:0,firstByteMs:null,bodyMs:0,lastDataAt:null,lastPhase:'resolving'};
  let size=0,total=0,etag=null,sourceType=null,head=Buffer.alloc(0),hash=createHash('sha256'),parallelAttempted=false;
  const report=async phase=>{await onProgress({phase,elapsedMs:Date.now()-startedAt,bytes:size,...diagnostics});};
  async function reset(){diagnostics.discardedBytes+=size;size=0;total=0;etag=null;sourceType=null;head=Buffer.alloc(0);hash=createHash('sha256');await rm(path,{force:true});}
  async function response(target,selected,headers,signal){
    if(signal?.aborted)throw signal.reason;
    const remaining=deadline-Date.now();if(remaining<=0)throw fail('VIDEO_DOWNLOAD_TIMEOUT');
    const requestStarted=Date.now();diagnostics.requests++;diagnostics.lastPhase='connecting';
    return new Promise((resolve,reject)=>{
      let timer,res;
      const dispose=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
      const req=request(target,{method:'GET',agent:false,family:selected.family,
        lookup:(_host,options,callback)=>options?.all?callback(null,[selected]):callback(null,selected.address,selected.family),
        headers:{Accept:'video/mp4,video/quicktime,application/octet-stream','Accept-Encoding':'identity','User-Agent':'Ozon-Zongzi-Media/1.0',...headers}},received=>{
        res=received;res.on('error',()=>{});
        diagnostics.headersMs+=Date.now()-requestStarted;diagnostics.lastPhase='body';
        resolve({res,close:()=>{dispose();res.destroy();req.destroy();}});
      });
      const stop=error=>{dispose();res?.destroy(error);req.destroy(error);reject(error);};
      const abort=()=>stop(signal.reason);
      const expire=()=>{diagnostics.timeoutPhase=diagnostics.lastPhase;stop(fail('VIDEO_DOWNLOAD_TIMEOUT'));};
      req.once('socket',socket=>{socket.once('connect',()=>{diagnostics.connectMs=Date.now()-requestStarted;diagnostics.lastPhase='tls';});
        socket.once('secureConnect',()=>{diagnostics.tlsMs=Date.now()-requestStarted;diagnostics.lastPhase='headers';});});
      timer=setTimeout(expire,remaining);timer.unref?.();req.setTimeout(Math.min(30_000,remaining),expire);
      req.on('error',error=>{dispose();res?.destroy(error);reject(error);});
      signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted)abort();else req.end();
    });
  }
  async function downloadParts(target,selected){
    const controller=new AbortController(),file=await open(path,'w',0o600),bodyStarted=Date.now();
    let failure,checking,lastDiskCheck=0;
    const stop=error=>{failure??=error;controller.abort(failure);};
    const pollControl=()=>checking??=(async()=>{try{await checkControl();}catch(error){stop(error);}})().finally(()=>{checking=null;});
    // A pause also stops sockets that have not produced their next chunk yet.
    const controlTimer=setInterval(()=>{void pollControl();},1000);
    diagnostics.parallelConnections=4;
    try{
      await Promise.all(Array.from({length:4},async(_,index)=>{
        const start=Math.floor(index*total/4),end=Math.floor((index+1)*total/4)-1;
        let part,received=0;
        try{
          part=await response(target,selected,{Range:`bytes=${start}-${end}`,'If-Range':etag},controller.signal);
          const {res}=part,type=String(res.headers['content-type']||'').split(';')[0].trim().toLowerCase();
          if(res.statusCode!==206||res.headers.etag!==etag||type!==sourceType
            ||res.headers['content-range']!==`bytes ${start}-${end}/${total}`
            ||contentLength(res.headers['content-length'])!==end-start+1
            ||res.headers['content-encoding']&&res.headers['content-encoding']!=='identity')throw fail('VIDEO_RANGE_INVALID');
          await pollControl();if(failure)throw failure;
          for await(const chunk of res){
            if(failure)throw failure;
            diagnostics.firstByteMs??=Date.now()-startedAt;diagnostics.lastDataAt=Date.now();diagnostics.networkBytes+=chunk.length;
            if(received+chunk.length>end-start+1)throw fail('VIDEO_RANGE_INVALID');
            let written=0;
            while(written<chunk.length){
              const result=await file.write(chunk,written,chunk.length-written,start+received+written);
              if(!result.bytesWritten)throw fail('VIDEO_DOWNLOAD_INCOMPLETE');written+=result.bytesWritten;
            }
            received+=chunk.length;size+=chunk.length;
            if(size-lastDiskCheck>=64*1024**2){lastDiskCheck=size;const info=await statfs(dir);if(info.bavail*info.bsize<256*1024**2)throw fail('VIDEO_DISK_SPACE');}
          }
          if(received!==end-start+1)throw fail('VIDEO_DOWNLOAD_INCOMPLETE');
        }catch(error){stop(error);}finally{part?.close();}
      }));
    }finally{
      clearInterval(controlTimer);if(checking)await checking;
      diagnostics.bodyMs+=Date.now()-bodyStarted;await file.close();
    }
    if(failure)throw failure;
    // Positional writes can finish out of order; hash only the complete file in
    // byte order, with bounded buffers and the same whole-download deadline.
    let lastCheckAt=0;
    for await(const chunk of createReadStream(path)){
      if(Date.now()>=deadline)throw fail('VIDEO_DOWNLOAD_TIMEOUT');
      if(Date.now()-lastCheckAt>=1000){await checkControl();lastCheckAt=Date.now();}
      if(head.length<16)head=Buffer.concat([head,chunk.subarray(0,16-head.length)]);
      hash.update(chunk);
    }
  }
  try{
    let target=validateHttpTarget(value),bodyRequests=0;
    while(bodyRequests<3){
      await checkControl();
      if(target.protocol!=='https:')throw fail('VIDEO_URL_BLOCKED');
      let opened;
      try{
        diagnostics.sourceHost=target.hostname;diagnostics.lastPhase='resolving';
        const dnsStarted=Date.now();let addresses;
        try{addresses=await resolveAllowedAddresses(target.hostname,{lookupHost,deadline});}finally{diagnostics.dnsMs+=Date.now()-dnsStarted;}
        await checkControl();
        const offset=size,canResume=offset>0&&etag&&total>offset;
        opened=await response(target,addresses[0],canResume?{Range:`bytes=${offset}-`,'If-Range':etag}:{});
        const {res}=opened;
        if([301,302,303,307,308].includes(res.statusCode)&&res.headers.location){
          if(++diagnostics.redirects>3)throw fail('VIDEO_REDIRECT_BLOCKED');
          const next=validateHttpTarget(new URL(res.headers.location,target));
          // ETags are scoped to a representation URL, not globally unique.
          if(size&&next.href!==target.href)await reset();target=next;continue;
        }
        bodyRequests++;
        const type=String(res.headers['content-type']||'').split(';')[0].trim().toLowerCase();
        if(canResume&&[206,416].includes(res.statusCode)){
          const range=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(res.headers['content-range']||''));
          const length=contentLength(res.headers['content-length']);
          const valid=res.statusCode===206&&range&&res.headers.etag===etag&&Number(range[1])===offset
            &&Number(range[2])===total-1&&Number(range[3])===total&&(!length||length===total-offset)&&sourceType===type;
          if(!valid){await reset();continue;}
        }else if(res.statusCode===200){if(size)await reset();}
        else throw fail('VIDEO_DOWNLOAD_HTTP_'+res.statusCode);
        if(!['video/mp4','video/quicktime','application/octet-stream'].includes(type))throw fail('VIDEO_CONTENT_TYPE_INVALID');
        if(res.headers['content-encoding']&&res.headers['content-encoding']!=='identity')throw fail('VIDEO_ENCODING_INVALID');
        const length=contentLength(res.headers['content-length']);
        if(!Number.isFinite(length)||length+size>maxBytes)throw fail('VIDEO_TOO_LARGE');
        if(!size){total=length;etag=/^"[^"\r\n]+"$/.test(String(res.headers.etag||''))?res.headers.etag:null;sourceType=type;}
        const disk=await statfs(dir);if(disk.bavail*disk.bsize<Math.max(total-size,64*1024**2)+512*1024**2)throw fail('VIDEO_DISK_SPACE');
        await checkControl();await report('download');
        const resumedFrom=size,bodyStarted=Date.now();
        if(!size&&!parallelAttempted&&total>=4*1024**2&&etag&&String(res.headers['accept-ranges']).split(',').some(unit=>unit.trim().toLowerCase()==='bytes')){
          parallelAttempted=true;opened.close();
          try{await downloadParts(target,addresses[0]);}
          catch(error){
            if(!(transient(error)||error.code==='VIDEO_RANGE_INVALID')||Date.now()>=deadline)throw error;
            diagnostics.parallelFallback=error.code;await reset();await report('retry');continue;
          }
        }else{
          const file=await open(path,size?'a':'w',0o600);let lastDiskCheck=size,lastControl=size,lastCheckAt=Date.now();
          try{
          for await(const chunk of res){
            diagnostics.firstByteMs ??= Date.now()-startedAt;diagnostics.lastDataAt=Date.now();
            diagnostics.networkBytes+=chunk.length;
            if(size+chunk.length>maxBytes||(total&&size+chunk.length>total))throw fail('VIDEO_TOO_LARGE');
            if(head.length<16)head=Buffer.concat([head,chunk.subarray(0,16-head.length)]);
            await file.writeFile(chunk);size+=chunk.length;hash.update(chunk);
            if(size-lastDiskCheck>=64*1024**2){lastDiskCheck=size;const info=await statfs(dir);if(info.bavail*info.bsize<256*1024**2)throw fail('VIDEO_DISK_SPACE');}
            if(size-lastControl>=8*1024**2||Date.now()-lastCheckAt>=1000){await checkControl();lastControl=size;lastCheckAt=Date.now();}
          }
          }finally{diagnostics.bodyMs+=Date.now()-bodyStarted;await file.close();}
        }
        if(total&&total!==size)throw fail('VIDEO_DOWNLOAD_INCOMPLETE');
        if(!size||!['ftyp','wide','mdat','free','moov'].includes(head.toString('ascii',4,8)))throw fail('VIDEO_FILE_INVALID');
        await checkControl();diagnostics.resumedBytes=resumedFrom;diagnostics.downloadMs=Date.now()-startedAt;await report('complete');
        return {path,size,sha256:hash.digest('hex'),contentType:sourceType==='video/quicktime'?'video/quicktime':'video/mp4',cleanup,diagnostics};
      }catch(error){
        if(!transient(error)||bodyRequests>=3||Date.now()>=deadline)throw error;
        // Errors before response headers also spend a finite request attempt.
        if(!opened)bodyRequests++;
        if(!(etag&&total>size&&size>0))await reset();
        await report('retry');
      }finally{opened?.close();}
    }
    throw fail('VIDEO_DOWNLOAD_INCOMPLETE');
  }catch(error){diagnostics.downloadMs=Date.now()-startedAt;error.mediaDiagnostics={...diagnostics,bytes:size};await cleanup();throw error;}
}
