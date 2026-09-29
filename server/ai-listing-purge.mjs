import {createHash} from 'node:crypto';
import {EntityDecoder, ALL_ENTITIES} from '@nodable/entities';
import {createAiListingRepository} from './ai-listing-repository.mjs';
import {taskActionReason} from './ai-listing-task-controls.mjs';
import {purgeCollectedItems} from './collection-purge.mjs';

export const AI_LISTING_PURGE_AFTER_MS = 15 * 24 * 60 * 60 * 1000;
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const entities = new EntityDecoder({namedEntities:ALL_ENTITIES});
const mediaKey = /^(?:listing-media\/v1\/(?:ai-image-listing\/[a-f0-9]{64}\.(?:jpg|png|webp)|prepared\/[a-f0-9]{64}\.(?:jpg|png|webp|mp4|mov))|staging\/collector\/[a-f0-9]{24}\/[a-f0-9-]{36})$/;
const taskRecord = row => ({...row.body,id:row.id,accountId:row.account_id,version:row.version,status:row.status,
  deletedAt:row.deleted_at == null ? null : Number(row.deleted_at),controlAction:row.control_action,
  leaseToken:row.lease_token,leaseExpiresAt:Number(row.lease_expires_at)});

// Includes JSON encoded rich content and HTML attributes, without treating an
// arbitrary client path as a storage key or accepting arbitrary bucket prefixes.
export function mediaUrls(value, result = new Set()) {
  if (Array.isArray(value)) for (const child of value) mediaUrls(child,result);
  else if (value && typeof value === 'object') for (const child of Object.values(value)) mediaUrls(child,result);
  else if (typeof value === 'string') {
    try { const parsed=JSON.parse(value);if(parsed && typeof parsed==='object'){mediaUrls(parsed,result);return result;} } catch {}
    for (const match of entities.decode(value).matchAll(/https?:\/\/[^\s<>"'\\]+/g)) result.add(match[0]);
  }
  return result;
}
function keyFromUrl(value,bases) {
  try {
    const url=new URL(value);
    for(const base of bases){const origin=new URL(base);if(url.origin!==origin.origin)continue;
      const path=decodeURIComponent(url.pathname).replace(/^\//,'');if(mediaKey.test(path))return path;
    }
  } catch {}
  return null;
}
export function purgeMediaKeys({task,uploads=[],submissions=[],publication,downloadBaseUrl}) {
  const keys=new Set(),bases=[publication?.baseUrl,downloadBaseUrl].filter(Boolean);
  const preparedPossible=Boolean(submissions.length || task.submissionId || task.submissionStarted
    || task.submissionStage || ['SUBMITTING','SUBMITTED','SUBMISSION_FAILED','SUBMISSION_UNCERTAIN'].includes(task.stoppedFrom));
  const add=key=>{if(key && mediaKey.test(key))keys.add(key);};
  for(const key of task.mediaKeys||[])add(key);
  for(const image of task.images||[]){
    // These fields are exclusively filled by the server generation port.
    add(image.objectKey);add(keyFromUrl(image.generatedUrl,bases));add(keyFromUrl(image.previewUrl,bases));
  }
  for(const submission of submissions)for(const url of mediaUrls(submission.body.items))add(keyFromUrl(url,bases));
  const accountPrefix=sha(task.accountId).slice(0,24);
  for(const upload of uploads){
    if(upload.account_id!==task.accountId || !upload.object_key?.startsWith(`staging/collector/${accountPrefix}/`))continue;
    add(upload.object_key);
    const ref=upload.confirmed_object;
    const ext={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','video/mp4':'mp4','video/quicktime':'mov'}[ref?.contentType];
    if(ext && preparedPossible)add(`listing-media/v1/prepared/${sha([task.accountId,task.id,upload.id,ref.versionId,ref.etag])}.${ext}`);
  }
  // Preparation may have uploaded a copy immediately before a crash, before its
  // final URL entered the submission journal. Reproduce its task-scoped names.
  if(preparedPossible)for(const url of mediaUrls([task.source,task.collectWait?.initialSource,task.images])){
    if(keyFromUrl(url,bases)?.startsWith('listing-media/v1/'))continue;
    for(const kind of ['image','video']){
      const hashes=new Set([sha([task.accountId,task.id,kind,url])]);
      if(kind==='video')for(const purpose of ['','video','video-cover','rich-video'])hashes.add(sha([task.accountId,task.id,kind,purpose,url,'ozon-video-v1']));
      for(const hash of hashes)for(const ext of kind==='image'?['jpg','png','webp']:['mp4','mov'])add(`listing-media/v1/prepared/${hash}.${ext}`);
    }
  }
  return [...keys].sort();
}

// Shared by the worker and read-only historical audits. Durable channel rows
// survive retry/reset of image status, unlike the transient attempt counters.
export function unresolvedLegacyMediaImages(task,requests=[]) {
  if(task.mediaJournalVersion===1 || Number.isSafeInteger(task.legacyMediaInventoryVerifiedAt))return [];
  const attemptsFor=image=>requests.filter(request=>image.requestKey && (request.request_key===image.requestKey || request.request_key.startsWith(image.requestKey+':')));
  return (task.images||[]).filter(image=>{
    if(image.generatedUrl)return false;
    const attempts=attemptsFor(image);
    const suspect=attempts.length || image.status==='UPLOAD_FAILED' || image.lastError?.code==='AI_LISTING_STORAGE_FAILED'
      || image.status==='GENERATING' && image.attempts>0;
    if(!suspect)return false;
    // FAILED means generation/raw-result persistence did not return to the
    // publication stage. The exact single attempt must be accounted for.
    const currentKey=image.activeAttemptId?image.requestKey+':'+image.activeAttemptId:image.requestKey;
    return image.attempts!==1 || !attempts.some(request=>request.request_key===currentKey) || attempts.some(request=>request.status!=='FAILED');
  });
}

export function createAiListingPurge({pool,storage,publication,downloadBaseUrl,reconcileBilling,recoverLegacyMediaKeys,clock=Date.now,maxObjects=20}) {
  const repository=createAiListingRepository({pool});
  async function sources(client,task) {
    const ids=[...new Set([task,...(task.purgeAliases||[])].flatMap(row=>[row.source?.collectItemId,row.collectWait?.initialSource?.collectItemId,
      row.sourceType==='COLLECT_BOX'?row.sourceId:null]).filter(Boolean))];
    if(!ids.length)return {remove:[],retained:[]};
    const rows=(await client.query(`SELECT c.id,c.source_sku,
      ARRAY(SELECT v->>'sku' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d.data->'variants')='array' THEN d.data->'variants' ELSE '[]'::jsonb END) v) AS variant_skus,
      EXISTS(SELECT 1 FROM (
        SELECT id FROM ai_image_listing_tasks WHERE account_id=c.account_id AND body->>'permanentlyDeletedAt' IS NULL AND body->>'sourceId'=c.id
        UNION ALL
        SELECT id FROM ai_image_listing_tasks WHERE account_id=c.account_id AND body->>'permanentlyDeletedAt' IS NULL AND body#>>'{source,collectItemId}'=c.id
        UNION ALL
        SELECT id FROM ai_image_listing_tasks WHERE account_id=c.account_id AND body->>'permanentlyDeletedAt' IS NULL AND body#>>'{collectWait,initialSource,collectItemId}'=c.id
      ) refs WHERE id<>$3 AND NOT(id=ANY($4::text[]))) AS shared
      FROM collect_items c LEFT JOIN product_drafts d ON d.id=c.current_draft_id
      WHERE c.account_id=$1 AND c.id=ANY($2::text[]) FOR UPDATE OF c`,[task.accountId,ids,task.id,(task.purgeAliases||[]).map(row=>row.id)])).rows;
    const selected=new Set((task.source?.items || task.collectWait?.initialSource?.items || []).map(item=>String(item.sku)));
    if(!selected.size)for(const sku of [task.sku,...(task.collectWait?.selectedSkus||[])])if(sku)selected.add(String(sku));
    const remove=[],retained=[];
    for(const row of rows){
      const skus=(row.variant_skus.length?row.variant_skus.map(String):[String(row.source_sku)]);
      (row.shared || skus.some(sku=>!selected.has(sku)) ? retained : remove).push(row.id);
    }
    return {remove,retained};
  }
  async function save(client,task,purge) {
    await client.query(`UPDATE ai_image_listing_tasks SET body=jsonb_set(body,'{purge}',$3::jsonb),version=version+1
      WHERE account_id=$1 AND id=$2 AND body->>'permanentlyDeletedAt' IS NULL`,[task.accountId,task.id,JSON.stringify(purge)]);
    task.purge=purge;
  }
  async function retainedKeys(client,task,keys,remove) {
    if(!keys.length)return new Set();
    // One batched reference check across accounts. Match the complete key so
    // changing CDN hosts or JSON/HTML wrapping cannot hide a shared reference.
    // Inventory keys already passed mediaKey. Split on their literal directory
    // and take their exact tail length instead of regex-extracting every media
    // reference in every historical document, including unrelated hashes.
    const formats=[...new Map(keys.map(key=>{
      const split=key.lastIndexOf('/')+1,prefix=key.slice(0,split),length=key.length-split;
      return [prefix+length,{prefix,length}];
    })).values()];
    const rows=(await client.query(`WITH refs AS (
      SELECT body::text AS value FROM ai_image_listing_tasks WHERE id<>$1 AND NOT(id=ANY($4::text[])) AND body->>'permanentlyDeletedAt' IS NULL
      UNION ALL SELECT c.summary::text FROM collect_items c WHERE NOT(c.id=ANY($2::text[]))
      UNION ALL SELECT d.data::text FROM product_drafts d WHERE NOT(d.collect_item_id=ANY($2::text[]))
      UNION ALL SELECT v.data::text FROM product_draft_variants v JOIN product_drafts d ON d.id=v.draft_id WHERE NOT(d.collect_item_id=ANY($2::text[]))
      UNION ALL SELECT r.data::text FROM product_draft_revisions r JOIN product_drafts d ON d.id=r.draft_id WHERE NOT(d.collect_item_id=ANY($2::text[]))
      UNION ALL SELECT payload::text FROM collect_raw_payloads WHERE NOT(collect_item_id=ANY($2::text[]))
      UNION ALL SELECT body::text FROM ai_image_listing_submissions WHERE task_id<>$1 AND NOT(task_id=ANY($4::text[]))
      UNION ALL SELECT (body#>'{purge,retainedMediaKeys}')::text FROM ai_image_listing_tasks WHERE body#>'{purge,retainedMediaKeys}' IS NOT NULL
      UNION ALL SELECT items::text FROM submission_snapshots
      UNION ALL SELECT image_url || raw::text FROM products
      UNION ALL SELECT confirmed_object::text FROM collector_media_uploads WHERE NOT(COALESCE(collect_item_id,'')=ANY($2::text[]))
    ), extracted AS (
      SELECT prefix || left(part,key_length) AS key FROM refs
      CROSS JOIN unnest($5::text[],$6::int[]) AS formats(prefix,key_length)
      CROSS JOIN LATERAL string_to_table(replace(value,chr(92),''),prefix) WITH ORDINALITY AS parts(part,position)
      WHERE position>1
    ) SELECT DISTINCT key FROM extracted WHERE key=ANY($3::text[])`,
    [task.id,remove,keys,(task.purgeAliases||[]).map(row=>row.id),formats.map(row=>row.prefix),formats.map(row=>row.length)])).rows;
    const retained=new Set(rows.map(row=>row.key));
    const ownSubmissions=(await client.query('SELECT body FROM ai_image_listing_submissions WHERE account_id=$1 AND task_id=ANY($2::text[])',[task.accountId,[task.id,...(task.purgeAliases||[]).map(row=>row.id)]])).rows;
    for(const {body} of ownSubmissions){
      // A failed group may already have successfully imported siblings. Preserve
      // every public file explicitly referenced by those live Ozon products.
      const succeeded=new Set((body.results||[]).filter(row=>row.importStatus==='SUCCEEDED').map(row=>row.offerId));
      const live=JSON.stringify((body.items||[]).filter(item=>succeeded.has(item.offer_id))).replaceAll('\\','');
      for(const key of keys)if(live.includes(key))retained.add(key);
    }
    return retained;
  }
  async function finish(client,task,purge) {
    await client.query('BEGIN');
    try {
      await client.query('SELECT id FROM ai_image_listing_tasks WHERE id=$1 FOR UPDATE',[task.id]);
      const current=purge.sources;
      if(current.remove.length)await purgeCollectedItems(client,task.accountId,current.remove);
      await client.query('DELETE FROM collector_media_uploads WHERE account_id=$1 AND collect_item_id=ANY($2::text[])',[task.accountId,current.remove]);
      // Failed/prepared submission journals keep identities and results but no
      // deleted source media. Successful item snapshots remain usable history.
      await client.query(`UPDATE ai_image_listing_submissions SET body=(body-'source'-'config') || jsonb_build_object('items',COALESCE(
        (SELECT jsonb_agg(item) FROM jsonb_array_elements(COALESCE(body->'items','[]'::jsonb)) item
          WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(body->'results','[]'::jsonb)) result
            WHERE result->>'offerId'=item->>'offer_id' AND result->>'importStatus'='SUCCEEDED')),'[]'::jsonb)),updated_at=NOW()
        WHERE account_id=$1 AND task_id=ANY($2::text[]) AND NOT(task_id=ANY($3::text[]))`,[task.accountId,[task.id,...(task.purgeAliases||[]).map(row=>row.id)],purge.retainedSubmissionTaskIds||[]]);
      const results=new Map((task.submissionResults||[]).map(result=>[String(result.sku),result]));
      const journals=(await client.query('SELECT body FROM ai_image_listing_submissions WHERE account_id=$1 AND task_id=ANY($2::text[])',[task.accountId,[task.id,...(task.purgeAliases||[]).map(row=>row.id)]])).rows;
      for(const {body} of journals)for(const result of body.results||[])if(result.importStatus==='SUCCEEDED')results.set(String(result.sku),result);
      const succeeded=[...results.values()].filter(result=>result.importStatus==='SUCCEEDED').map(result=>String(result.sku));
      // A completed cleanup releases automatic ownership of unlisted SKUs so a
      // later fresh collection can create new work. Already imported SKUs keep
      // both their owner and independent minimal success evidence.
      await client.query('DELETE FROM collector_ai_sku_owners WHERE account_id=$1 AND task_id=ANY($2::text[]) AND NOT(source_sku=ANY($3::text[])) AND NOT(task_id=ANY($4::text[]))',[task.accountId,[task.id,...(task.purgeAliases||[]).map(row=>row.id)],succeeded,purge.retainedSubmissionTaskIds||[]]);
      const submissionResults=[...results.values()].map(result=>Object.fromEntries(['sku','offerId','productId','importStatus','stockStatus'].filter(key=>result[key]!==undefined).map(key=>[key,result[key]])));
      const receipt={permanentlyDeletedAt:Number(clock()),requestHash:task.requestHash,sourceType:task.sourceType,importBatchId:task.importBatchId,
        sourceId:task.sourceId,sku:task.sku,name:task.name,createdAt:task.createdAt,updatedAt:Number(clock()),
        submissionId:task.submissionId,submissionResults,submissionTarget:task.submissionTarget,
        purge:{state:'COMPLETED',requestedAt:purge.requestedAt,completedAt:Number(clock()),deletedObjects:purge.deletedObjects||0,
          deletedVersions:purge.deletedVersions||0,retainedObjects:purge.retainedObjects||0,retainedSources:current.retained.length,billingReview:purge.billingReview||[],mediaReview:purge.mediaReview||[],
          retainedSubmissionTaskIds:purge.retainedSubmissionTaskIds||[],retainedMediaKeys:purge.retainedSubmissionTaskIds?.length?purge.objects.filter(o=>o.state==='RETAINED').map(o=>o.key):[]}};
      await client.query(`UPDATE ai_image_listing_tasks SET body=$3::jsonb,work_phase='idle',version=version+1,
        lease_token=NULL,lease_expires_at=NULL WHERE account_id=$1 AND id=$2`,[task.accountId,task.id,JSON.stringify(receipt)]);
      for(const alias of task.purgeAliases||[]){
        const stub={permanentlyDeletedAt:receipt.permanentlyDeletedAt,requestHash:alias.requestHash,sourceType:alias.sourceType,
          sourceId:alias.sourceId,sku:alias.sku,name:alias.name,createdAt:alias.createdAt,updatedAt:receipt.updatedAt,
          importBatchId:alias.importBatchId,mergedTaskId:task.id};
        await client.query(`UPDATE ai_image_listing_tasks SET body=$3::jsonb,work_phase='idle',version=version+1,
          lease_token=NULL,lease_expires_at=NULL WHERE account_id=$1 AND id=$2 AND status='MERGED'`,[task.accountId,alias.id,JSON.stringify(stub)]);
      }
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}
  }
  async function sweep() {
    const client=await pool.connect();let locked=false,task;
    try {
      // A session lock survives the short DB transactions, without holding any
      // transaction open while COS runs. A crashed worker releases it naturally.
      locked=(await client.query("SELECT pg_try_advisory_lock(hashtextextended('ai-listing-purge',0)) AS locked")).rows[0].locked;
      if(!locked)return null;
      const now=Number(clock());
      // Separate indexed intent/due branches keep idle polling away from large
      // unrelated task bodies. Queue discovery carries identities only; load the
      // current version of just the task we will execute, not twenty snapshots.
      const candidates=(await client.query(`WITH candidates AS (
        (SELECT id,account_id,version,deleted_at,
          CASE WHEN body#>>'{purge,state}'='FAILED' THEN 2 ELSE 0 END AS priority,
          COALESCE((body#>>'{purge,nextAttemptAt}')::bigint,0) AS next_attempt_at
          FROM ai_image_listing_tasks WHERE body->'purge' IS NOT NULL
          AND body->>'permanentlyDeletedAt' IS NULL AND deleted_at IS NOT NULL AND control_action IS NULL
          AND (lease_token IS NULL OR lease_expires_at<=$1)
          AND COALESCE((body#>>'{purge,nextAttemptAt}')::bigint,0)<=$1
          ORDER BY priority,next_attempt_at,deleted_at,id LIMIT 20)
        UNION ALL
        (SELECT id,account_id,version,deleted_at,1 AS priority,0::bigint AS next_attempt_at
          FROM ai_image_listing_tasks WHERE deleted_at IS NOT NULL AND deleted_at<=$2
          AND control_action IS NULL
          AND body->'purge' IS NULL AND body->>'permanentlyDeletedAt' IS NULL
          AND (lease_token IS NULL OR lease_expires_at<=$1)
          ORDER BY deleted_at,id LIMIT 20)
        ) SELECT * FROM candidates
        ORDER BY priority,next_attempt_at,deleted_at,id LIMIT 20`,[now,now-AI_LISTING_PURGE_AFTER_MS])).rows;
      for(const identity of candidates){
        const row=(await client.query(`SELECT * FROM ai_image_listing_tasks WHERE account_id=$1 AND id=$2 AND version=$3
          AND deleted_at IS NOT NULL AND control_action IS NULL AND body->>'permanentlyDeletedAt' IS NULL
          AND (lease_token IS NULL OR lease_expires_at<=$4)`,[identity.account_id,identity.id,identity.version,now])).rows[0];
        if(!row)continue;
        const candidate=taskRecord(row);
        if(!candidate.purge){
          if(taskActionReason(candidate,'permanentDelete'))continue;
          task=await repository.requestPurge({accountId:candidate.accountId,taskId:candidate.id,expectedVersion:candidate.version,now,client});
          if(!task)continue;
        }else task=candidate;
        break;
      }
      if(!task)return null;
      if(task.purge.state!=='RUNNING'){
        const started={...task.purge,state:'RUNNING'};delete started.errorMessage;
        await save(client,task,started);
      }
      task.purgeAliases=task.importBatchId?(await client.query(`SELECT * FROM ai_image_listing_tasks WHERE account_id=$1
        AND status='MERGED' AND body->>'mergedTaskId'=$2 AND body->>'importBatchId'=$3 AND body->>'permanentlyDeletedAt' IS NULL`,
        [task.accountId,task.id,task.importBatchId])).rows.map(taskRecord):[];
      if(!task.purge.legacyInventoryChecked){
        const recovered=[],mediaReview=[];
        for(const row of [task,...task.purgeAliases]){
          if(row.mediaJournalVersion===1 || Number.isSafeInteger(row.legacyMediaInventoryVerifiedAt))continue;
          const missing=(row.images||[]).filter(image=>!image.generatedUrl);
          if(!missing.length)continue;
          const requests=(await client.query('SELECT request_key,status FROM ai_user_channel_requests WHERE account_id=$1 AND task_id=$2',[row.accountId,row.id])).rows;
          const unresolved=unresolvedLegacyMediaImages(row,requests);
          if(!unresolved.length)continue;
          try{
            if(!recoverLegacyMediaKeys)throw new Error('Result spool unavailable');
            recovered.push(...await recoverLegacyMediaKeys({task:row,images:unresolved,requests}));
          }catch{
            // Incomplete historical file ownership is an audit issue, not a
            // reason to keep a user-deleted task visible forever.
            mediaReview.push({taskId:row.id,reason:'HISTORICAL_MEDIA_INVENTORY_INCOMPLETE',images:unresolved,requests});
          }
        }
        // Inventory reconstruction only reads the saved result spool. Persist it
        // with the next source/manifest checkpoint (or the failure checkpoint),
        // avoiding another rewrite of the large immutable source snapshot.
        task.purge={...task.purge,legacyInventoryChecked:true,recoveredMediaKeys:recovered,mediaReview};
      }
      const billingReview=[];
      for(const row of [task,...task.purgeAliases]){
        const result=await reconcileBilling?.({accountId:row.accountId,taskId:row.id,client,forPurge:true});
        if(result?.billingReview)billingReview.push(result.billingReview);
      }
      task.purge={...task.purge,billingReview};
      let purge={...task.purge,state:'RUNNING'};delete purge.errorMessage;task.purge=purge;
      if(!purge.sources){
        await client.query('BEGIN');
        try{
          // Same collection row/account locks as normal draft writes/deletion.
          // Freeze the owned source before COS I/O so a concurrent draft edit
          // cannot introduce an unrelated sibling after the sharing decision.
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[task.accountId]);
          purge.sources=await sources(client,task);
          await client.query('UPDATE collect_items SET deleted_at=COALESCE(deleted_at,NOW()) WHERE account_id=$1 AND id=ANY($2::text[])',[task.accountId,purge.sources.remove]);
          purge.retainedSources=purge.sources.retained.length;
          await save(client,task,purge);
          await client.query('COMMIT');
        }catch(error){await client.query('ROLLBACK');delete task.purge.sources;throw error;}
      }
      const source=purge.sources;
      if(!purge.objects){
        const uploads=(await client.query(`SELECT * FROM collector_media_uploads WHERE account_id=$1
          AND collect_item_id=ANY($2::text[])`,[task.accountId,[...source.remove,...source.retained]])).rows;
        const submissions=(await client.query('SELECT * FROM ai_image_listing_submissions WHERE account_id=$1 AND task_id=ANY($2::text[])',[task.accountId,[task.id,...task.purgeAliases.map(row=>row.id)]])).rows;
        const unresolvedIds=new Set([task,...task.purgeAliases].filter(row=>row.stoppedFrom==='SUBMISSION_UNCERTAIN'
          || ['SUBMITTING','SUBMITTED','SUBMISSION_UNCERTAIN'].includes(row.status)).map(row=>row.id));
        for(const {task_id,body} of submissions)if((!body.attempts && ['IMPORTING','UNCERTAIN','IMPORTED'].includes(body.status))
          || (body.attempts||[]).some(a=>['IMPORTING','ACCEPTED','UNCERTAIN'].includes(a.status))
          || (body.results||[]).some(r=>['SENDING','SENT','UNCERTAIN'].includes(r.imageRepair?.status)))unresolvedIds.add(task_id);
        purge.retainedSubmissionTaskIds=[...unresolvedIds];
        purge.objects=[...new Set([...(purge.recoveredMediaKeys||[]),...[task,...task.purgeAliases].flatMap(row=>purgeMediaKeys({task:row,uploads,submissions:submissions.filter(s=>s.task_id===row.id),publication:typeof publication==='function'?publication():publication,downloadBaseUrl}))])].map(key=>({key,state:'PENDING'}));
      }
      const unchecked=purge.objects.filter(object=>object.state==='PENDING');
      if(unchecked.length&&!Number.isSafeInteger(purge.referencesCheckedAt)){
        await client.query('BEGIN');
        try{
          // Existing writers finish before manifest publication. Later writers
          // see PENDING keys and are fenced while the reference scan runs, so the
          // potentially large scan does not hold a global writer lock.
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended('ai-listing-media-reference-admission',0))");
          await save(client,task,purge);
          await client.query('COMMIT');
        }catch(error){await client.query('ROLLBACK');throw error;}
        const retained=purge.retainedSubmissionTaskIds?.length
          ? new Set(unchecked.map(object=>object.key))
          : await retainedKeys(client,task,unchecked.map(object=>object.key),source.remove);
        for(const object of unchecked)if(retained.has(object.key)){
          object.state='RETAINED';purge.retainedObjects=(purge.retainedObjects||0)+1;
        }
        // The complete manifest remains a writer admission fence across batches
        // and restarts. Later batches can reuse this durable reference decision.
        purge.referencesCheckedAt=Number(clock());await save(client,task,purge);
      }
      const pending=purge.objects.filter(object=>object.state==='PENDING').slice(0,maxObjects);
      for(const object of pending){
        const result=await storage.deleteObjectVersions({key:object.key});
        object.state='DELETED';purge.deletedObjects=(purge.deletedObjects||0)+(result.deletedVersions>0?1:0);
        purge.deletedVersions=(purge.deletedVersions||0)+(Number(result.deletedVersions)||0);
      }
      if(!purge.objects.some(object=>object.state==='PENDING'))await finish(client,task,purge);
      else if(pending.length)await save(client,task,purge);
      return {taskId:task.id,state:purge.objects.some(object=>object.state==='PENDING')?'RUNNING':'COMPLETED'};
    } catch(error) {
      // Missing historical ownership cannot heal on a timer. An explicit retry
      // resets nextAttemptAt; avoid rewriting large source snapshots each minute.
      if(task)await save(client,task,{...task.purge,state:'FAILED',nextAttemptAt:error.requiresInventoryReview?Number.MAX_SAFE_INTEGER:Number(clock())+60_000,
        errorMessage:error.purgeMessage || '部分资料尚未清理完成，系统会继续重试；也可点击永久删除重试。'});
      throw error;
    } finally {
      if(locked)await client.query("SELECT pg_advisory_unlock(hashtextextended('ai-listing-purge',0))");
      client.release();
    }
  }
  return {sweep};
}
