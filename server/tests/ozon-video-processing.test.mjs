import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,open,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertOzonVideoUpload,evaluateOzonVideo,processOzonVideoFile,probeOzonVideoFile} from '../../shared/ozon-video-processing.mjs';

const runFile=promisify(execFile);
const mp4Probe=({width=1080,height=1920,duration=8,videoCodec='h264',audioCodec='aac',bitRate=8_000_000,
  sar='1:1',rotation=0,colorTransfer='bt709'}={})=>({
  streams:[
    {codec_type:'video',codec_name:videoCodec,width,height,sample_aspect_ratio:sar,avg_frame_rate:'30/1',pix_fmt:'yuv420p',
      color_transfer:colorTransfer,side_data_list:rotation?[{rotation}]:[]},
    ...(audioCodec?[{codec_type:'audio',codec_name:audioCodec,channels:2}]:[]),
  ],
  format:{format_name:'mov,mp4,m4a,3gp,3g2,mj2',duration:String(duration),bit_rate:String(bitRate),tags:{major_brand:'isom'}},
});

test('policy reuses compliant ordinary videos without treating 100MB as an API limit',()=>{
  const decision=evaluateOzonVideo({purpose:'video',contentType:'video/mp4',size:150_000_000,
    probe:mp4Probe({duration:300,bitRate:4_000_000})});
  assert.equal(decision.action,'reuse');
  assert.deepEqual([decision.displayWidth,decision.displayHeight],[1080,1920]);
});

test('policy transcodes only necessary ordinary video and preserves display geometry metadata',()=>{
  const oversized=evaluateOzonVideo({purpose:'video',contentType:'video/mp4',size:20_000_000,
    probe:mp4Probe({width:3840,height:2160,bitRate:15_000_000})});
  assert.equal(oversized.action,'transcode');
  assert.deepEqual([oversized.targetWidth,oversized.targetHeight],[3840,2160]);
  assert.deepEqual(oversized.reasons,['bitrate']);
  const rotated=evaluateOzonVideo({purpose:'video',contentType:'video/mp4',size:10_000_000,
    probe:mp4Probe({width:1920,height:1080,rotation:90})});
  assert.equal(rotated.action,'reuse');
  assert.deepEqual([rotated.displayWidth,rotated.displayHeight],[1080,1920]);
  const anamorphic=evaluateOzonVideo({purpose:'video',contentType:'video/mp4',size:10_000_000,
    probe:mp4Probe({width:720,height:1080,sar:'2:1',bitRate:15_000_000})});
  assert.equal(anamorphic.action,'transcode');
  assert.deepEqual([anamorphic.targetWidth,anamorphic.targetHeight],[1440,1080]);
});

test('cover retains aspect and size requirements without duration or resolution thresholds',()=>{
  const cover=mp4Probe({width:1080,height:1440,duration:30});
  assert.equal(evaluateOzonVideo({purpose:'video-cover',contentType:'video/mp4',size:20_000_000,probe:cover}).action,'reuse');
  assert.equal(evaluateOzonVideo({purpose:'video-cover',contentType:'video/mp4',size:20_000_001,probe:cover}).action,'transcode');
  for(const [probe,code] of [
    [mp4Probe({width:1920,height:1080}),'ZONGZI_VIDEO_COVER_ASPECT_INVALID'],
  ])assert.throws(()=>evaluateOzonVideo({purpose:'video-cover',contentType:'video/mp4',size:1_000_000,probe}),{code});
});

test('ordinary videos and covers pass duration and resolution checks in preparation and upload confirmation',()=>{
  for(const purpose of ['video','video-cover'])for(const dimensions of [[600,800],[2160,2880]])for(const duration of [1,5.533333,31,301]){
    const input={purpose,contentType:'video/mp4',size:1_000_000,probe:mp4Probe({width:dimensions[0],height:dimensions[1],duration})};
    const decision=evaluateOzonVideo(input);
    assert.equal(decision.action,'reuse');
    assert.deepEqual([decision.displayWidth,decision.displayHeight],dimensions);
    assert.doesNotThrow(()=>assertOzonVideoUpload(input));
  }
});

test('invalid files still fail with our own error namespace',()=>{
  assert.throws(()=>evaluateOzonVideo({purpose:'video',contentType:'text/html',size:10,probe:mp4Probe()}),{code:'ZONGZI_VIDEO_FORMAT_INVALID'});
  assert.throws(()=>evaluateOzonVideo({purpose:'video',contentType:'video/mp4',size:10,probe:mp4Probe({duration:0})}),{code:'ZONGZI_VIDEO_FORMAT_INVALID'});
});

test('Rich video keeps short and low-resolution source semantics independent',()=>{
  const decision=evaluateOzonVideo({purpose:'rich-video',contentType:'video/mp4',size:30_000_000,
    probe:mp4Probe({width:640,height:360,duration:3,videoCodec:'vp9',audioCodec:'opus',bitRate:20_000_000})});
  assert.equal(decision.action,'reuse');
  assert.equal(decision.duration,3);
  assert.doesNotThrow(()=>assertOzonVideoUpload({purpose:'rich-video',contentType:'video/mp4',size:30_000_000,
    probe:mp4Probe({width:640,height:360,duration:3,videoCodec:'vp9',audioCodec:'opus'})}));
  assert.throws(()=>assertOzonVideoUpload({purpose:'video',contentType:'video/mp4',size:30_000_000,
    probe:mp4Probe({videoCodec:'vp9',audioCodec:'opus'})}),{code:'ZONGZI_VIDEO_CODEC_INVALID'});
});

test('processing refuses transformations that would silently alter HDR and never upscales low resolution',()=>{
  assert.throws(()=>evaluateOzonVideo({purpose:'video',contentType:'video/mp4',size:10_000_000,
    probe:mp4Probe({width:3840,height:2160,colorTransfer:'smpte2084',bitRate:15_000_000})}),{code:'ZONGZI_VIDEO_HDR_TRANSCODE_UNSUPPORTED'});
  assert.equal(evaluateOzonVideo({purpose:'video',contentType:'video/mp4',size:1_000_000,
    probe:mp4Probe({width:600,height:1000})}).action,'reuse');
});

test('real tools reuse compliant MP4/MOV bytes and transcode oversized video to H.264/AAC with full duration and audio',{
  skip:!process.env.OZON_VIDEO_TEST_INPUT||!process.env.OZON_VIDEO_FFMPEG_PATH||!process.env.OZON_VIDEO_FFPROBE_PATH,
  timeout:120_000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'ozon-video-policy-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const input=process.env.OZON_VIDEO_TEST_INPUT,ffmpegPath=process.env.OZON_VIDEO_FFMPEG_PATH,ffprobePath=process.env.OZON_VIDEO_FFPROBE_PATH;
  const inputSize=(await stat(input)).size;
  const reused=await processOzonVideoFile({inputPath:input,purpose:'video',contentType:'video/mp4',size:inputSize,ffmpegPath,ffprobePath,outputPath:join(directory,'unused.mp4')});
  assert.equal(reused.path,input);assert.equal(reused.processed,false);assert.equal(reused.size,inputSize);
  await assert.rejects(processOzonVideoFile({inputPath:input,purpose:'video-cover',contentType:'video/mp4',size:inputSize,ffmpegPath,ffprobePath}),
    {code:'ZONGZI_VIDEO_COVER_ASPECT_INVALID'});
  const mov=join(directory,'source.mov');await runFile(ffmpegPath,['-nostdin','-hide_banner','-loglevel','error','-i',input,'-c','copy',mov]);
  const movResult=await processOzonVideoFile({inputPath:mov,purpose:'video',contentType:'video/quicktime',size:(await stat(mov)).size,ffmpegPath,ffprobePath,outputPath:join(directory,'unused-mov.mp4')});
  assert.equal(movResult.path,mov);assert.equal(movResult.contentType,'video/quicktime');assert.equal(movResult.processed,false);
  const large=join(directory,'large.mp4');
  await runFile(ffmpegPath,['-nostdin','-hide_banner','-loglevel','error','-i',input,'-vf','scale=1216:2160','-c:v','mpeg4','-q:v','2','-c:a','copy',large],{timeout:60_000});
  const output=join(directory,'prepared.mp4');
  const processed=await processOzonVideoFile({inputPath:large,purpose:'video',contentType:'video/mp4',size:(await stat(large)).size,ffmpegPath,ffprobePath,outputPath:output});
  assert.equal(processed.processed,true);assert.equal(processed.path,output);assert.equal(processed.contentType,'video/mp4');
  const probe=await probeOzonVideoFile(output,{ffprobePath});
  const video=probe.streams.find(stream=>stream.codec_type==='video'),audio=probe.streams.find(stream=>stream.codec_type==='audio');
  assert.equal(video.codec_name,'h264');assert.equal(audio.codec_name,'aac');assert.deepEqual([video.width,video.height],[1216,2160]);
  assert.ok(Math.abs(Number(probe.format.duration)-8)<0.05);
  const rotated=join(directory,'rotated.mp4');
  await runFile(ffmpegPath,['-nostdin','-hide_banner','-loglevel','error','-display_rotation:v:0','90','-i',input,'-map','0','-c','copy',rotated]);
  const rotatedHandle=await open(rotated,'r+');await rotatedHandle.truncate(16_000_000);await rotatedHandle.close();
  const rotatedOutput=await processOzonVideoFile({inputPath:rotated,purpose:'video',contentType:'video/mp4',size:(await stat(rotated)).size,
    ffmpegPath,ffprobePath,outputPath:join(directory,'rotated-prepared.mp4')});
  const rotatedProbe=await probeOzonVideoFile(rotatedOutput.path,{ffprobePath}),rotatedVideo=rotatedProbe.streams.find(stream=>stream.codec_type==='video');
  assert.deepEqual([rotatedVideo.width,rotatedVideo.height],[1080,608]);
  assert.equal(rotatedVideo.side_data_list?.find(entry=>Number.isFinite(Number(entry.rotation)))?.rotation??0,0);
  const anamorphic=join(directory,'anamorphic.mp4');
  await runFile(ffmpegPath,['-nostdin','-hide_banner','-loglevel','error','-i',input,'-vf','scale=720:1080,setsar=2/1','-c:v','libx264','-preset','ultrafast','-crf','18','-c:a','copy',anamorphic],{timeout:60_000});
  const anamorphicHandle=await open(anamorphic,'r+');await anamorphicHandle.truncate(16_000_000);await anamorphicHandle.close();
  const anamorphicOutput=await processOzonVideoFile({inputPath:anamorphic,purpose:'video',contentType:'video/mp4',size:(await stat(anamorphic)).size,
    ffmpegPath,ffprobePath,outputPath:join(directory,'anamorphic-prepared.mp4')});
  const anamorphicProbe=await probeOzonVideoFile(anamorphicOutput.path,{ffprobePath}),anamorphicVideo=anamorphicProbe.streams.find(stream=>stream.codec_type==='video');
  assert.deepEqual([anamorphicVideo.width,anamorphicVideo.height],[1440,1080]);assert.equal(anamorphicVideo.sample_aspect_ratio,'1:1');
  const largeCover=join(directory,'large-cover.mp4');
  await runFile(ffmpegPath,['-nostdin','-hide_banner','-loglevel','error','-i',input,'-vf','scale=1080:1440,setsar=1','-c:v','libx264','-preset','ultrafast','-crf','18','-c:a','copy',largeCover],{timeout:60_000});
  const coverHandle=await open(largeCover,'r+');await coverHandle.truncate(20_000_001);await coverHandle.close();
  const coverOutput=join(directory,'cover-prepared.mp4');
  const cover=await processOzonVideoFile({inputPath:largeCover,purpose:'video-cover',contentType:'video/mp4',size:(await stat(largeCover)).size,ffmpegPath,ffprobePath,outputPath:coverOutput});
  assert.equal(cover.processed,true);assert.ok(cover.size<=20_000_000);assert.equal(cover.contentType,'video/mp4');
  const coverProbe=await probeOzonVideoFile(cover.path,{ffprobePath});
  assert.deepEqual([coverProbe.streams[0].width,coverProbe.streams[0].height],[1080,1440]);assert.ok(coverProbe.streams.some(stream=>stream.codec_type==='audio'));
});

test('processing stops before ffmpeg when cancelled or temporary disk headroom is missing',{
  skip:!process.env.OZON_VIDEO_TEST_INPUT||!process.env.OZON_VIDEO_FFMPEG_PATH||!process.env.OZON_VIDEO_FFPROBE_PATH},async()=>{
  const input=process.env.OZON_VIDEO_TEST_INPUT,size=(await stat(input)).size;
  const base={inputPath:input,purpose:'video',contentType:'video/mp4',size,ffmpegPath:process.env.OZON_VIDEO_FFMPEG_PATH,ffprobePath:process.env.OZON_VIDEO_FFPROBE_PATH};
  const controller=new AbortController();controller.abort();
  await assert.rejects(processOzonVideoFile({...base,signal:controller.signal}),{name:'AbortError'});
  await assert.rejects(processOzonVideoFile({...base,probe:mp4Probe({width:3840,height:2160,bitRate:15_000_000}),statfs:async()=>({bavail:0,bsize:4096})}),
    {code:'ZONGZI_VIDEO_TEMP_SPACE'});
});
