import {spawn} from 'node:child_process';
import {stat,statfs,rm} from 'node:fs/promises';
import {dirname} from 'node:path';

export const OZON_VIDEO_MAX_BYTES=2*1024**3;
export const OZON_VIDEO_COVER_MAX_BYTES=20_000_000;
export const OZON_VIDEO_REASONABLE_BITRATE=12_000_000;

const fail=(code,status=422)=>Object.assign(new Error(code),{code,status});
const number=value=>{const parsed=Number(value);return Number.isFinite(parsed)?parsed:null;};
const ratio=value=>{
  const match=/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(value||''));
  if(!match||Number(match[2])===0)return 1;
  return Number(match[1])/Number(match[2]);
};
const rotationOf=stream=>{
  const value=stream.side_data_list?.find(entry=>number(entry.rotation)!==null)?.rotation??stream.tags?.rotate??0;
  return ((Math.round(Number(value)||0)%360)+360)%360;
};
const even=value=>Math.max(2,Math.round(value/2)*2);
const frameRate=stream=>{
  const match=/^(\d+)(?:\/(\d+))?$/.exec(String(stream.avg_frame_rate||''));
  if(!match)return null;const denominator=Number(match[2]||1);return denominator?Number(match[1])/denominator:null;
};
const hdr=stream=>['smpte2084','arib-std-b67'].includes(stream.color_transfer)||stream.color_primaries==='bt2020';

function inspect({purpose,contentType,size,probe}){
  if(!['video','video-cover','rich-video'].includes(purpose))throw fail('ZONGZI_VIDEO_PURPOSE_INVALID');
  if(!['video/mp4','video/quicktime'].includes(contentType)||!Number.isSafeInteger(size)||size<1||size>OZON_VIDEO_MAX_BYTES)
    throw fail('ZONGZI_VIDEO_FORMAT_INVALID');
  const formats=String(probe?.format?.format_name||'').split(',');
  const video=probe?.streams?.find(stream=>stream.codec_type==='video'&&number(stream.width)>0&&number(stream.height)>0);
  const duration=number(probe?.format?.duration);
  if(!formats.includes('mov')||!video||duration===null||duration<=0)throw fail('ZONGZI_VIDEO_FORMAT_INVALID');
  const sar=ratio(video.sample_aspect_ratio),rotation=rotationOf(video);
  let displayWidth=Number(video.width)*sar,displayHeight=Number(video.height);
  if(rotation===90||rotation===270)[displayWidth,displayHeight]=[displayHeight,displayWidth];
  const longEdge=Math.max(displayWidth,displayHeight),shortEdge=Math.min(displayWidth,displayHeight);
  const audio=(probe.streams||[]).filter(stream=>stream.codec_type==='audio');
  const bitRate=number(probe.format?.bit_rate)??Math.round(size*8/duration);
  return {purpose,contentType,size,probe,video,audio,duration,displayWidth,displayHeight,longEdge,shortEdge,bitRate,rotation,sar,
    hasHdr:hdr(video),fps:frameRate(video)};
}

function assertHardRules(info,{requireDeliveryCodecs=false}={}){
  if(info.purpose==='rich-video')return info;
  if(info.purpose==='video-cover'){
    const aspect=info.displayWidth/info.displayHeight;
    if(!(info.displayHeight>info.displayWidth)||Math.abs(aspect-0.75)>0.0025)throw fail('ZONGZI_VIDEO_COVER_ASPECT_INVALID');
    if(info.size>OZON_VIDEO_COVER_MAX_BYTES)throw fail('ZONGZI_VIDEO_COVER_TOO_LARGE');
  }
  if(requireDeliveryCodecs&&(info.video.codec_name!=='h264'||info.audio.some(stream=>stream.codec_name!=='aac')))
    throw fail('ZONGZI_VIDEO_CODEC_INVALID');
  return info;
}

export function evaluateOzonVideo(input){
  const info=inspect(input);
  if(info.purpose==='rich-video')return {...info,action:'reuse'};
  // Source playback files may be shorter/smaller than published upload guidance.
  // Preserve valid media; duration and pixel dimensions are not collection gates.
  if(info.purpose==='video-cover'){
    const aspect=info.displayWidth/info.displayHeight;
    if(!(info.displayHeight>info.displayWidth)||Math.abs(aspect-0.75)>0.0025)throw fail('ZONGZI_VIDEO_COVER_ASPECT_INVALID');
  }
  const reasons=[];
  if(info.video.codec_name!=='h264'||info.audio.some(stream=>stream.codec_name!=='aac'))reasons.push('codec');
  if(info.bitRate>OZON_VIDEO_REASONABLE_BITRATE)reasons.push('bitrate');
  if(info.purpose==='video-cover'&&info.size>OZON_VIDEO_COVER_MAX_BYTES)reasons.push('cover-size');
  if(!reasons.length)return {...info,action:'reuse'};
  if(info.hasHdr)throw fail('ZONGZI_VIDEO_HDR_TRANSCODE_UNSUPPORTED');
  return {...info,action:'transcode',reasons,targetWidth:even(info.displayWidth),targetHeight:even(info.displayHeight)};
}

export function assertOzonVideoUpload(input){
  return assertHardRules(inspect(input),{requireDeliveryCodecs:input.purpose!=='rich-video'});
}

export function ozonVideoContentType(probe){
  return String(probe?.format?.tags?.major_brand||'').trim()==='qt'?'video/quicktime':'video/mp4';
}

async function runTool(command,args,{signal,timeoutMs=30_000,maxOutput=256*1024,checkControl}={}){
  signal?.throwIfAborted();await checkControl?.();
  return new Promise((resolve,reject)=>{
    let child;try{child=spawn(command,args,{stdio:['ignore','pipe','pipe'],windowsHide:true});}
    catch{return reject(fail('ZONGZI_VIDEO_TOOL_UNAVAILABLE'));}
    let stdout='',stderr='',bytes=0,settled=false,polling=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);clearInterval(poller);signal?.removeEventListener('abort',abort);
      if(child.exitCode===null)child.kill('SIGKILL');error?reject(error):resolve(value);};
    const abort=()=>finish(signal.reason||Object.assign(new Error('Aborted'),{name:'AbortError'}));
    const timer=setTimeout(()=>finish(fail('ZONGZI_VIDEO_PROCESS_TIMEOUT')),timeoutMs);
    const poller=checkControl?setInterval(async()=>{if(polling||settled)return;polling=true;try{await checkControl();}catch(error){finish(error);}finally{polling=false;}},250):null;
    poller?.unref?.();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)return abort();
    child.on('error',()=>finish(fail('ZONGZI_VIDEO_TOOL_UNAVAILABLE')));
    child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxOutput)finish(fail('ZONGZI_VIDEO_TOOL_OUTPUT_LIMIT'));else stdout+=chunk;});
    child.stderr.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxOutput)finish(fail('ZONGZI_VIDEO_TOOL_OUTPUT_LIMIT'));else stderr+=chunk;});
    child.on('close',code=>code===0?finish(null,{stdout,stderr}):finish(fail('ZONGZI_VIDEO_PROCESS_FAILED')));
  });
}

export async function probeOzonVideoFile(inputPath,{ffprobePath,signal,timeoutMs=30_000,checkControl}={}){
  if(!ffprobePath)throw fail('ZONGZI_VIDEO_TOOL_UNAVAILABLE');
  const {stdout}=await runTool(ffprobePath,['-v','error','-protocol_whitelist','file','-f','mov','-enable_drefs','0',
    '-probesize','4194304','-analyzeduration','5000000','-show_entries',
    'format=format_name,duration,bit_rate,size:format_tags=major_brand:stream=codec_type,codec_name,width,height,sample_aspect_ratio,avg_frame_rate,pix_fmt,color_primaries,color_transfer,color_space:stream_tags=rotate:stream_side_data=rotation',
    '-of','json',inputPath],{signal,timeoutMs,maxOutput:256*1024,checkControl});
  try{return JSON.parse(stdout);}catch{throw fail('ZONGZI_VIDEO_FORMAT_INVALID');}
}

export async function processOzonVideoFile({inputPath,purpose,contentType,size,probe,ffmpegPath,ffprobePath,outputPath=`${inputPath}.ozon.mp4`,
  signal,checkControl,timeoutMs=15*60_000,statfs:readStatfs=statfs}={}){
  signal?.throwIfAborted();await checkControl?.();
  const sourceProbe=probe||await probeOzonVideoFile(inputPath,{ffprobePath,signal,checkControl});
  const actualContentType=ozonVideoContentType(sourceProbe);
  const decision=evaluateOzonVideo({purpose,contentType:actualContentType,size,probe:sourceProbe});
  if(decision.action==='reuse')return {path:inputPath,size,contentType:actualContentType,probe:sourceProbe,processed:false,decision};
  const disk=await readStatfs(dirname(outputPath));
  const available=Number(disk.bavail)*Number(disk.bsize),required=size+64*1024**2;
  if(!Number.isFinite(available)||available<required)throw fail('ZONGZI_VIDEO_TEMP_SPACE');
  const args=['-nostdin','-hide_banner','-loglevel','error','-y','-threads:v','1','-i',inputPath,'-map','0:v:0','-map','0:a?',
    '-vf',`scale=${decision.targetWidth}:${decision.targetHeight}:flags=lanczos,setsar=1`,'-c:v','libx264','-preset','veryfast','-crf','23',
    '-pix_fmt','yuv420p','-threads:v','1','-filter_threads','1','-c:a','aac','-b:a','128k','-movflags','+faststart','-metadata:s:v:0','rotate=0'];
  if(purpose==='video-cover'){
    const rate=Math.max(128_000,Math.floor((19_000_000*8/decision.duration)-192_000));
    args.push('-maxrate',String(rate),'-bufsize',String(rate*2));
  }
  args.push('-f','mp4',outputPath);
  try{
    await runTool(ffmpegPath,args,{signal,timeoutMs,maxOutput:1024*1024,checkControl});
    const outputStat=await stat(outputPath),outputProbe=await probeOzonVideoFile(outputPath,{ffprobePath,signal,checkControl});
    const output=assertOzonVideoUpload({purpose,contentType:'video/mp4',size:outputStat.size,probe:outputProbe});
    if(decision.audio.length&&!output.audio.length)throw fail('ZONGZI_VIDEO_AUDIO_LOST');
    if(Math.abs(output.duration-decision.duration)>Math.max(0.1,decision.duration*0.005))throw fail('ZONGZI_VIDEO_DURATION_CHANGED');
    if(decision.fps&&decision.fps<=120&&output.fps&&Math.abs(output.fps-decision.fps)>0.01)throw fail('ZONGZI_VIDEO_FRAME_RATE_CHANGED');
    if(decision.reasons.length===1&&decision.reasons[0]==='bitrate'&&outputStat.size>=size){await rm(outputPath,{force:true});return {path:inputPath,size,contentType:actualContentType,probe:sourceProbe,processed:false,decision};}
    return {path:outputPath,size:outputStat.size,contentType:'video/mp4',probe:outputProbe,processed:true,decision};
  }catch(error){await rm(outputPath,{force:true}).catch(()=>{});throw error;}
}
