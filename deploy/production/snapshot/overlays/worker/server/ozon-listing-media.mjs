import {createHash} from 'node:crypto';
import {EntityDecoder, ALL_ENTITIES} from '@nodable/entities';
import {downloadSourceImage, AUTO_LISTING_SOURCE_DOWNLOAD_POLICY} from './auto-listing-source-downloader.mjs';
import {downloadOzonListingVideo} from './ozon-listing-video.mjs';
import {statObject, putObjectFromBuffer, putObjectFromFile} from './object-storage.mjs';

const entities=new EntityDecoder({namedEntities:ALL_ENTITIES});
const absent=error=>['NotFound','NoSuchKey','NoSuchObject'].includes(error?.code)||error?.statusCode===404;
const extension=type=>({'image/jpeg':'jpg','image/png':'png','image/webp':'webp','video/mp4':'mp4','video/quicktime':'mov'})[type];
const hostedVideo=url=>/^(?:www\.)?(?:youtube\.com|youtu\.be|rutube\.ru|vk\.com|vkvideo\.ru)$/i.test(new URL(url).hostname);

// Only the final publication copy is changed. The source snapshot and generated
// image records remain the authority for source identity and gallery order.
export function createOzonListingMedia({publication,downloadBaseUrl,
  statObject:stat=statObject,putObjectFromBuffer:putBuffer=putObjectFromBuffer,
  putObjectFromFile:putFile=putObjectFromFile,downloadImage=downloadSourceImage,
  downloadVideo=downloadOzonListingVideo}={}){
  const source=new URL(publication.baseUrl),base=new URL(downloadBaseUrl);
  if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash)throw new Error('媒体下载地址配置无效');
  if(!base.pathname.endsWith('/'))base.pathname+='/';
  const localPrefix=new URL(publication.prefix+'/',source).pathname;
  const directPrefix=new URL(publication.prefix+'/',base).pathname;
  const urlFor=key=>new URL(key,base).href;
  return async function prepare({accountId,taskId,items}){
    const result=structuredClone(items),ready=new Map();
    async function materialize(value,kind,label,offerId){
      if(!value)return value;
      const cacheKey=kind+':'+value;
      if(ready.has(cacheKey))return ready.get(cacheKey);
      try{
        const url=new URL(value);
        if(kind==='video'&&hostedVideo(url.href))return value;
        let key;
        if(url.origin===source.origin&&url.pathname.startsWith(localPrefix))key=publication.prefix+'/'+url.pathname.slice(localPrefix.length);
        else if(url.origin===base.origin&&url.pathname.startsWith(directPrefix))key=publication.prefix+'/'+url.pathname.slice(directPrefix.length);
        if(key&&/^(?:ai-image-listing\/[a-f0-9]{64}\.(?:jpg|png|webp)|prepared\/[a-f0-9]{64}\.(?:jpg|png|webp|mp4|mov))$/.test(key.slice(publication.prefix.length+1))){
          const found=await stat(key);
          if(!(found.size>0))throw Object.assign(new Error('empty'),{code:'EMPTY_FILE'});
          const direct=urlFor(key);ready.set(cacheKey,direct);return direct;
        }
        const suffix=kind==='video'&&/\.mov$/i.test(url.pathname)?'mov':kind==='video'?'mp4':'jpg';
        const hash=createHash('sha256').update(JSON.stringify([accountId,taskId,kind,value])).digest('hex');
        // The extension is part of the output MIME contract, so a previous
        // successful preparation can be located without downloading again.
        const choices=kind==='image'?['jpg','png','webp']:[suffix,...['mp4','mov'].filter(ext=>ext!==suffix)];
        for(const ext of choices){
          const candidate=`${publication.prefix}/prepared/${hash}.${ext}`;
          try{const found=await stat(candidate);if(found.size>0){const direct=urlFor(candidate);ready.set(cacheKey,direct);return direct;}}
          catch(error){if(!absent(error))throw error;}
        }
        if(kind==='video'){
          let file;
          for(let attempt=0;attempt<2;attempt++){
            try{file=await downloadVideo(value);break;}
            catch(error){
              // Retry an interrupted source read once, before any Ozon import.
              // The downloader removes partial files; invalid media is not retried.
              if(attempt||!/^(?:VIDEO_DOWNLOAD_TIMEOUT|VIDEO_DOWNLOAD_HTTP_5\d\d|ECONNRESET|ETIMEDOUT|EAI_AGAIN|COLLECTOR_EXCEL_IMAGE_DNS_FAILED)$/.test(error?.code||''))throw error;
            }
          }
          try{
            key=`${publication.prefix}/prepared/${hash}.${extension(file.contentType)||suffix}`;
            const saved=await putFile({key,path:file.path,contentType:file.contentType,maxBytes:2*1024**3,
              metadata:{'X-Amz-Meta-Content-Sha256':file.sha256}});
            if(saved.size!==file.size)throw Object.assign(new Error('size mismatch'),{code:'FILE_SIZE_MISMATCH'});
          }finally{await file.cleanup();}
        }else{
          const image=await downloadImage({sourceUrl:value,timeoutMs:30_000,maxBytes:AUTO_LISTING_SOURCE_DOWNLOAD_POLICY.maxBytes,
            maxPixels:AUTO_LISTING_SOURCE_DOWNLOAD_POLICY.maxPixels,maxRedirects:3,forbidHttpsDowngrade:true});
          key=`${publication.prefix}/prepared/${hash}.${extension(image.contentType)}`;
          await putBuffer({key,buffer:image.bytes,contentType:image.contentType,metadata:{'X-Amz-Meta-Content-Sha256':image.contentHash}});
        }
        const direct=urlFor(key);ready.set(cacheKey,direct);return direct;
      }catch(cause){
        const reason=/TIMEOUT/.test(cause?.code||'')?'下载超时':absent(cause)?'原文件不存在':/SPACE|ENOSPC/.test(cause?.code||'')?'服务器剩余空间不足':/BLOCKED|INVALID/.test(cause?.code||'')?'链接或文件格式不受支持':'文件读取或保存失败';
        throw Object.assign(new Error(`商品 ${offerId} ${label}准备失败：${reason}；已生成图片保留，本商品尚未提交，其他商品继续处理。`),
          {code:'AI_LISTING_MEDIA_PREPARATION_FAILED',reasonCode:cause?.code||'MEDIA_READ_FAILED',definitelyNotSubmitted:true});
      }
    }
    async function rich(node,offerId,key='',parent=''){
      if(Array.isArray(node)){for(let i=0;i<node.length;i++)node[i]=await rich(node[i],offerId,key,parent);return node;}
      if(node&&typeof node==='object'){for(const field of Object.keys(node))node[field]=await rich(node[field],offerId,field,key);return node;}
      if(typeof node!=='string')return node;
      if((['src','srcMobile','srcDesktop','poster','backgroundImage'].includes(key)||(key==='url'&&/^(?:img|image|video)$/i.test(parent)))&&/^https?:\/\//i.test(node)){
        return materialize(node,(/video/i.test(parent)||/\.(?:mp4|mov)(?:[?#]|$)/i.test(node))&&key!=='poster'?'video':'image','富内容素材',offerId);
      }
      // Rich text can contain inline images. Change only src/poster attributes,
      // never navigation links or visible text that happens to contain a URL.
      for(const tag of [...node.matchAll(/<(img|video|source)\b[^>]*>/gi)]){
        let updated=tag[0];
        for(const match of [...tag[0].matchAll(/\b(src|poster)\s*=\s*(["'])(.*?)\2/gi)]){
          const original=entities.decode(match[3]);if(!/^https?:\/\//i.test(original))continue;
          const kind=/^(?:video|source)$/i.test(tag[1])&&match[1].toLowerCase()!=='poster'?'video':'image';
          const replacement=await materialize(original,kind,'富内容素材',offerId);
          updated=updated.replace(match[0],match[0].replace(match[3],replacement));
        }
        node=node.replace(tag[0],updated);
      }
      return node;
    }
    for(const item of result){
      for(let i=0;i<(item.images||[]).length;i++)item.images[i]=await materialize(item.images[i],'image',`第 ${i+1} 张图片`,item.offer_id);
      if(item.primary_image)item.primary_image=await materialize(item.primary_image,'image','主图',item.offer_id);
      if(item.color_image)item.color_image=await materialize(item.color_image,'image','颜色样本图片',item.offer_id);
      const attributes=[...(item.attributes||[]),...(item.complex_attributes||[]).flatMap(group=>group.attributes||[])];
      for(const attribute of attributes){
        if([21841,21845].includes(Number(attribute.id))){
          for(let i=0;i<(attribute.values||[]).length;i++)attribute.values[i].value=await materialize(attribute.values[i].value,'video',Number(attribute.id)===21845?'封面视频':`第 ${i+1} 个视频`,item.offer_id);
        }else if(Number(attribute.id)===11254){
          for(const entry of attribute.values||[]){
            let content;try{content=JSON.parse(entry.value);}catch{continue;}
            entry.value=JSON.stringify(await rich(content,item.offer_id));
          }
        }
      }
    }
    return result;
  };
}
