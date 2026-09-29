import {createHash,randomUUID} from 'node:crypto';
import {EntityDecoder,ALL_ENTITIES} from '@nodable/entities';
import {createListingMediaStorage} from './listing-media-storage.mjs';
import {validateCollectorMedia,collectorMediaProbeAvailable} from './collector-media-validation.mjs';
import {getPostgresPool} from './db/connection.mjs';
import {listingAssetPublicationLocation} from './runtime-config.mjs';

const fail=(code,status=422)=>Object.assign(new Error(code),{code,status});
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const entities=new EntityDecoder({namedEntities:ALL_ENTITIES});
const purposes={'video':'video','video-cover':'video','video-poster':'image','color':'image','rich-video':'video','rich-image':'image'};
const hosted=url=>/^(?:www\.)?(?:youtube\.com|youtu\.be|rutube\.ru|vk\.com|vkvideo\.ru)$/i.test(new URL(url).hostname);

// Logical slots are retained, even when several slots reference identical bytes.
export function listCollectorMedia(payload={}){
  const result=[],seen=new Set();
  const rows=[payload,...(payload.variants||[]),...(payload.variantData?.variants||[])];
  for(const row of rows){
    const sourceSku=String(row.sku||row.id||row.product_id||'');if(!sourceSku||seen.has(sourceSku))continue;seen.add(sourceSku);
    const counts={};
    const add=(value,purpose)=>{
      if(typeof value!=='string'||!/^https?:\/\//i.test(value))return;
      const index=counts[purpose]||0;counts[purpose]=index+1;
      try{if(purposes[purpose]==='video'&&hosted(value))return;}catch{return;}
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
      for(const tag of node.matchAll(/<(img|video|source)\b[^>]*>/gi))for(const match of tag[0].matchAll(/\b(src|poster)\s*=\s*(["'])(.*?)\2/gi))
        add(entities.decode(match[3]),/^(?:video|source)$/i.test(tag[1])&&match[1].toLowerCase()!=='poster'?'rich-video':'rich-image');
    };
    let content=row.richContent??row.rich_content;
    if(content===undefined)content=(row.sourceCategory?.attributes||row.attributes||[]).find(a=>Number(a.id||a.key)===11254)?.values?.[0]?.value;
    if(typeof content==='string'){try{content=JSON.parse(content);}catch{ /* Inline rich HTML is also supported. */ }}
    rich(content);
  }
  return result;
}

export function validateUploadExpectation(input={}){
  const {sourceSku,purpose,index,sourceUrl,size,contentType,md5}=input;
  const kind=purposes[purpose],max=kind==='video'?2*1024**3:10*1024**2;
  let url;try{url=new URL(sourceUrl);}catch{throw fail('COLLECTOR_MEDIA_INPUT_INVALID');}
  if(input.key!==undefined||input.objectKey!==undefined||typeof sourceSku!=='string'||!sourceSku||sourceSku.length>240
    ||!kind||!Number.isSafeInteger(index)||index<0||index>1000||!Number.isSafeInteger(size)||size<1||size>max
    ||!['https:','http:'].includes(url.protocol)||url.username||url.password||sourceUrl.length>8000
    ||!(kind==='video'?['video/mp4','video/quicktime']:['image/png','image/jpeg','image/webp']).includes(contentType)
    ||typeof md5!=='string'||! /^[A-Za-z0-9+/]{22}==$/.test(md5)||Buffer.from(md5,'base64').toString('base64')!==md5)
    throw fail('COLLECTOR_MEDIA_INPUT_INVALID');
  return {sourceSku,purpose,index,sourceUrl,size,contentType,md5};
}

export async function collectorMediaCapabilities(env=process.env){
  if(env.COLLECTOR_MEDIA_DIRECT_UPLOAD!=='1'||env.LISTING_MEDIA_STORAGE!=='cos'||!env.LISTING_ASSET_DOWNLOAD_BASE_URL)return {};
  try{const storage=createListingMediaStorage({env}),publication=listingAssetPublicationLocation(env),download=new URL(env.LISTING_ASSET_DOWNLOAD_BASE_URL);
    if(publication.prefix!=='listing-media/v1'||download.protocol!=='https:'||download.username||download.password||download.search||download.hash)return {};
    if(!storage.signCollectorPut||!await collectorMediaProbeAvailable(env.COLLECTOR_MEDIA_FFPROBE_PATH))return {};
    return {mediaDirectUploadV1:true,mediaSharedReferencesV1:true};
  }catch{return {};}
}

const publicReference=(row,source)=>({uploadId:row.id,sourceSku:source?.sourceSku??row.source_sku,purpose:row.purpose,index:source?.index??row.media_index,sourceUrl:row.source_url,
  ...row.confirmed_object});
const publicIntent=(row,source)=>({uploadId:row.id,sourceSku:source?.sourceSku??row.source_sku,purpose:row.purpose,index:source?.index??row.media_index,sourceUrl:row.source_url,
  size:Number(row.expected_size),contentType:row.expected_type,md5:row.expected_md5});
const sameSource=(value,row)=>value.sourceSku===row.source_sku&&value.purpose===row.purpose&&value.index===row.media_index&&value.sourceUrl===row.source_url;
const sameMedia=(value,row)=>value.purpose===row.purpose&&value.sourceUrl===row.source_url;
const sourceKey=value=>JSON.stringify([value.sourceSku,value.purpose,value.index,value.sourceUrl]);
const slotKey=value=>JSON.stringify([value.sourceSku,value.purpose,value.index]);
const recoverySources=previous=>{
  const manifest=new Set(listCollectorMedia(previous.raw_payload).map(sourceKey));
  return [...(previous.raw_payload?.mediaObjects||[]),...(previous.raw_payload?.mediaIntents||[])].filter(ref=>manifest.has(sourceKey(ref)));
};
const recoveryEvidence=(sources,row,source)=>sources.some(ref=>ref.uploadId===row.id&&sameMedia(ref,row)&&(!source||sourceKey(ref)===sourceKey(source)));

async function failedPredecessor(client,claim,previousItemId){
  const previous=(await client.query(`SELECT item.*,run.status AS run_status FROM collector_task_items item
    JOIN collector_task_runs run ON run.id=item.run_id AND run.account_id=item.account_id
    WHERE item.id=$1 AND item.account_id=$2`,[previousItemId,claim.accountId])).rows[0];
  if(!previous||previous.status!=='FAILED'||!['COMPLETED','FAILED','CANCELLED'].includes(previous.run_status)
    ||previous.run_id!==claim.retryFromRunId||previous.collect_item_id)throw fail('COLLECTOR_MEDIA_RECOVERY_SCOPE',403);
  return previous;
}

// withLease holds the existing run lock for each short mutable boundary. No
// transaction/connection is held while COS bytes or ffprobe are being read.
export function createCollectorMediaUploads({withLease,storage=createListingMediaStorage(),env=process.env,validate=validateCollectorMedia}={}){
  async function record(client,claim,id){
    const row=(await client.query('SELECT * FROM collector_media_uploads WHERE id=$1 AND account_id=$2 AND run_id=$3 FOR UPDATE',[id,claim.accountId,claim.runId])).rows[0];
    if(!row||row.device_id!==claim.deviceId||row.lease_hash!==claim.leaseHash)throw fail('COLLECTOR_MEDIA_CLAIM_MISMATCH',409);
    return row;
  }
  async function ticket(row,source){
    const intent=publicIntent(row,source);
    if(row.confirmed_object)return {uploadId:row.id,confirmed:true,mediaObject:publicReference(row,source),intent};
    let signed;try{signed=await storage.signCollectorPut({key:row.object_key,contentType:row.expected_type,md5:row.expected_md5,expires:600});}
    catch{throw fail('COLLECTOR_MEDIA_STORAGE_UNAVAILABLE',502);}
    return {uploadId:row.id,key:row.object_key,method:'PUT',url:signed.url,headers:signed.headers,size:Number(row.expected_size),expiresAt:row.expires_at,intent};
  }
  async function restore(client,claim,input){
    const row=(await client.query('SELECT * FROM collector_media_uploads WHERE id=$1 AND account_id=$2 FOR UPDATE',[input.resumeUploadId,claim.accountId])).rows[0];
    let evidence;
    if(!input.previousItemId){
      if(!row||row.run_id!==claim.runId||row.device_id!==claim.deviceId||row.lease_hash!==claim.leaseHash)throw fail('COLLECTOR_MEDIA_CLAIM_MISMATCH',409);
    }else {
    const previous=await failedPredecessor(client,claim,input.previousItemId);
    evidence=recoverySources(previous);
    // Only a terminal, explicitly selected failed predecessor can authorize a
    // transfer. The original failed payload remains the immutable source trail.
    if(!row||row.collect_item_id||!(row.run_id===previous.run_id&&row.collector_item_id===previous.id||row.run_id===claim.runId)
      ||!recoveryEvidence(evidence,row))throw fail('COLLECTOR_MEDIA_RECOVERY_SCOPE',403);
    }
    if(input.key!==undefined||input.objectKey!==undefined||!sameMedia(input,row)
      ||['size','contentType','md5'].some(key=>input[key]!==undefined&&input[key]!==publicIntent(row)[key]))throw fail('COLLECTOR_MEDIA_REFERENCE_TAMPERED');
    if(!sameSource(input,row)){
      if(!evidence){
        const current=(await client.query('SELECT raw_payload FROM collector_task_items WHERE id=$1 AND account_id=$2 AND run_id=$3',
          [row.collector_item_id,claim.accountId,claim.runId])).rows[0];
        evidence=current?recoverySources(current):[];
      }
      if(!recoveryEvidence(evidence,row,input))throw fail('COLLECTOR_MEDIA_REFERENCE_TAMPERED');
    }
    const expected=validateUploadExpectation(publicIntent(row));
    const identity=hash([claim.accountId,claim.runId,claim.deviceId,claim.leaseHash,expected]);
    const updated=(await client.query(`UPDATE collector_media_uploads SET run_id=$2,device_id=$3,lease_hash=$4,identity_hash=$5,
      collector_item_id=CASE WHEN run_id=$2 THEN collector_item_id ELSE NULL END,
      expires_at=CASE WHEN confirmed_object IS NULL THEN NOW()+INTERVAL '10 minutes' ELSE expires_at END
      WHERE id=$1 RETURNING *`,[row.id,claim.runId,claim.deviceId,claim.leaseHash,identity])).rows[0];
    return ticket(updated,input);
  }
  return {
    async issue(input){
      if(!storage.signCollectorPut)throw fail('COLLECTOR_MEDIA_DISABLED',409);
      if(input.resumeUploadId)return withLease(input,(client,claim)=>restore(client,claim,input));
      const expected=validateUploadExpectation(input);
      return withLease(input,async(client,claim)=>{
        const identity=hash([claim.accountId,claim.runId,claim.deviceId,claim.leaseHash,expected]);
        const id=randomUUID(),key=`staging/collector/${hash(claim.accountId).slice(0,24)}/${id}`;
        const row=(await client.query(`INSERT INTO collector_media_uploads
          (id,account_id,run_id,device_id,lease_hash,identity_hash,source_sku,purpose,media_index,source_url,object_key,expected_size,expected_type,expected_md5,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW()+INTERVAL '10 minutes')
          ON CONFLICT(identity_hash) DO UPDATE SET expires_at=CASE WHEN collector_media_uploads.confirmed_object IS NULL THEN EXCLUDED.expires_at ELSE collector_media_uploads.expires_at END RETURNING *`,
        [id,claim.accountId,claim.runId,claim.deviceId,claim.leaseHash,identity,expected.sourceSku,expected.purpose,expected.index,expected.sourceUrl,key,expected.size,expected.contentType,expected.md5])).rows[0];
        return ticket(row);
      });
    },
    async confirm(input){
      const row=await withLease(input,(client,claim)=>record(client,claim,input.uploadId));
      if(row.confirmed_object)return {mediaObject:publicReference(row)};
      if(new Date(row.expires_at).getTime()<=Date.now())throw fail('COLLECTOR_MEDIA_UPLOAD_EXPIRED',409);
      let head;
      try{head=await storage.headCollectorObject({key:row.object_key});}
      catch(error){if(error.statusCode===404||['NoSuchKey','NotFound'].includes(error.code))throw fail('COLLECTOR_MEDIA_NOT_UPLOADED',409);throw fail('COLLECTOR_MEDIA_STORAGE_UNAVAILABLE',502);}
      if(!head.versionId||head.versionId==='null'||!/^\d+$/.test(head.crc64||'')||head.size!==Number(row.expected_size)
        ||head.contentType!==row.expected_type||head.etag!==Buffer.from(row.expected_md5,'base64').toString('hex'))throw fail('COLLECTOR_MEDIA_CHECKSUM_MISMATCH');
      const semantics=await validate(head,{readRange:storage.readCollectorRange,ffprobePath:env.COLLECTOR_MEDIA_FFPROBE_PATH,signal:input.signal,purpose:row.purpose});
      const object={key:head.key,versionId:head.versionId,etag:head.etag,crc64:head.crc64,size:head.size,contentType:semantics.contentType,
        md5:row.expected_md5,...semantics};
      return withLease(input,async(client,claim)=>{
        const latest=await record(client,claim,input.uploadId);
        if(latest.confirmed_object)return {mediaObject:publicReference(latest)};
        if(new Date(latest.expires_at).getTime()<=Date.now())throw fail('COLLECTOR_MEDIA_UPLOAD_EXPIRED',409);
        await client.query('UPDATE collector_media_uploads SET confirmed_object=$2::jsonb,confirmed_at=NOW() WHERE id=$1',[row.id,JSON.stringify(object)]);
        return {mediaObject:publicReference({...latest,confirmed_object:object})};
      });
    },
  };
}

// This is the single reference ingress, called while saving a leased collector
// item and again at its later V4 handoff. The latter uses the already saved item
// identity, never the now-expired run lease.
export async function consumeCollectorMediaObjects(client,{accountId,runId,itemId,deviceId,leaseHash,retryFromRunId,collectItemId,payload}){
  if(payload.mediaObjects===undefined&&payload.mediaIntents===undefined)return payload;
  const refs=payload.mediaObjects===undefined?[]:payload.mediaObjects,intents=payload.mediaIntents===undefined?[]:payload.mediaIntents;
  // Shared uploads can occupy thousands of valid SKU slots. Validate those
  // slots against the source manifest below; query upload objects once per id.
  if(!Array.isArray(refs)||!Array.isArray(intents))throw fail('COLLECTOR_MEDIA_REFERENCE_INVALID');
  if(!refs.length&&!intents.length)return {...payload,mediaObjects:[]};
  if(!runId||!itemId)throw fail('COLLECTOR_MEDIA_REFERENCE_SCOPE',403);
  const entries=[...refs.map(ref=>({ref,confirmed:true})),...intents.map(ref=>({ref,confirmed:false}))];
  if(entries.some(({ref})=>typeof ref?.uploadId!=='string'))throw fail('COLLECTOR_MEDIA_REFERENCE_INVALID');
  const slots=new Set(),states=new Map();
  for(const {ref,confirmed} of entries){
    const slot=slotKey(ref);
    if(slots.has(slot)||states.has(ref.uploadId)&&states.get(ref.uploadId)!==confirmed)throw fail('COLLECTOR_MEDIA_REFERENCE_INVALID');
    slots.add(slot);states.set(ref.uploadId,confirmed);
  }
  const ids=[...states.keys()];
  const rows=(await client.query('SELECT * FROM collector_media_uploads WHERE account_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE',[accountId,ids])).rows;
  const byId=new Map(rows.map(row=>[row.id,row])),sources=new Set(listCollectorMedia(payload).map(sourceKey)),confirmed=[],pending=[];
  const foreign=rows.filter(row=>row.run_id!==runId);
  let previous=null,evidence=[];
  if(foreign.length){
    const recovery=payload.mediaRecovery;
    if(!leaseHash||!deviceId||typeof recovery?.itemId!=='string'||recovery.runId!==retryFromRunId)
      throw fail('COLLECTOR_MEDIA_REFERENCE_SCOPE',403);
    previous=await failedPredecessor(client,{accountId,runId,deviceId,leaseHash,retryFromRunId},recovery.itemId);
    if(previous.run_id!==recovery.runId)throw fail('COLLECTOR_MEDIA_RECOVERY_SCOPE',403);
    evidence=recoverySources(previous);
  }
  for(const {ref,confirmed:isConfirmed} of entries){
    let row=byId.get(ref.uploadId);
    if(row&&row.run_id!==runId){
      if(!previous||row.run_id!==previous.run_id||row.collector_item_id!==previous.id||row.collect_item_id
        ||!recoveryEvidence(evidence,row))throw fail('COLLECTOR_MEDIA_RECOVERY_SCOPE',403);
      const expected=validateUploadExpectation(publicIntent(row));
      const identity=hash([accountId,runId,deviceId,leaseHash,expected]);
      row=(await client.query(`UPDATE collector_media_uploads SET run_id=$2,device_id=$3,lease_hash=$4,identity_hash=$5,
        collector_item_id=$6,expires_at=CASE WHEN confirmed_object IS NULL THEN NOW()+INTERVAL '10 minutes' ELSE expires_at END
        WHERE id=$1 AND account_id=$7 AND run_id=$8 AND collector_item_id=$9 RETURNING *`,
      [row.id,runId,deviceId,leaseHash,identity,itemId,accountId,previous.run_id,previous.id])).rows[0];
      if(!row)throw fail('COLLECTOR_MEDIA_RECOVERY_SCOPE',403);
      byId.set(row.id,row);
    }
    if(!row||isConfirmed&&!row.confirmed_object||row.run_id!==runId||row.collector_item_id&&row.collector_item_id!==itemId
      ||(leaseHash?row.lease_hash!==leaseHash&&row.collector_item_id!==itemId:row.collector_item_id!==itemId)
      ||row.collect_item_id&&collectItemId&&row.collect_item_id!==collectItemId)throw fail('COLLECTOR_MEDIA_REFERENCE_SCOPE',403);
    if(!sameMedia(ref,row)||!sources.has(sourceKey(ref))
      ||!row.collector_item_id&&!sources.has(sourceKey(publicIntent(row))))throw fail('COLLECTOR_MEDIA_REFERENCE_TAMPERED');
    if(isConfirmed)confirmed.push(publicReference(row,ref));
    else {
      const intent=publicIntent(row,ref);
      if(['size','contentType','md5'].some(key=>ref[key]!==intent[key]))throw fail('COLLECTOR_MEDIA_REFERENCE_TAMPERED');
      pending.push(intent);
    }
  }
  await client.query(`UPDATE collector_media_uploads SET collector_item_id=$3,collect_item_id=COALESCE(collect_item_id,$4),
    consumed_at=CASE WHEN $4::text IS NOT NULL THEN COALESCE(consumed_at,NOW()) ELSE consumed_at END WHERE account_id=$1 AND id=ANY($2::text[])`,
  [accountId,ids,itemId,collectItemId||null]);
  return {...payload,mediaObjects:confirmed,...(payload.mediaIntents!==undefined?{mediaIntents:pending}:{})};
}

export async function loadCollectorMediaForPublication({accountId,collectItemId,refs},pool){
  if(!refs?.length)return [];
  const ids=[...new Set(refs.map(ref=>ref.uploadId))];
  const client=pool||await getPostgresPool();
  const rows=(await client.query('SELECT * FROM collector_media_uploads WHERE account_id=$1 AND collect_item_id=$2 AND id=ANY($3::text[])',[accountId,collectItemId,ids])).rows;
  const byId=new Map(rows.map(row=>[row.id,row]));
  const aliasItems=[...new Set(refs.flatMap(ref=>{const row=byId.get(ref.uploadId);return row&&!sameSource(ref,row)?[row.collector_item_id]:[];}))];
  const items=aliasItems.length?(await client.query('SELECT id,raw_payload FROM collector_task_items WHERE account_id=$1 AND id=ANY($2::text[])',[accountId,aliasItems])).rows:[];
  const evidence=new Map(items.map(item=>[item.id,recoverySources(item)]));
  return refs.map(ref=>{
    const row=byId.get(ref.uploadId);
    if(!row?.confirmed_object||!sameMedia(ref,row)||!sameSource(ref,row)&&!recoveryEvidence(evidence.get(row.collector_item_id)||[],row,ref))throw fail('COLLECTOR_MEDIA_REFERENCE_SCOPE',403);
    return publicReference(row,ref);
  });
}
