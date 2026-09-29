import {createHash} from 'node:crypto';
import {EntityDecoder, ALL_ENTITIES} from '@nodable/entities';
import {downloadSourceImage, AUTO_LISTING_SOURCE_DOWNLOAD_POLICY} from './auto-listing-source-downloader.mjs';
import {downloadOzonListingVideo} from './ozon-listing-video.mjs';
import {statObject, putObjectFromBuffer, putObjectFromFile} from './object-storage.mjs';
import {retryListingUpload} from './ai-listing-image-cache.mjs';
import {loadCollectorMediaForPublication} from './collector-media-upload.mjs';
import {createReadStream} from 'node:fs';
import {processOzonVideoFile} from '../shared/ozon-video-processing.mjs';

const entities=new EntityDecoder({namedEntities:ALL_ENTITIES});
const absent=error=>['NotFound','NoSuchKey','NoSuchObject'].includes(error?.code)||error?.statusCode===404;
const extension=type=>({'image/jpeg':'jpg','image/png':'png','image/webp':'webp','video/mp4':'mp4','video/quicktime':'mov'})[type];
const hostedVideo=url=>/^(?:www\.)?(?:youtube\.com|youtu\.be|rutube\.ru|vk\.com|vkvideo\.ru)$/i.test(new URL(url).hostname);
const sha256File=async(path,checkControl)=>{await checkControl?.();const digest=createHash('sha256');let checked=0;
  for await(const chunk of createReadStream(path)){digest.update(chunk);checked+=chunk.length;if(checked>=8*1024**2){await checkControl?.();checked=0;}}
  return digest.digest('hex');};

// Only the final publication copy is changed. The source snapshot and generated
// image records remain the authority for source identity and gallery order.
export function createOzonListingMedia({publication,downloadBaseUrl,
  statObject:stat=statObject,putObjectFromBuffer:putBuffer=putObjectFromBuffer,
  putObjectFromFile:putFile=putObjectFromFile,downloadImage=downloadSourceImage,
  downloadVideo=downloadOzonListingVideo,processVideoFile=processOzonVideoFile,runVideoWork=work=>work(),
  ffmpegPath=process.env.OZON_VIDEO_FFMPEG_PATH||'/usr/bin/ffmpeg',ffprobePath=process.env.OZON_VIDEO_FFPROBE_PATH||'/usr/bin/ffprobe',
  onDiagnostic=()=>{},copyVerifiedObject,loadVerifiedMedia=loadCollectorMediaForPublication}={}){
  const source=new URL(publication.baseUrl),base=new URL(downloadBaseUrl);
  if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash)throw new Error('媒体下载地址配置无效');
  if(!base.pathname.endsWith('/'))base.pathname+='/';
  const localPrefix=new URL(publication.prefix+'/',source).pathname;
  const directPrefix=new URL(publication.prefix+'/',base).pathname;
  const urlFor=key=>new URL(key,base).href;
  return async function prepare({accountId,taskId,items,source:collectedSource,checkControl,client}){
    const result=structuredClone(items),ready=new Map();
    const refs=collectedSource?.sourceSnapshot?.mediaObjects||[];
    const verified=refs.length?await loadVerifiedMedia({accountId,collectItemId:collectedSource.collectItemId,refs},client):[];
    const skuByOffer=new Map((collectedSource?.items||[]).map(group=>[group.listingItem?.offer_id,String(group.sku)]));
    let controlError;
    const check=async()=>{try{await checkControl?.();}catch(error){controlError=error;throw error;}};
    const report=async event=>{try{await onDiagnostic({taskId,...event});}catch{ /* Diagnostics never invalidate completed media. */ }};
    async function materialize(value,kind,label,offerId,purpose=''){
      await check();
      if(!value)return value;
      const cacheKey=offerId+':'+purpose+':'+kind+':'+value;
      if(ready.has(cacheKey))return ready.get(cacheKey);
      let phase='lookup',phaseStarted=Date.now();const timings={};
      try{
        const url=new URL(value);
        if(kind==='video'&&hostedVideo(url.href))return value;
        const reference=purpose&&verified.find(ref=>ref.sourceSku===skuByOffer.get(offerId)&&ref.purpose===purpose&&ref.sourceUrl===value);
        if(reference){
          if(!copyVerifiedObject)throw Object.assign(new Error('已确认素材的 COS 发布存储不可用'),{code:'COLLECTOR_MEDIA_STORAGE_UNAVAILABLE'});
          const digest=createHash('sha256').update(JSON.stringify([accountId,taskId,reference.uploadId,reference.versionId,reference.etag])).digest('hex');
          const key=`${publication.prefix}/prepared/${digest}.${extension(reference.contentType)}`;
          const identical=found=>found.size===reference.size&&found.etag===reference.etag&&found.crc64===reference.crc64&&found.contentType===reference.contentType;
          await retryListingUpload(async()=>{
            await check();
            try{const found=await stat(key);if(!identical(found))throw Object.assign(new Error('正式素材校验不匹配'),{code:'COLLECTOR_MEDIA_COPY_MISMATCH'});return found;}
            catch(error){if(!absent(error))throw error;}
            const saved=await copyVerifiedObject({source:reference,key});
            if(!identical(saved))throw Object.assign(new Error('发布副本校验失败'),{code:'COLLECTOR_MEDIA_COPY_MISMATCH'});
            return saved;
          });
          await check();
          const direct=urlFor(key);ready.set(cacheKey,direct);return direct;
        }
        let key;
        if(url.origin===source.origin&&url.pathname.startsWith(localPrefix))key=publication.prefix+'/'+url.pathname.slice(localPrefix.length);
        else if(url.origin===base.origin&&url.pathname.startsWith(directPrefix))key=publication.prefix+'/'+url.pathname.slice(directPrefix.length);
        if(key&&/^(?:ai-image-listing\/[a-f0-9]{64}\.(?:jpg|png|webp)|prepared\/[a-f0-9]{64}\.(?:jpg|png|webp|mp4|mov))$/.test(key.slice(publication.prefix.length+1))){
          const found=await stat(key);
          if(!(found.size>0))throw Object.assign(new Error('empty'),{code:'EMPTY_FILE'});
          const direct=urlFor(key);ready.set(cacheKey,direct);return direct;
        }
        const suffix=kind==='video'&&/\.mov$/i.test(url.pathname)?'mov':kind==='video'?'mp4':'jpg';
        const legacyHash=createHash('sha256').update(JSON.stringify([accountId,taskId,kind,value])).digest('hex');
        const hash=kind==='video'?createHash('sha256').update(JSON.stringify([accountId,taskId,kind,purpose,value,'ozon-video-v1'])).digest('hex'):legacyHash;
        // The extension is part of the output MIME contract, so a previous
        // successful preparation can be located without downloading again.
        const choices=kind==='image'?['jpg','png','webp']:[suffix,...['mp4','mov'].filter(ext=>ext!==suffix)];
        for(const digest of hash===legacyHash?[hash]:[hash,legacyHash])for(const ext of choices){
          const candidate=`${publication.prefix}/prepared/${digest}.${ext}`;
          try{const found=await stat(candidate);if(found.size>0){const direct=urlFor(candidate);ready.set(cacheKey,direct);
            if(kind==='video')await report({offerId,kind,purpose,label,phase:'reuse',bytes:found.size,elapsedMs:Date.now()-phaseStarted});return direct;}}
          catch(error){if(!absent(error))throw error;}
        }
        if(kind==='video'){
          let file;
          phase='download';phaseStarted=Date.now();
          for(let attempt=0;attempt<2;attempt++){
            try{await check();file=await downloadVideo(value,{checkControl:check});break;}
            catch(error){
              // The normal downloader owns its bounded resume budget. Older
              // injected downloaders may still need one complete-read retry.
              if(error===controlError||error.mediaDiagnostics||attempt||!/^(?:VIDEO_DOWNLOAD_TIMEOUT|VIDEO_DOWNLOAD_HTTP_5\d\d|ECONNRESET|ETIMEDOUT|EAI_AGAIN|COLLECTOR_EXCEL_IMAGE_DNS_FAILED)$/.test(error?.code||''))throw error;
            }
          }
          try{
            timings.downloadMs=Date.now()-phaseStarted;
            await report({...file.diagnostics,offerId,kind,purpose,label,phase:'download',elapsedMs:timings.downloadMs,bytes:file.size});
            await check();
            phase='queue';phaseStarted=Date.now();
            const uploadFile=await runVideoWork(async()=>{timings.queueMs=Date.now()-phaseStarted;phase='process';phaseStarted=Date.now();
              const processed=await processVideoFile({inputPath:file.path,purpose,contentType:file.contentType,size:file.size,
              ffmpegPath,ffprobePath,signal:file.signal,checkControl:check});return {...file,path:processed.path,size:processed.size,contentType:processed.contentType,
                sha256:processed.processed?await sha256File(processed.path,check):file.sha256,processed:processed.processed};});
            timings.processMs=Date.now()-phaseStarted;
            await report({offerId,kind,purpose,label,phase:'process',elapsedMs:timings.processMs,queueMs:timings.queueMs,bytes:uploadFile.size,processed:uploadFile.processed});
            key=`${publication.prefix}/prepared/${hash}.${extension(uploadFile.contentType)||suffix}`;
            phase='upload';phaseStarted=Date.now();
            const saved=await retryListingUpload(async()=>{await check();return putFile({key,path:uploadFile.path,contentType:uploadFile.contentType,maxBytes:2*1024**3,
              metadata:{'X-Amz-Meta-Content-Sha256':uploadFile.sha256}});});
            if(saved.size!==uploadFile.size)throw Object.assign(new Error('size mismatch'),{code:'FILE_SIZE_MISMATCH'});
            timings.uploadMs=Date.now()-phaseStarted;
            await report({offerId,kind,purpose,label,phase:'upload',elapsedMs:timings.uploadMs,bytes:uploadFile.size,processed:uploadFile.processed});
            await check();
          }finally{await file.cleanup();}
        }else{
          await check();
          const image=await downloadImage({sourceUrl:value,timeoutMs:30_000,maxBytes:AUTO_LISTING_SOURCE_DOWNLOAD_POLICY.maxBytes,
            maxPixels:AUTO_LISTING_SOURCE_DOWNLOAD_POLICY.maxPixels,maxRedirects:3,forbidHttpsDowngrade:true});
          await check();
          key=`${publication.prefix}/prepared/${hash}.${extension(image.contentType)}`;
          await retryListingUpload(async()=>{await check();return putBuffer({key,buffer:image.bytes,contentType:image.contentType,metadata:{'X-Amz-Meta-Content-Sha256':image.contentHash}});});
          await check();
        }
        const direct=urlFor(key);ready.set(cacheKey,direct);return direct;
      }catch(cause){
        if(cause===controlError)throw cause;
        timings[`${phase}Ms`]=Date.now()-phaseStarted;
        const mediaDiagnostics={...cause.mediaDiagnostics,phase,elapsedMs:timings[`${phase}Ms`],timings};
        await report({...mediaDiagnostics,offerId,kind,purpose,label,phase:'failed',failedPhase:phase,reasonCode:cause?.code||'MEDIA_READ_FAILED'});
        const stageLabel=kind==='video'?{download:'视频下载',process:'视频处理',upload:'视频上传',queue:'等待视频处理',lookup:'已保存视频读取'}[phase]:null;
        const reason=/TIMEOUT|TIMEDOUT/i.test(cause?.code||'')?(stageLabel?`${stageLabel}超时`:'下载或处理超时'):absent(cause)?'原文件不存在':/SPACE|ENOSPC/.test(cause?.code||'')?'服务器剩余空间不足':
          /^(?:ZONGZI|OZON)_VIDEO_/.test(cause?.code||'')?`视频规格无法在不裁切、不放大或不截短的前提下处理（${cause.code}）`:/BLOCKED|INVALID/.test(cause?.code||'')?'链接或文件格式不受支持':'文件读取或保存失败';
        throw Object.assign(new Error(`商品 ${offerId} ${label}准备失败：${reason}；已生成图片保留，本商品尚未提交，其他商品继续处理。`),
          {code:'AI_LISTING_MEDIA_PREPARATION_FAILED',reasonCode:cause?.code||'MEDIA_READ_FAILED',mediaStage:phase,mediaDiagnostics,definitelyNotSubmitted:true});
      }
    }
    async function rich(node,offerId,key='',parent=''){
      if(Array.isArray(node)){for(let i=0;i<node.length;i++)node[i]=await rich(node[i],offerId,key,parent);return node;}
      if(node&&typeof node==='object'){for(const field of Object.keys(node))node[field]=await rich(node[field],offerId,field,key);return node;}
      if(typeof node!=='string')return node;
      if((['src','srcMobile','srcDesktop','poster','backgroundImage'].includes(key)||(key==='url'&&/^(?:img|image|video)$/i.test(parent)))&&/^https?:\/\//i.test(node)){
        const kind=(/video/i.test(parent)||/\.(?:mp4|mov)(?:[?#]|$)/i.test(node))&&key!=='poster'?'video':'image';
        return materialize(node,kind,'富内容素材',offerId,'rich-'+kind);
      }
      // Rich text can contain inline images. Change only src/poster attributes,
      // never navigation links or visible text that happens to contain a URL.
      for(const tag of [...node.matchAll(/<(img|video|source)\b[^>]*>/gi)]){
        let updated=tag[0];
        for(const match of [...tag[0].matchAll(/\b(src|poster)\s*=\s*(["'])(.*?)\2/gi)]){
          const original=entities.decode(match[3]);if(!/^https?:\/\//i.test(original))continue;
          const kind=/^(?:video|source)$/i.test(tag[1])&&match[1].toLowerCase()!=='poster'?'video':'image';
          const replacement=await materialize(original,kind,'富内容素材',offerId,'rich-'+kind);
          updated=updated.replace(match[0],match[0].replace(match[3],replacement));
        }
        node=node.replace(tag[0],updated);
      }
      return node;
    }
    for(const item of result){
      for(let i=0;i<(item.images||[]).length;i++)item.images[i]=await materialize(item.images[i],'image',`第 ${i+1} 张图片`,item.offer_id);
      if(item.primary_image)item.primary_image=await materialize(item.primary_image,'image','主图',item.offer_id);
      if(item.color_image)item.color_image=await materialize(item.color_image,'image','颜色样本图片',item.offer_id,'color');
      const attributes=[...(item.attributes||[]),...(item.complex_attributes||[]).flatMap(group=>group.attributes||[])];
      for(const attribute of attributes){
        if([21841,21845].includes(Number(attribute.id))){
          if(Number(attribute.id)===21841&&(attribute.values||[]).length>5)throw Object.assign(new Error(`商品 ${item.offer_id} 普通视频超过 Ozon 每 SKU 5 个上限；未截断来源。`),
            {code:'AI_LISTING_MEDIA_PREPARATION_FAILED',reasonCode:'ZONGZI_VIDEO_COUNT_LIMIT',definitelyNotSubmitted:true});
          for(let i=0;i<(attribute.values||[]).length;i++)attribute.values[i].value=await materialize(attribute.values[i].value,'video',Number(attribute.id)===21845?'封面视频':`第 ${i+1} 个视频`,item.offer_id,Number(attribute.id)===21845?'video-cover':'video');
        }else if(Number(attribute.id)===11254){
          for(const entry of attribute.values||[]){
            let content;try{content=JSON.parse(entry.value);}catch{continue;}
            entry.value=JSON.stringify(await rich(content,item.offer_id));
          }
        }
      }
    }
    await check();return result;
  };
}
