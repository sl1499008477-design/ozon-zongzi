import https from 'node:https';
import {createWriteStream} from 'node:fs';
import {mkdtemp,rm,statfs} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createHash} from 'node:crypto';
import {validateHttpTarget,resolveAllowedAddresses} from './collector-excel-service.mjs';

const fail=code=>Object.assign(new Error(code),{code});

// Full bounded file download. DNS is checked and pinned for every redirect;
// unlike the image downloader, video bytes stream to disk instead of RAM.
export async function downloadOzonListingVideo(value,{request=https.request,lookupHost,
  timeoutMs=300_000,maxBytes=2*1024**3}={}){
  const dir=await mkdtemp(join(tmpdir(),'ozon-listing-video-'));
  const path=join(dir,'source.mp4'),cleanup=()=>rm(dir,{recursive:true,force:true});
  const deadline=Date.now()+timeoutMs;
  try{
    let target=validateHttpTarget(value);
    for(let redirect=0;redirect<=3;redirect++){
      if(target.protocol!=='https:')throw fail('VIDEO_URL_BLOCKED');
      const addresses=await resolveAllowedAddresses(target.hostname,{lookupHost,deadline});
      const selected=addresses[0],remaining=deadline-Date.now();if(remaining<=0)throw fail('VIDEO_DOWNLOAD_TIMEOUT');
      const result=await new Promise((resolve,reject)=>{
        let timer,response,settled=false;
        const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(result);};
        const req=request(target,{method:'GET',agent:false,family:selected.family,
          lookup:(_host,options,callback)=>options?.all?callback(null,[selected]):callback(null,selected.address,selected.family),
          headers:{Accept:'video/mp4,video/quicktime,application/octet-stream','Accept-Encoding':'identity','User-Agent':'Ozon-Zongzi-Media/1.0'}},res=>{
          response=res;
          void(async()=>{
            if([301,302,303,307,308].includes(res.statusCode)&&res.headers.location){res.destroy();return finish(null,{redirect:validateHttpTarget(new URL(res.headers.location,target))});}
            if(res.statusCode!==200)throw fail('VIDEO_DOWNLOAD_HTTP_'+res.statusCode);
            const type=String(res.headers['content-type']||'').split(';')[0].trim().toLowerCase();
            if(!['video/mp4','video/quicktime','application/octet-stream'].includes(type))throw fail('VIDEO_CONTENT_TYPE_INVALID');
            if(res.headers['content-encoding']&&res.headers['content-encoding']!=='identity')throw fail('VIDEO_ENCODING_INVALID');
            const length=Number(res.headers['content-length']||0);
            if(length>maxBytes)throw fail('VIDEO_TOO_LARGE');
            const disk=await statfs(dir);if(disk.bavail*disk.bsize<Math.max(length,64*1024**2)+512*1024**2)throw fail('VIDEO_DISK_SPACE');
            let size=0,head=Buffer.alloc(0),lastDiskCheck=0;
            const hash=createHash('sha256');
            const meter=new Transform({transform(chunk,_encoding,callback){
              size+=chunk.length;if(size>maxBytes)return callback(fail('VIDEO_TOO_LARGE'));
              if(head.length<16)head=Buffer.concat([head,chunk.subarray(0,16-head.length)]);
              hash.update(chunk);
              if(size-lastDiskCheck>=64*1024**2){lastDiskCheck=size;statfs(dir).then(info=>callback(info.bavail*info.bsize<256*1024**2?fail('VIDEO_DISK_SPACE'):null,chunk),callback);}
              else callback(null,chunk);
            }});
            await pipeline(res,meter,createWriteStream(path,{flags:'wx'}));
            if(!size||(length&&length!==size)||!['ftyp','wide','mdat','free','moov'].includes(head.toString('ascii',4,8)))throw fail('VIDEO_FILE_INVALID');
            finish(null,{path,size,sha256:hash.digest('hex'),contentType:type==='video/quicktime'?'video/quicktime':'video/mp4',cleanup});
          })().catch(error=>{res.destroy();finish(error);});
        });
        const expire=()=>{const error=fail('VIDEO_DOWNLOAD_TIMEOUT');response?.destroy(error);req.destroy(error);finish(error);};
        timer=setTimeout(expire,remaining);timer.unref?.();req.setTimeout(Math.min(30_000,remaining),expire);
        req.on('error',error=>finish(error));req.end();
      });
      if(result.redirect){target=result.redirect;continue;}
      return result;
    }
    throw fail('VIDEO_REDIRECT_BLOCKED');
  }catch(error){await cleanup();throw error;}
}
