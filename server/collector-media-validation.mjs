import {createHash, randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {access} from 'node:fs/promises';
import {constants} from 'node:fs';
import sharp from 'sharp';
import {assertOzonVideoUpload} from '../shared/ozon-video-processing.mjs';

const fail=code=>Object.assign(new Error(code),{code,status:422});
export async function collectorMediaProbeAvailable(path){
  if(!path || !/^(?:\/|[A-Za-z]:[\\/])/.test(path))return false;
  try{await access(path,constants.X_OK);return true;}catch{return false;}
}

// The collector may claim MIME/hash, but only these actual bytes establish media
// semantics. Images are fully decoded; video probing uses a strict byte budget.
export async function validateCollectorMedia(object,{readRange,ffprobePath=process.env.COLLECTOR_MEDIA_FFPROBE_PATH,
  signal,purpose,maxProbeBytes=16*1024**2,timeoutMs=30_000}={}){
  signal?.throwIfAborted();
  if(object.contentType.startsWith('image/')){
    if(object.size>10*1024**2)throw fail('COLLECTOR_MEDIA_TOO_LARGE');
    const bytes=await readRange({...object,start:0,end:object.size-1,signal});
    signal?.throwIfAborted();
    if(bytes.length!==object.size||createHash('md5').update(bytes).digest('hex')!==object.etag)throw fail('COLLECTOR_MEDIA_CHECKSUM_MISMATCH');
    try{
      const image=sharp(bytes,{limitInputPixels:40_000_000,failOn:'warning'}), metadata=await image.metadata();
      const contentType={jpeg:'image/jpeg',png:'image/png',webp:'image/webp'}[metadata.format];
      if(contentType!==object.contentType || metadata.pages>1)throw fail('COLLECTOR_MEDIA_FORMAT_INVALID');
      await image.raw().toBuffer(); // metadata() alone does not detect a truncated/corrupt raster.
      signal?.throwIfAborted();
      return {contentType,width:metadata.width,height:metadata.height,validationBytes:bytes.length,validation:'sharp-full-decode-v1'};
    }catch(error){if(signal?.aborted)throw signal.reason;throw fail('COLLECTOR_MEDIA_FORMAT_INVALID');}
  }
  if(!['video/mp4','video/quicktime'].includes(object.contentType))throw fail('COLLECTOR_MEDIA_FORMAT_INVALID');
  if(!await collectorMediaProbeAvailable(ffprobePath))throw fail('COLLECTOR_MEDIA_PROBE_UNAVAILABLE');
  const controller=new AbortController(), readSignal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  let validationBytes=0,reservedBytes=0,requests=0,readFailure;
  const token='/'+randomUUID();
  const server=createServer(async(req,res)=>{
    try{
      if(req.url!==token||!['HEAD','GET'].includes(req.method))throw fail('COLLECTOR_MEDIA_PROBE_REQUEST_INVALID');
      const headers={'Accept-Ranges':'bytes','Content-Type':object.contentType,'Connection':'close'};
      if(req.method==='HEAD'){res.writeHead(200,{...headers,'Content-Length':object.size});res.end();return;}
      if(++requests>64)throw fail('COLLECTOR_MEDIA_PROBE_LIMIT');
      const match=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range||'bytes=0-');
      if(!match)throw fail('COLLECTOR_MEDIA_PROBE_REQUEST_INVALID');
      const start=Number(match[1]),requestedEnd=match[2]?Number(match[2]):object.size-1;
      if(!Number.isSafeInteger(start)||start<0||start>=object.size||requestedEnd<start)throw fail('COLLECTOR_MEDIA_PROBE_REQUEST_INVALID');
      const end=Math.min(requestedEnd,object.size-1,start+1024**2-1),length=end-start+1;
      reservedBytes+=length;
      if(reservedBytes>maxProbeBytes)throw fail('COLLECTOR_MEDIA_PROBE_LIMIT');
      const bytes=await readRange({...object,start,end,signal:readSignal});
      validationBytes+=bytes.length;
      if(bytes.length!==length)throw fail('COLLECTOR_MEDIA_PROBE_READ_INCOMPLETE');
      res.writeHead(206,{...headers,'Content-Length':length,'Content-Range':`bytes ${start}-${end}/${object.size}`});res.end(bytes);
    }catch(error){readFailure=error;res.writeHead(422);res.end();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  try{
    const output=await new Promise((resolve,reject)=>{
      const child=spawn(ffprobePath,['-v','error','-protocol_whitelist','http,tcp','-f','mov','-enable_drefs','0',
        '-probesize','4194304','-analyzeduration','5000000','-show_entries',
        'format=format_name,duration,bit_rate,size:format_tags=major_brand:stream=codec_type,codec_name,width,height,sample_aspect_ratio,avg_frame_rate,pix_fmt,color_primaries,color_transfer,color_space:stream_tags=rotate:stream_side_data=rotation',
        '-of','json',`http://127.0.0.1:${server.address().port}${token}`],{stdio:['ignore','pipe','pipe'],windowsHide:true});
      let output='',length=0,settled=false;
      const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);child.kill('SIGKILL');error?reject(error):resolve(output);};
      const abort=()=>finish(signal.reason);
      const timer=setTimeout(()=>finish(fail('COLLECTOR_MEDIA_PROBE_TIMEOUT')),timeoutMs);
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
      child.on('error',()=>finish(fail('COLLECTOR_MEDIA_PROBE_UNAVAILABLE')));
      child.stdout.on('data',chunk=>{length+=chunk.length;if(length>64*1024)finish(fail('COLLECTOR_MEDIA_PROBE_LIMIT'));else output+=chunk;});
      child.stderr.on('data',chunk=>{length+=chunk.length;if(length>64*1024)finish(fail('COLLECTOR_MEDIA_PROBE_LIMIT'));});
      child.on('close',code=>finish(readFailure||(code?fail('COLLECTOR_MEDIA_FORMAT_INVALID'):null)));
    });
    if(readFailure)throw readFailure;
    let result;try{result=JSON.parse(output);}catch{throw fail('COLLECTOR_MEDIA_FORMAT_INVALID');}
    const video=result.streams?.find(stream=>stream.codec_type==='video'&&stream.codec_name&&stream.width>0&&stream.height>0);
    const duration=Number(result.format?.duration);
    if(!video||!Number.isFinite(duration)||duration<=0||!String(result.format?.format_name).split(',').includes('mov'))throw fail('COLLECTOR_MEDIA_FORMAT_INVALID');
    const contentType=String(result.format?.tags?.major_brand||'').trim()==='qt'?'video/quicktime':'video/mp4';
    if(contentType!==object.contentType)throw fail('COLLECTOR_MEDIA_FORMAT_INVALID');
    if(purpose)assertOzonVideoUpload({purpose,contentType,size:object.size,probe:result});
    return {contentType,width:video.width,height:video.height,duration,validationBytes,validation:'ffprobe-bounded-mov-v1'};
  }finally{controller.abort();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
