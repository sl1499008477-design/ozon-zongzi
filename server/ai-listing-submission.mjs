import {pinOzonCredential} from './account-ozon-route.mjs';
import { aiListingItemPrice, applyAiListingSourceCategorySnapshot } from "./ai-listing-source-facts.mjs";
import { createHash, randomUUID } from "node:crypto";
import { reserveOzonWriteCapacity } from "./ozon-write-rate-limit.mjs";
import { readOzonProductQuota } from "./ai-listing-store-routing.mjs";
import { callOzonSellerApi as defaultCallOzonSellerApi, callOzonProductInfo } from "./ozon-client.mjs";
import { normalizeOzonImportItems } from "./ozon-import-normalizer.mjs";
import { deriveOzonImportStatus } from "./ozon-import-status.mjs";
import { createOzonCategoryService } from "./ozon-category-service.mjs";
import { assertUsableOperatingStore, readStoreCredentialV3 } from "./listing-pipeline.mjs";
import { createAutoListingRfbsWarehouseVerifier } from "./auto-listing-rfbs-warehouse-verifier.mjs";
import { assertListingWarehouseEligible } from "./listing-warehouse-eligibility.mjs";
import { removeAiListingBrandText } from "./ai-listing-brand-text.mjs";
import {isOzonItemQuotaError,importRetryDelay,submissionQuotaWait,storeSwitchEligible} from "./ai-listing-submission-quota.mjs";

const error = (code, definitelyNotSubmitted = false) => Object.assign(new Error(code), { code, definitelyNotSubmitted });
const decimalMoney = minor => `${BigInt(minor) / 100n}.${String(BigInt(minor) % 100n).padStart(2, "0")}`;
const WAIT_WITHOUT_PROGRESS_MS = 30 * 60_000;

function replaceRichImageReferences(value, replacements) {
  if (Array.isArray(value)) return value.map(child => replaceRichImageReferences(child, replacements));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .map(([key, child]) => [key, replaceRichImageReferences(child, replacements)]));
  if (typeof value !== "string") return value;
  if (replacements.has(value)) return replacements.get(value);
  // Ozon rich-content attributes are JSON strings, not generated/rewritten prose.
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object") return JSON.stringify(replaceRichImageReferences(parsed, replacements));
  } catch { /* Non-JSON text is preserved verbatim. */ }
  return value;
}

export function createAiListingSubmissionPorts({ pool, callOzonSellerApi: suppliedCallOzonSellerApi = defaultCallOzonSellerApi,
  readCredential = ({ accountId, targetStoreId, client }) => readStoreCredentialV3(targetStoreId, accountId, client),
  validateTarget: injectedValidateTarget, normalizeItems: injectedNormalizeItems,
  prepareMedia = async ({items}) => items, clock = Date.now, reserveCapacity = reserveOzonWriteCapacity } = {}) {
  // The CN API gateway returns 502. Only this AI publication flow uses the
  // documented Seller API endpoint; account, collection and other routes stay frozen.
  const publicationPaths=new Set(['/v3/product/import','/v1/product/import/info','/v3/product/info/list',
    '/v2/products/stocks','/v2/product/pictures/import','/v2/product/pictures/info']);
  const callOzonSellerApi=(credential,path,...args)=>suppliedCallOzonSellerApi(
    credential?.ozonRoute==='CN'&&publicationPaths.has(path)?{...credential,ozonRoute:'RU'}:credential,path,...args);
  const category = createOzonCategoryService({ callOzonSellerApi });
  async function loadTarget({ accountId, targetStoreId, targetWarehouseId, client = pool }) {
    return (await client.query(`SELECT w.id,s.owner_account_id AS account_id,w.store_id,w.warehouse_id,
      w.warehouse_type,w.status,w.is_active,w.is_archived,
      EXISTS (SELECT 1 FROM product_stocks ps JOIN products p ON p.id=ps.product_id
        WHERE ps.warehouse_id=w.id AND ps.store_id=w.store_id AND p.store_id=w.store_id
          AND p.is_archived=FALSE AND LOWER(ps.source)='fbs') AS has_active_product_association
      FROM warehouses w JOIN stores s ON s.id=w.store_id
      WHERE s.owner_account_id=$1 AND w.store_id=$2 AND w.id=$3`, [accountId, targetStoreId, targetWarehouseId])).rows[0] || null;
  }
  const validateTarget = injectedValidateTarget || (async ({ accountId, config, validateWarehouse = true, client = pool }) => {
    const store = await assertUsableOperatingStore({ accountId, storeId: config.targetStoreId, client });
    if(config.salePricing && config.salePricing.currency!==store.currencyCode)throw Object.assign(new Error('售价配置与目标店铺币种不同，请重新选择'),{code:'SALE_PRICING_CURRENCY_MISMATCH',statusCode:422,priceValidationFailure:true,definitelyNotSubmitted:true});
    if (!validateWarehouse) return { store };
    const record = await loadTarget({ accountId, targetStoreId: config.targetStoreId, targetWarehouseId: config.targetWarehouseId, client });
    if (String(record?.warehouse_type || "").trim().toUpperCase() !== "RFBS") {
      assertListingWarehouseEligible({ warehouse: record, accountId, targetStoreId: config.targetStoreId,
        hasActiveProductAssociation: record?.has_active_product_association === true });
      if (!/^[1-9]\d{0,15}$/.test(record.warehouse_id) || !Number.isSafeInteger(Number(record.warehouse_id))) {
        throw Object.assign(error("LISTING_WAREHOUSE_NOT_ELIGIBLE"), { status: 422 });
      }
      return { store, warehouse: { platformWarehouseId: record.warehouse_id, fulfillmentType: "FBS" } };
    }
    const verifier = createAutoListingRfbsWarehouseVerifier({ callOzonSellerApi,
      readCredential: async input => pinOzonCredential(await readCredential({...input,client}),config),loadTarget: input => loadTarget({...input,client}) });
    const warehouse = await verifier.verifyRfbsWarehouse({ accountId, actorAccountId: accountId,
      targetStoreId: config.targetStoreId, targetWarehouseId: config.targetWarehouseId, correlationId: "ai-image-listing" });
    return { store, warehouse };
  });
  const save = (client, accountId, id, body) => client.query(
    "UPDATE ai_image_listing_submissions SET body=$3::jsonb,updated_at=NOW() WHERE account_id=$1 AND id=$2", [accountId, id, JSON.stringify(body)]);
  const load = async (client, accountId, id) => (await client.query(
    "SELECT * FROM ai_image_listing_submissions WHERE account_id=$1 AND id=$2", [accountId, id])).rows[0];
  async function locked(accountId, id, work) {
    const client = await pool.connect(); let acquired = false;
    try {
      acquired = (await client.query("SELECT pg_try_advisory_lock(hashtext($1),hashtext($2)) AS locked", [accountId, id])).rows[0].locked;
      if (!acquired) throw error("AI_LISTING_SUBMISSION_BUSY");
      return await work(client);
    } finally {
      if (acquired) await client.query("SELECT pg_advisory_unlock(hashtext($1),hashtext($2))", [accountId, id]);
      client.release();
    }
  }
  const safeCodes = errors => (Array.isArray(errors) ? errors : []).map(value => String(value?.code || value || ""))
    .filter(code => /^[A-Za-z0-9_:-]{1,100}$/.test(code));
  const transportCode = caught => /^(?:ZONGZI|OZON)_HTTP_\d{3}$/.test(caught?.code || "") ? caught.code : "ZONGZI_REQUEST_UNCERTAIN";
  const productRows = response => response?.items || response?.result?.items || [];
  const productId = value => Number.isSafeInteger(Number(value)) && Number(value)>0 ? String(value) : null;
  const stockReady = item => item?.statuses?.status === "price_sent";
  const imageFailureCodes = new Set(['all_image_failed','warning_all_image_failed','primary_image_load_failed','pics_reading_timeout','pics_http_error','some_image_failed']);
  const imageErrors = item => safeCodes(item?.errors?.filter(e=>e.level==='ERROR_LEVEL_ERROR'
    && imageFailureCodes.has(e.code)));
  const hasImageWarning = item => item?.errors?.some(e=>imageFailureCodes.has(e.code));
  const moderationErrors = item => safeCodes(item?.errors?.filter(e=>['DESCRIPTION_DECLINE','IMAGE_TYPE_MISMATCH','IMAGE_DECLINE'].includes(e.code)
    ||e.level==='ERROR_LEVEL_ERROR'&&!imageFailureCodes.has(e.code)));
  const inRecoveryScope = (body,result) => !body.recoverySkus || body.recoverySkus.includes(result.sku);
  const attemptInRecoveryScope = (body,attempt) => !body.recoverySkus || attempt.offerIds.every(offerId=>
    body.results.some(result=>result.offerId===offerId&&inRecoveryScope(body,result)));
  function publicationCheck(result,item) {
    if(!item||!result)return;
    result.publicationCheck={checkedAt:clock(),status:item.statuses?.status||null,statusName:item.statuses?.status_name||null,
      isCreated:item.statuses?.is_created??null,isArchived:item.is_archived??null};
  }
  function noteStockWait(result,item) {
    if(result.stockStatus!=='PENDING')return;
    const signature=JSON.stringify([item?.statuses||null,(result.errors||[]).filter(code=>code!=='ZONGZI_STOCK_WAITING_TIMEOUT')]);
    if(result.waitSignature!==signature){
      result.waitSignature=signature;result.waitingSince=clock();
      if(result.publicationStatus==='WAITING_TIMEOUT'){delete result.publicationStatus;delete result.failureReason;}
    }
    if(clock()-result.waitingSince>=WAIT_WITHOUT_PROGRESS_MS){
      result.stockStatus='FAILED';result.publicationStatus='WAITING_TIMEOUT';
      result.failureReason='Ozon 处理状态已连续 30 分钟无进展；原商品与提交记录保留，可选择此 SKU 查询后继续';
      if(!result.errors?.length)result.errors=['ZONGZI_STOCK_WAITING_TIMEOUT'];
    }
  }
  const imageRepairPending = result => ['WAITING','SENDING','SENT','UNCERTAIN'].includes(result.imageRepair?.status);
  function failImages(result,codes,message='Ozon 图片接收失败；已生成图片保留，重试将仅重传本 SKU 图片并继续处理库存') {
    result.publicationStatus='IMAGE_FAILED';if(result.stockStatus!=='COMPLETED')result.stockStatus='FAILED';result.errors=codes;
    result.failureReason=message;delete result.statusMessage;
    if(result.imageRepair)result.imageRepair.status='FAILED';
  }
  const stockPair = item => `${item.offer_id}:${item.warehouse_id}`;
  function journal(body) {
    if (!body.results) body.results = (body.items || body.stocks || []).map(item => ({
      sku: item.scraped_sku || item.offer_id, offerId: item.offer_id,
      importStatus: ["COMPLETED","STOCKING","STOCK_FAILED"].includes(body.status) ? "SUCCEEDED" : "PENDING",
      stockStatus: body.stocks?.find(stock=>stock.offer_id===item.offer_id)?.completed ? "COMPLETED" : "PENDING", errors: [],
    }));
    if (!body.attempts) body.attempts = body.ozonTaskId || ["IMPORTING","UNCERTAIN"].includes(body.status) ? [{
      id: "legacy", offerIds: body.results.map(item=>item.offerId), ozonTaskId: body.ozonTaskId || null,
      status: body.ozonTaskId ? (["COMPLETED","STOCKING","STOCK_FAILED"].includes(body.status)?"DONE":"ACCEPTED") : "UNCERTAIN",
      // A legacy unknown request has no before-write observation; don't pretend
      // an existing offer proves this particular request succeeded.
      preexistingOfferIds: null,
    }] : [];
    if(body.quotaWait&&!body.quotaCheck&&!body.attempts.some(a=>a.quotaEvidence||['IMPORTING','ACCEPTED','UNCERTAIN'].includes(a.status))){
      delete body.quotaWait;body.retryAt=null;for(const attempt of body.attempts)if(attempt.status==='WAITING')attempt.retryAt=0;
    }
    return body;
  }
  function view(body) {
    const active = body.attempts.some(a=>["WAITING","IMPORTING","ACCEPTED"].includes(a.status)&&attemptInRecoveryScope(body,a));
    const uncertain = body.attempts.some(a=>a.status==="UNCERTAIN") || body.results.some(r=>['SENDING','UNCERTAIN'].includes(r.imageRepair?.status));
    const pendingStock = body.results.some(r=>inRecoveryScope(body,r)&&r.importStatus==="SUCCEEDED" && (r.stockStatus==="PENDING"||imageRepairPending(r)));
    const failed = body.results.some(r=>r.importStatus==="FAILED" || r.stockStatus==="FAILED"
      ||['IMAGE_FAILED','REJECTED'].includes(r.publicationStatus)||!inRecoveryScope(body,r)&&r.stockStatus==='PENDING');
    const status = uncertain ? "UNCERTAIN" : active || pendingStock ? "SUBMITTED" : failed ? "FAILED" :
      body.results.length && body.results.every(r=>r.importStatus==="SUCCEEDED" && r.stockStatus==="COMPLETED") ? "COMPLETED" : "UNCERTAIN";
    const submissionStage=body.submissionWait?.code==='STORE_QUEUE'?'store_wait':body.submissionWait?.code==='RATE_LIMIT'?'import_rate_limit':body.quotaWait?({DAILY_LIMIT:'quota_daily_create',DAILY_UPDATE_LIMIT:'quota_daily_update',TOTAL_LIMIT:'quota_total',QUOTA_UNKNOWN:'quota_unknown'}[body.quotaWait.code]||'quota_unknown'):body.attempts.length&&body.attempts.every(a=>a.status==='WAITING')?'waiting_submit'
      :body.results.some(imageRepairPending)?'repairing_images':body.results.some(r=>r.publicationStatus==='IMAGE_FAILED')?'image_failed':null;
    return {status, submissionTarget:{targetStoreId:body.config.targetStoreId,targetWarehouseId:body.config.targetWarehouseId},storeSwitchEligible:storeSwitchEligible(body),...(body.submissionWait?{submissionWait:structuredClone(body.submissionWait)}:{}), ...(body.quotaWait?{quotaWait:structuredClone(body.quotaWait)}:{}), ...(submissionStage?{submissionStage}:{}), items: structuredClone(body.results), ...(body.retryAt>clock()?{retryAfterMs:body.retryAt-clock()}:{}),
      ...(failed?{errorMessage:body.results.filter(r=>r.errors?.length).map(r=>`${r.sku}: ${r.errors.join("、")}`).join("；")}:{}),
      ...(uncertain?{errorMessage:"上次请求结果未知，已按商品货号核对；未确认部分不会自动重发，请核实远端商品后处理"}:{}),
    };
  }
  async function reconcileImports(client, accountId, id, body, credential) {
    for (const attempt of body.attempts) {
      if(attempt.status==="IMPORTING") attempt.status="UNCERTAIN";
      if (attempt.status === "UNCERTAIN" && !attempt.ozonTaskId) {
        // A legacy request without known identities cannot be proven complete
        // by an empty result set, nor authorize another potentially duplicate write.
        if(!Array.isArray(attempt.offerIds)||!attempt.offerIds.length)continue;
        const rows=productRows(await callOzonProductInfo(credential,{offer_id:attempt.offerIds},60_000,{},callOzonSellerApi));
        for(const result of body.results.filter(r=>attempt.offerIds.includes(r.offerId))){
          const matches=rows.filter(row=>row.offer_id===result.offerId);
          if(Array.isArray(attempt.preexistingOfferIds)&&!attempt.preexistingOfferIds.includes(result.offerId)&&matches.length===1&&productId(matches[0].id||matches[0].product_id)){
            result.importStatus="SUCCEEDED";result.productId=productId(matches[0].id||matches[0].product_id);result.errors=[];
          } else if(result.importStatus!=="SUCCEEDED") result.importStatus="UNKNOWN";
        }
        if(attempt.offerIds.every(offerId=>body.results.some(r=>r.offerId===offerId&&r.importStatus==="SUCCEEDED")))attempt.status="DONE";
        await save(client,accountId,id,body);
        continue;
      }
      if (!["ACCEPTED","UNCERTAIN"].includes(attempt.status) || !attempt.ozonTaskId) continue;
      const response=await callOzonSellerApi(credential,"/v1/product/import/info",{task_id:Number(attempt.ozonTaskId)},60_000,{maxResponseBytes:4*1024*1024});
      const parsed=deriveOzonImportStatus(response,{expectedOfferIds:attempt.offerIds});
      for(const item of parsed.items){
        const result=body.results.find(r=>r.offerId===item.offerId);
        if(!result||result.importStatus==="SUCCEEDED")continue;
        if(item.status==="SUCCEEDED"){result.importStatus="SUCCEEDED";result.productId=item.productId;result.errors=[];}
        else if(["FAILED","SKIPPED"].includes(item.status)){result.importStatus="FAILED";if(isOzonItemQuotaError(item.response))result.quotaRecovery=true;else delete result.quotaRecovery;result.errors=safeCodes(item.response?.errors);if(!result.errors.length)result.errors=["ZONGZI_IMPORT_FAILED"];}
      }
      attempt.status=parsed.done?"DONE":"ACCEPTED";
      if(parsed.done){
        const failedQuota=body.results.filter(r=>attempt.offerIds.includes(r.offerId)&&r.quotaRecovery===true);
        if(failedQuota.length&&!body.attempts.some(a=>a.recoveryOf===attempt.id)){
          body.attempts.push({id:randomUUID(),status:'WAITING',offerIds:failedQuota.map(r=>r.offerId),retryAt:0,recoveryOf:attempt.id,quotaEvidence:true,
            preexistingOfferIds:(attempt.preexistingOfferIds||[]).filter(offerId=>failedQuota.some(r=>r.offerId===offerId))});
        }
      }
      const progress=JSON.stringify(parsed.items.map(item=>[item.offerId,item.status,item.productId]));
      if(attempt.progress!==progress){attempt.progress=progress;attempt.waitingSince=clock();}
      if(!parsed.done && clock()-attempt.waitingSince>=WAIT_WITHOUT_PROGRESS_MS){
        attempt.status='UNCERTAIN';attempt.errorCode='ZONGZI_IMPORT_WAITING_TIMEOUT';
        for(const result of body.results.filter(r=>attempt.offerIds.includes(r.offerId)&&!['SUCCEEDED','FAILED'].includes(r.importStatus))){
          result.importStatus='UNKNOWN';result.statusMessage='Ozon 导入状态连续 30 分钟无进展；继续时只查询原请求，不重复创建商品';
        }
      }
      await save(client,accountId,id,body);
    }
  }
  async function storeRows(client,accountId,storeId) {
    const pending=(await client.query(`/* ai-listing-store-submissions */ SELECT s.id,s.created_at,
      jsonb_build_object('attempts',s.body->'attempts','results',s.body->'results','submissionWait',s.body->'submissionWait') AS body,
      t.status AS task_status,t.deleted_at AS task_deleted_at
      FROM ai_image_listing_submissions s LEFT JOIN ai_image_listing_tasks t ON t.id=s.task_id AND t.account_id=s.account_id
      WHERE s.account_id=$1 AND s.body->'config'->>'targetStoreId'=$2
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(s.body->'attempts','[]'::jsonb)) a
          WHERE a->>'status' IN ('WAITING','IMPORTING','ACCEPTED','UNCERTAIN'))
      ORDER BY s.created_at,s.id`,[accountId,storeId])).rows;
    // Read a single shared observation, including a rejected store archived by
    // an allowed switch. Never materialize old item payloads or media galleries.
    const latest=(await client.query(`/* ai-listing-store-quota-observation */
      SELECT observation AS quota_check FROM (
        SELECT body->'quotaCheck' AS observation FROM ai_image_listing_submissions
          WHERE account_id=$1 AND body->'config'->>'targetStoreId'=$2 AND body ? 'quotaCheck'
        UNION ALL
        SELECT old->'quotaCheck' AS observation FROM ai_image_listing_submissions,
          LATERAL jsonb_array_elements(COALESCE(body->'previousStoreAttempts','[]'::jsonb)) old
          WHERE account_id=$1 AND old->'config'->>'targetStoreId'=$2 AND old ? 'quotaCheck'
      ) observations ORDER BY (observation->>'checkedAt')::bigint DESC LIMIT 1`,[accountId,storeId])).rows[0]?.quota_check;
    if(latest)pending.push({id:null,body:{quotaCheck:latest}});
    return pending;
  }
  async function reconcileStoreBlocker(client,accountId,peer) {
    // A paused task or an idle uncertain task has no worker to poll its accepted
    // request. Borrow its journal lock and perform reads only; pause still stops
    // all product, image and stock writes belonging to that task.
    const acquired=(await client.query('SELECT pg_try_advisory_lock(hashtext($1),hashtext($2)) AS locked',[accountId,peer.id])).rows[0]?.locked;
    if(!acquired)return;
    try{
      const current=await load(client,accountId,peer.id);
      if(!current)return;
      const previous=journal(current.body);
      const credential=pinOzonCredential(await readCredential({accountId,targetStoreId:previous.config.targetStoreId,client}),previous.config);
      try{await reconcileImports(client,accountId,peer.id,previous,credential);}
      catch{/* A failed read cannot authorize another import; preserve uncertainty. */}
      await save(client,accountId,peer.id,previous);peer.body=previous;
    }finally{await client.query('SELECT pg_advisory_unlock(hashtext($1),hashtext($2))',[accountId,peer.id]);}
  }
  async function sendImport(client, accountId, id, body, credential, attempt, beforeExternalWrite) {
    if(attempt.status!=="WAITING"||attempt.retryAt>clock()||!attemptInRecoveryScope(body,attempt))return;
    const storeId=body.config.targetStoreId, lockKey='ai-import-store:'+storeId;
    const acquired=(await client.query('SELECT pg_try_advisory_lock(hashtext($1),hashtext($2)) AS locked',[accountId,lockKey])).rows[0]?.locked;
    const waitStore=async blocker=>{body.submissionWait={code:'STORE_QUEUE',
      message:blocker?.status==='UNCERTAIN'?'相同货号或货号范围待核实的提交尚未确认，不会重复提交':'等待该店铺前一组商品确认导入结果',
      storeId,retryAt:clock()+15000};body.retryAt=body.submissionWait.retryAt;await save(client,accountId,id,body);};
    if(!acquired){await waitStore();return;}
    try {
      const peers=await storeRows(client,accountId,storeId);
      const other=peers.filter(row=>row.id!==id);
      const rateWait=other.map(row=>row.body.submissionWait).filter(wait=>wait?.code==='RATE_LIMIT'&&wait.retryAt>clock()).sort((a,b)=>b.retryAt-a.retryAt)[0];
      if(rateWait){body.submissionWait={...rateWait};body.retryAt=attempt.retryAt=rateWait.retryAt;await save(client,accountId,id,body);return;}
      // Reconcile old requests without replaying them. An uncertain request owns
      // its offer IDs, not every independent product in the same store.
      const unresolved=row=>(row.body.attempts||[]).some(a=>['IMPORTING','ACCEPTED','UNCERTAIN'].includes(a.status));
      for(const peer of other.filter(unresolved))await reconcileStoreBlocker(client,accountId,peer);
      const blocker=other.flatMap(row=>row.body.attempts||[]).find(a=>['IMPORTING','ACCEPTED'].includes(a.status)
        ||a.status==='UNCERTAIN'&&(!Array.isArray(a.offerIds)||!a.offerIds.length||a.offerIds.some(offer=>attempt.offerIds.includes(offer))))
        ||body.attempts.find(a=>a!==attempt&&['IMPORTING','ACCEPTED','UNCERTAIN'].includes(a.status));
      if(blocker){await waitStore(blocker);return;}
      const active=row=>!row.task_deleted_at&&['READY_TO_SUBMIT','SUBMITTING','SUBMITTED'].includes(row.task_status);
      const partial=row=>(row.body.results||[]).some(r=>r.importStatus==='SUCCEEDED')&&(row.body.attempts||[]).some(a=>a.status==='WAITING');
      const ownPartial=body.results.some(r=>r.importStatus==='SUCCEEDED');
      if(!ownPartial&&other.some(row=>active(row)&&partial(row))){await waitStore();return;}
      const items=body.items.filter(item=>attempt.offerIds.includes(item.offer_id));
      // Identity determines whether this attempt consumes create or update
      // quota. Observe it before applying a shared quota wait or allowing a switch.
      const existing=productRows(await callOzonProductInfo(credential,{offer_id:attempt.offerIds},60_000,{},callOzonSellerApi));
      attempt.preexistingOfferIds=existing.filter(item=>productId(item.id||item.product_id)).map(item=>item.offer_id).filter(offerId=>attempt.offerIds.includes(offerId));
      const creates=items.filter(item=>!attempt.preexistingOfferIds.includes(item.offer_id)).length;
      const previous=peers.map(row=>row.body.quotaCheck).filter(Boolean).sort((a,b)=>b.checkedAt-a.checkedAt)[0];
      const evidence=attempt.quotaEvidence===true;
      let check=previous&&(!body.quotaCheck||previous.checkedAt>body.quotaCheck.checkedAt)?previous:body.quotaCheck;
      if(check&&!check.resolved){
        const createCount=items.filter(item=>!attempt.preexistingOfferIds?.includes(item.offer_id)).length;
        const options={storeId,creates:createCount,updates:items.length-createCount,now:clock(),evidence};
        let waiting=submissionQuotaWait(check.quota,options);
        if(check.retryAt>clock()&&(waiting||evidence&&check.quota===null)){
          body.quotaWait={...(waiting||check.wait),retryAt:check.retryAt};body.retryAt=check.retryAt;attempt.retryAt=check.retryAt;
          delete body.submissionWait;await save(client,accountId,id,body);return;
        }
      }
      if(evidence||check&&!check.resolved&&check.retryAt<=clock()){
        // One store lock and a persisted observation are shared by all groups.
        // A failed observation remains a query failure, never proof of exhaustion.
        if(!check||check.resolved||check.retryAt<=clock()){
          let quota=null;try{quota=await readOzonProductQuota(credential,{call:callOzonSellerApi});}catch{}
          check={checkedAt:clock(),quota,retryAt:clock()+300000};body.quotaCheck=check;
        }
        const creates=items.filter(item=>!attempt.preexistingOfferIds?.includes(item.offer_id)).length;
        const waiting=submissionQuotaWait(check.quota,{storeId,creates,updates:items.length-creates,now:clock(),evidence});
        if(waiting){
          // Reuse the original absolute reset deadline across other tasks.
          if(check.wait?.code===waiting.code&&check.retryAt>clock())waiting.retryAt=check.retryAt;
          check.wait=waiting;check.retryAt=waiting.retryAt;body.quotaCheck=check;
          body.quotaWait=waiting;body.retryAt=waiting.retryAt;attempt.retryAt=waiting.retryAt;attempt.quotaCheckedAt=clock();delete body.submissionWait;
          await save(client,accountId,id,body);return;
        }
        // A platform limit error with apparently free quota may be a delayed
        // counter. Back off before the next attempt, without inventing a limit.
        if(evidence&&!attempt.quotaCheckedAt){
          attempt.quotaCheckedAt=clock();attempt.retryAt=clock()+60000;body.retryAt=attempt.retryAt;
          body.quotaWait={code:'QUOTA_UNKNOWN',message:'Ozon 返回商品额度限制，额度计数尚未对应，稍后重试',storeId,retryAt:attempt.retryAt};
          await save(client,accountId,id,body);return;
        }
      }
      if(check){
        const untouchedCreateLimit=['DAILY_LIMIT','TOTAL_LIMIT'].includes(check.wait?.code)&&creates===0;
        const untouchedUpdateLimit=check.wait?.code==='DAILY_UPDATE_LIMIT'&&creates===items.length;
        check.resolved=!untouchedCreateLimit&&!untouchedUpdateLimit;body.quotaCheck=check;
      }
      delete body.quotaWait;delete body.submissionWait;
      await beforeExternalWrite?.({client});
      attempt.status="IMPORTING";attempt.startedAt=clock();attempt.retryAt=null;body.retryAt=null;body.status="IMPORTING";
      attempt.apiRoute=credential.ozonRoute==='CN'?'RU':credential.ozonRoute;
      await save(client,accountId,id,body);
      try {
        const response=await callOzonSellerApi(credential,"/v3/product/import",{items},60_000,{maxResponseBytes:4*1024*1024});
        const taskId=response?.result?.task_id??response?.task_id;
        if(!/^[1-9]\d{0,15}$/.test(String(taskId||""))||!Number.isSafeInteger(Number(taskId)))throw error("AI_LISTING_IMPORT_UNCERTAIN");
        attempt.ozonTaskId=String(taskId);attempt.status="ACCEPTED";body.ozonTaskId=String(taskId);body.status="IMPORTED";
        for(const result of body.results.filter(r=>attempt.offerIds.includes(r.offerId)&&r.quotaRecovery===true)){result.importStatus='PENDING';delete result.quotaRecovery;result.errors=[];}
        await save(client,accountId,id,body);
      } catch(caught) {
        const status=Number(caught.status);attempt.errorCode=transportCode(caught);
        if([400,403,422,429].includes(status)&&isOzonItemQuotaError(caught)){
          attempt.status='WAITING';attempt.quotaEvidence=true;attempt.quotaCheckedAt=null;
          for(const result of body.results.filter(r=>attempt.offerIds.includes(r.offerId))){result.importStatus='FAILED';result.quotaRecovery=true;result.errors=['item_limit_exceeded'];}
          let quota=null;try{quota=await readOzonProductQuota(credential,{call:callOzonSellerApi});}catch{}
          const creates=items.filter(item=>!attempt.preexistingOfferIds.includes(item.offer_id)).length;
          const waiting=submissionQuotaWait(quota,{storeId,creates,updates:items.length-creates,now:clock(),evidence:true})||{code:'QUOTA_UNKNOWN',message:'Ozon 返回商品额度限制，具体限制暂时无法确认，稍后重查',storeId,retryAt:clock()+60000};
          body.quotaCheck={checkedAt:clock(),quota,retryAt:waiting.retryAt,wait:waiting};if(waiting.code!=='QUOTA_UNKNOWN')attempt.quotaCheckedAt=clock();body.quotaWait=waiting;body.retryAt=attempt.retryAt=waiting.retryAt;body.status='IMPORT_WAIT';
        }else if(status===429){attempt.status="WAITING";attempt.retryAt=clock()+importRetryDelay(caught);body.retryAt=attempt.retryAt;body.status="IMPORT_WAIT";
          body.submissionWait={code:'RATE_LIMIT',message:'Ozon 请求频率受限，等待平台允许后重试',retryAt:attempt.retryAt,storeId};
        }else if([400,401,403,404,422].includes(status)){
          attempt.status="REJECTED";body.status="FAILED";
          for(const result of body.results.filter(r=>attempt.offerIds.includes(r.offerId))){result.importStatus="FAILED";result.errors=[caught.body?.ozonCode||attempt.errorCode];}
        }else{attempt.status="UNCERTAIN";body.status="UNCERTAIN";}
        await save(client,accountId,id,body);
      }
    }finally{await client.query('SELECT pg_advisory_unlock(hashtext($1),hashtext($2))',[accountId,lockKey]);}
  }
  async function repairPictures(client,accountId,id,body,credential,result,item,beforeExternalWrite) {
    const repair=result.imageRepair;
    if(!imageRepairPending(result))return;
    const declined=moderationErrors(item);
    if(repair.status==='WAITING'&&declined.length){
      if(result.stockStatus!=='COMPLETED')result.stockStatus='FAILED';result.publicationStatus='REJECTED';result.errors=declined;repair.status='FAILED';
      result.failureReason='图片还包含 Ozon 资料审核问题，未重传图片或修改内容；请单独处理审核问题';return;
    }
    // A process can stop after the write reaches Ozon but before its reply is saved.
    // Reconcile that request; only a new explicit retry of a known failure may send again.
    if(repair.status==='SENDING')repair.status='UNCERTAIN';
    if(!item || productId(item.id||item.product_id)!==productId(result.productId) || !productId(result.productId)){
      // A reused offer must never authorize images or stock on a different product.
      if(repair.status==='WAITING'){
        failImages(result,['AI_LISTING_IMAGE_REPAIR_IDENTITY_MISMATCH'],'无法核对原商品身份，未发送图片或库存；请核对该 SKU 后重试');return;
      }
      repair.status='UNCERTAIN';result.publicationStatus='IMAGE_REPAIR_PENDING';
      result.statusMessage='无法核对原商品身份，已停止图片和库存写入，请核对该 SKU';return;
    }
    if(repair.status==='WAITING'&&stockReady(item)&&!hasImageWarning(item)){
      repair.status='SUCCEEDED';delete result.publicationStatus;delete result.failureReason;delete result.statusMessage;result.errors=[];return;
    }
    if(repair.status==='WAITING'){
      const frozen=body.items.find(row=>row.offer_id===result.offerId);
      if(!frozen?.images?.length){failImages(result,['AI_LISTING_IMAGE_REPAIR_SOURCE_MISSING'],'完整图片资料缺失，请先检查该 SKU；未重传图片');return;}
      // Prepared media is public and immutable. A stable per-attempt query makes
      // Ozon fetch it again instead of skipping an unchanged URL; no file is altered.
      const freshUrl=value=>{const url=new URL(value);url.searchParams.set('_ozon_image_retry',`${id.slice(-12)}-${repair.attempt}`);return url.href;};
      const color=(Array.isArray(item.color_image)?item.color_image[0]:item.color_image)||frozen.color_image||'';
      // v2 replaces this gallery, but does not update 360 media or product fields.
      repair.request={items:[{offer_id:result.offerId,images:frozen.images.map(freshUrl),color_image:color?freshUrl(color):''}]};
      await beforeExternalWrite?.({client});
      repair.status='SENDING';repair.startedAt=clock();await save(client,accountId,id,body);
      try{
        const response=await callOzonSellerApi(credential,'/v2/product/pictures/import',repair.request,60_000,{maxResponseBytes:1024*1024});
        repair.ozonTaskId=productId(response?.task_id);
        repair.status=repair.ozonTaskId?'SENT':'UNCERTAIN';
        repair.acceptedAt=clock();
      }catch(caught){
        const status=Number(caught.status);
        if(status===429){repair.status='WAITING';body.retryAt=clock()+60_000;}
        else if([400,401,403,404,422].includes(status))failImages(result,[transportCode(caught)],'Ozon 未接受图片重传，请检查商品和图片后重试；原商品及已生成图片保留');
        else {repair.status='UNCERTAIN';repair.errorCode=transportCode(caught);}
      }
      await save(client,accountId,id,body);
    }else{
      if(repair.ozonTaskId){
        const response=await callOzonSellerApi(credential,'/v1/product/import/info',{task_id:Number(repair.ozonTaskId)},60_000);
        // An image update acts on an existing product, so its failed result can
        // still have a product_id. Creation-result classification is not applicable.
        const outcomes=productRows(response),outcome=outcomes.length===1&&outcomes[0].offer_id===result.offerId?outcomes[0]:null;
        const sameProduct=outcome&&(!productId(outcome.product_id)||productId(outcome.product_id)===productId(result.productId));
        const failed=outcome?.errors?.some(row=>['error','ERROR_LEVEL_ERROR'].includes(row.level));
        if(sameProduct&&(['failed','skipped'].includes(outcome.status)||outcome.status==='imported'&&failed)){
          failImages(result,safeCodes(outcome.errors).length?safeCodes(outcome.errors):['ZONGZI_IMAGE_UPDATE_FAILED']);return;
        }
        repair.importConfirmed=outcome?.status==='imported'&&!failed&&productId(outcome.product_id)===productId(result.productId);
      }
      // A stale product status is not the result of this repair. Check exact image
      // URLs and the returned task ID; never infer a new failure from elapsed time.
      const response=await callOzonSellerApi(credential,'/v2/product/pictures/info',{product_id:[String(result.productId)]},60_000);
      const pictures=response?.items?.find(row=>productId(row.product_id)===productId(result.productId));
      const requested=repair.request?.items?.[0];
      const urls=[...(requested?.images||[]),requested?.color_image].filter(Boolean);
      if(repair.importConfirmed&&pictures?.errors?.some(row=>urls.includes(row.url))){failImages(result,['ZONGZI_IMAGE_DOWNLOAD_FAILED']);return;}
      const received=new Set([...(pictures?.primary_photo||[]),...(pictures?.photo||[])]);
      const confirmed=repair.importConfirmed || requested?.images?.length&&requested.images.every(url=>received.has(url));
      if(confirmed&&pictures&&!(pictures.errors?.length)&&stockReady(item)&&!hasImageWarning(item)){
        repair.status='SUCCEEDED';delete result.publicationStatus;delete result.failureReason;delete result.statusMessage;result.errors=[];return;
      }
    }
    if(!imageRepairPending(result))return;
    if(repair.status==='SENT'&&clock()-repair.startedAt>=20*60_000)repair.status='UNCERTAIN';
    result.publicationStatus='IMAGE_REPAIR_PENDING';
    result.statusMessage=repair.status==='UNCERTAIN'?'图片重传结果待核实，重试只查询原商品，不重复发送图片':'图片已进入重传流程，等待 Ozon 处理后继续设置库存';
  }
  async function writeStocks(client,accountId,id,body,credential,beforeExternalWrite) {
    if(body.retryAt>clock())return;
    const pending=body.stocks.filter(stock=>body.results.some(r=>r.offerId===stock.offer_id&&inRecoveryScope(body,r)&&r.importStatus==="SUCCEEDED"
      &&(!stock.completed&&r.stockStatus==="PENDING"||imageRepairPending(r))));
    if(!pending.length)return;
    await validateTarget({accountId,config:body.config,client});
    const rows=productRows(await callOzonProductInfo(credential,{offer_id:pending.map(s=>s.offer_id)},60_000,{},callOzonSellerApi));
    const rejected=new Set();
    for(const stock of pending){
      const item=rows.find(row=>row.offer_id===stock.offer_id);
      const status=item?.statuses;
      const result=body.results.find(r=>r.offerId===stock.offer_id);
      publicationCheck(result,item);
      if(result.stockRecovery){
        if(!productId(result.productId)||productId(item?.id||item?.product_id)!==productId(result.productId)){
          result.stockStatus='FAILED';result.errors=['AI_LISTING_STOCK_IDENTITY_MISMATCH'];
          result.failureReason='无法确认原商品身份，未设置库存；请核对原货号对应的 Ozon 商品';rejected.add(stock.offer_id);continue;
        }
        const blockedCodes=safeCodes(item?.errors?.filter(e=>e.level==='ERROR_LEVEL_ERROR'||imageFailureCodes.has(e.code)||moderationErrors(item).includes(e.code)));
        if(blockedCodes.length){
          result.stockStatus='FAILED';result.errors=blockedCodes;result.publicationStatus=moderationErrors(item).length?'REJECTED':'IMAGE_FAILED';
          result.failureReason='原商品仍有图片或资料审核问题，未设置库存；原资料保持不变';rejected.add(stock.offer_id);continue;
        }
        if(item?.statuses?.is_created!==true || ['declined','pending'].includes(item.statuses.moderate_status)){
          result.statusMessage='原商品仍待 Ozon 创建或审核，未设置库存';continue;
        }
      }
      if(imageRepairPending(result))await repairPictures(client,accountId,id,body,credential,result,item,beforeExternalWrite);
      if(imageRepairPending(result)||result.stockStatus==='FAILED'){rejected.add(stock.offer_id);continue;}
      // Import/stock success does not mean Ozon fetched every photo. Retain the
      // warnings from this existing product-info read, independently of stock errors.
      const warningDetails=(item?.errors || []).filter(e=>e.level==="ERROR_LEVEL_WARNING");
      const warnings=[...new Set(safeCodes(warningDetails))];
      if(warnings.length){
        result.publicationWarnings=warnings;
        // Keep per-attribute details even when several warnings share one code.
        result.publicationWarningDetails=structuredClone(warningDetails);
        result.warningMessage=warnings.includes("pics_reading_timeout")
          ? "Ozon 下载部分商品图片超时，请重新上传图片"
          : warnings.some(code=>["primary_image_load_failed","some_image_failed"].includes(code))
            ? "Ozon 未能完整接收商品图片，请重新上传图片" : warnings.join("、");
      } else {delete result.publicationWarnings;delete result.publicationWarningDetails;delete result.warningMessage;}
      const failedImages=imageErrors(item);
      if(status?.is_created===false&&failedImages.length){
        failImages(result,failedImages);rejected.add(stock.offer_id);continue;
      }
      // variant_wait alone is normal moderation. Only an explicit declined,
      // not-created product is a user-correctable terminal publication result.
      if(status?.is_created===false && [status.moderate_status,status.status_failed].includes("declined")){
        // An unchanged rejection timestamp still belongs to the previous
        // publication attempt; elapsed time cannot turn it into a new result.
        if(result.previousPublicationRejectedAt && status.status_updated_at===result.previousPublicationRejectedAt){
          result.publicationStatus="PENDING";
          result.statusMessage="资料修正已提交，等待 Ozon 更新审核结果";
          continue;
        }
        delete result.statusMessage;
        result.publicationStatus="REJECTED";result.stockStatus="FAILED";
        result.publicationRejectedAt=status.status_updated_at||null;
        result.errors=safeCodes(item.errors);if(!result.errors.length)result.errors=["ZONGZI_PUBLICATION_DECLINED"];
        result.failureReason=item.errors?.some(error=>error.code==="DESCRIPTION_DECLINE"&&Number(error.attribute_id)===11254)
          ? "富内容（属性 11254）未通过 Ozon 审核，请修正文字内容后重试；成功图片已保留"
          : item.errors?.some(error=>error.code==="DESCRIPTION_DECLINE"&&Number(error.attribute_id)===4180)
            ? "商品名称（属性 4180）未通过 Ozon 审核，请修正名称后重试；成功图片已保留"
            : "商品资料未通过 Ozon 审核，请修正被拒绝的资料后重试；成功图片已保留";
        rejected.add(stock.offer_id);
      }
    }
    const ready=pending.filter(stock=>!stock.completed&&!rejected.has(stock.offer_id)&&rows.some(item=>item.offer_id===stock.offer_id&&stockReady(item)
      &&(!body.results.find(r=>r.offerId===stock.offer_id).stockRecovery||item.statuses?.is_created===true&&!['declined','pending'].includes(item.statuses?.moderate_status))));
    if(ready.length+rejected.size<pending.length)body.retryAt=clock()+60_000;
    for(let offset=0;offset<ready.length;offset+=100){
      const batch=ready.slice(offset,offset+100);
      const capacity=await reserveCapacity({pool,client,sellerId:credential.clientId,operation:"stock",requestKey:randomUUID(),units:1,pairKeys:batch.map(stockPair),limit:80,clock});
      if(!capacity.allowed){body.retryAt=Math.max(body.retryAt||0,clock()+capacity.retryAfterMs);break;}
      await beforeExternalWrite?.({client});
      body.stockRequest={id:randomUUID(),pairKeys:batch.map(stockPair),startedAt:clock()};
      await save(client,accountId,id,body);
      try {
        const stocks=batch.map(({offer_id,warehouse_id,stock})=>({offer_id,warehouse_id,stock}));
        const response=await callOzonSellerApi(credential,"/v2/products/stocks",{stocks},60_000,{maxResponseBytes:1024*1024});
        for(const stock of batch){
          const result=body.results.find(r=>r.offerId===stock.offer_id);
          const matches=response?.result?.filter?.(item=>item.offer_id===stock.offer_id&&String(item.warehouse_id)===String(stock.warehouse_id))||[];
          const outcome=matches.length===1?matches[0]:null;
          const codes=safeCodes(outcome?.errors);
          if(outcome?.updated===true&&!codes.length){stock.completed=true;result.stockStatus="COMPLETED";result.errors=[];delete result.failureReason;delete result.previousPublicationRejectedAt;delete result.statusMessage;delete result.publicationStatus;delete result.waitingSince;delete result.waitSignature;delete result.stockRecovery;}
          else if(!outcome||codes.length&&codes.every(code=>["PRODUCT_IS_NOT_CREATED","PRODUCT_HAS_NOT_BEEN_TAGGED_YET","TOO_MANY_REQUESTS"].includes(code))){
            body.retryAt=clock()+60_000;result.errors=codes.length?codes:["ZONGZI_STOCK_RESULT_PENDING"];
            if(codes.includes('PRODUCT_IS_NOT_CREATED'))result.stockRecovery=true;
          }
          else {result.stockStatus="FAILED";result.errors=codes.length?codes:["ZONGZI_STOCK_FAILED"];}
        }
      } catch(caught) {
        if(!caught.status||Number(caught.status)===429||Number(caught.status)>=500)body.retryAt=clock()+60_000;
        else for(const stock of batch){const result=body.results.find(r=>r.offerId===stock.offer_id);result.stockStatus="FAILED";result.errors=[transportCode(caught)];}
      }
      delete body.stockRequest;
      await save(client,accountId,id,body);
    }
    for(const stock of pending){const result=body.results.find(r=>r.offerId===stock.offer_id);noteStockWait(result,rows.find(item=>item.offer_id===stock.offer_id));}
    const completed=pending.filter(stock=>stock.completed);
    if(completed.length){
      // Stock acknowledgement does not prove sale availability. Refresh platform status once.
      try {const refreshed=productRows(await callOzonProductInfo(credential,{offer_id:completed.map(stock=>stock.offer_id)},60_000,{},callOzonSellerApi));
        for(const item of refreshed)publicationCheck(body.results.find(r=>r.offerId===item.offer_id),item);
      }catch{/* Preserve the confirmed inventory write; the last platform observation remains dated. */}
    }
    await save(client,accountId,id,body);
  }
  async function prepare(input,client) {
    const {accountId,config}=input;
    const checkControl=()=>input.checkControl?.(client===pool?undefined:{client});
    try {
      await checkControl();
      const target=await validateTarget({accountId,config,client});
      const credential={...pinOzonCredential(await readCredential({accountId,targetStoreId:config.targetStoreId,client}),config),ownerAccountId:accountId};
      const scope={accountId,store:credential,language:"DEFAULT"};
      const preparedInput={...input,source:applyAiListingSourceCategorySnapshot(input.source)};
      let itemWarnings=[];
      const items=await prepareAiListingItems(preparedInput,target.store,{
        onWarnings:warnings=>{itemWarnings=warnings;},
        async resolveNoBrand(item){const values=await category.searchCategoryAttributeValuesExact({...scope,descriptionCategoryId:item.description_category_id,typeId:item.type_id,attributeId:85,value:"Нет бренда"});const value=values.items.length===1?values.items[0]:null;return value?{dictionary_value_id:Number(value.id),value:"Нет бренда"}:null;},
        normalizeItems:injectedNormalizeItems||(items=>normalizeOzonImportItems(items,{strictTypeMatch:true,trustSuppliedDictionaryIds:true,
          getCategoryAttributes:async(descriptionCategoryId,typeId)=>(await category.getCategoryAttributes({...scope,descriptionCategoryId,typeId})).items,
          getCategoryAttributeValues:async(descriptionCategoryId,typeId,attributeId,dictionaryOptions={})=>(await category.getCategoryAttributeValues({...scope,descriptionCategoryId,typeId,attributeId,...dictionaryOptions})).items,
          searchCategoryAttributeValuesExact:async(descriptionCategoryId,typeId,attributeId,value)=>(await category.searchCategoryAttributeValuesExact({...scope,descriptionCategoryId,typeId,attributeId,value})).items,
        })),
      });
      const preparedItems=await prepareMedia({accountId,taskId:input.taskId,items,source:input.source,checkControl,client});
      await checkControl();
      return {target,credential,items:preparedItems,itemWarnings};
    } catch(caught){if(!['AI_LISTING_TASK_CONTROL_REQUESTED','AI_LISTING_LEASE_LOST'].includes(caught.code))caught.definitelyNotSubmitted=true;throw caught;}
  }
  function retrySelection(input, body) {
    const bySku=new Map(body.results.map(result=>[result.sku,result]));
    const byOffer=new Map(body.results.map(result=>[result.offerId,result]));
    const offered=new Set(),skus=new Set();
    const items=input.source.items.filter(group=>{
      const offerId=group.listingItem?.offer_id;
      const existing=bySku.get(group.sku),offer=byOffer.get(offerId);
      if(!offerId||offered.has(offerId)||skus.has(group.sku)||(existing&&existing!==offer)||(offer&&offer.sku!==group.sku))throw error("AI_LISTING_SUBMISSION_IDENTITY_MISMATCH",true);
      offered.add(offerId);skus.add(group.sku);
      if(input.retrySkus&&!input.retrySkus.includes(group.sku))return false;
      return !existing||existing.importStatus==="FAILED"||existing.publicationStatus==="REJECTED";
    });
    const selected=new Set(items.map(group=>group.sku));
    return {...input,config:{...input.config,targetStoreId:body.config.targetStoreId,targetWarehouseId:body.config.targetWarehouseId,stock:body.config.stock},
      source:{...input.source,items},images:input.images.filter(image=>selected.has(image.sku))};
  }
  async function submitListing(input) {
    const {accountId,config,idempotencyKey}=input;
    if(input.retrySkus!==undefined&&(!Array.isArray(input.retrySkus)||!input.retrySkus.length||new Set(input.retrySkus).size!==input.retrySkus.length
      ||input.retrySkus.some(sku=>!input.source.items.some(group=>group.sku===sku))))throw error('AI_LISTING_INVALID_INPUT',true);
    const id=`ail_${createHash("sha256").update(JSON.stringify([accountId,idempotencyKey])).digest("hex")}`;
    // Media can take minutes. Prepare outside the connection-held submission lock;
    // the task lease owns this work, and the lock below still protects persistence.
    let deferredPrepared;
    if(input.deferImport&&!input.switchStore){
      const existing=await load(pool,accountId,id);
      if(!existing)deferredPrepared=await prepare(input,pool);
      else {
        if((existing.task_id&&existing.task_id!==input.taskId)||existing.body.config.targetStoreId!==config.targetStoreId)throw error("AI_LISTING_SUBMISSION_IDENTITY_MISMATCH",true);
        const previous=journal(existing.body);
        for(const result of previous.results){
          const group=input.source.items.find(group=>group.listingItem?.offer_id===result.offerId);
          if(group&&result.sku!==group.sku){
            if(result.sku!==result.offerId||!(result.importStatus==="FAILED"||result.publicationStatus==="REJECTED"||previous.attempts.some(attempt=>attempt.id==="legacy")))throw error("AI_LISTING_SUBMISSION_IDENTITY_MISMATCH",true);
            result.sku=group.sku;
          }
        }
        if(Number(input.retryAttempt||0)>Number(previous.retryAttempt||0)&&!previous.attempts.some(a=>["WAITING","IMPORTING","ACCEPTED","UNCERTAIN"].includes(a.status))){
          const selected=retrySelection(input,previous);
          if(selected.source.items.length)deferredPrepared=await prepare(selected,pool);
        }
      }
    }
    const preparedFor=async (selected,client)=>{
      if(!input.deferImport||input.switchStore)return prepare(selected,client);
      if(!deferredPrepared)throw error("AI_LISTING_SUBMISSION_BUSY",true);
      return deferredPrepared;
    };
    return locked(accountId,id,async client=>{
      let row=await load(client,accountId,id),body,credential;
      if(row){
        if(row.task_id&&row.task_id!==input.taskId)throw error("AI_LISTING_SUBMISSION_IDENTITY_MISMATCH",true);
        body=journal(row.body);
        for (const result of body.results) {
          const group=input.source.items.find(group=>group.listingItem?.offer_id===result.offerId);
          if(group&&result.sku!==group.sku){
            if(result.sku!==result.offerId||!(result.importStatus==="FAILED"||result.publicationStatus==="REJECTED"||body.attempts.some(attempt=>attempt.id==="legacy")))throw error("AI_LISTING_SUBMISSION_IDENTITY_MISMATCH",true);
            result.sku=group.sku;
          }
        }
        if(body.config.targetStoreId!==config.targetStoreId||body.config.targetWarehouseId!==config.targetWarehouseId){
          const allowed=body.allowedTargets||[{targetStoreId:body.config.targetStoreId,targetWarehouseId:body.config.targetWarehouseId},...(body.config.fallbackStores||[])];
          if(!input.switchStore||!body.config.autoSwitchStores||!storeSwitchEligible(body)||!allowed.some(t=>t.targetStoreId===config.targetStoreId&&t.targetWarehouseId===config.targetWarehouseId))throw error("AI_LISTING_SUBMISSION_IDENTITY_MISMATCH",true);
          const fresh=await prepare(input,client);
          body.previousStoreAttempts=[...(body.previousStoreAttempts||[]),{config:body.config,attempts:body.attempts,results:body.results,quotaWait:body.quotaWait,quotaCheck:body.quotaCheck,switchedAt:clock()}];
          body.allowedTargets=allowed;body.config=config;body.items=fresh.items;body.ozonTaskId=null;
          body.results=fresh.items.map((item,index)=>({sku:input.source.items[index].sku,offerId:item.offer_id,importStatus:'PENDING',stockStatus:'PENDING',errors:[],normalizationWarnings:fresh.itemWarnings.find(r=>r.offerId===item.offer_id)?.warnings||[]}));
          body.stocks=fresh.items.map(item=>({offer_id:item.offer_id,warehouse_id:Number(fresh.target.warehouse.platformWarehouseId),stock:config.stock,completed:false}));
          body.attempts=[{id:randomUUID(),status:'WAITING',offerIds:fresh.items.map(i=>i.offer_id),retryAt:0}];
          delete body.quotaWait;delete body.quotaCheck;delete body.submissionWait;delete body.recoverySkus;body.retryAt=null;body.status='PREPARED';
          await save(client,accountId,id,body);
        }
        credential=pinOzonCredential(await readCredential({accountId,targetStoreId:body.config.targetStoreId,client}),body.config);
        if(!input.deferImport)await reconcileImports(client,accountId,id,body,credential);
        if(Number(input.retryAttempt||0)>Number(body.retryAttempt||0)&&!input.retrySkus&&body.recoverySkus){
          // A later explicit all-SKU retry may continue unsent original requests;
          // IMPORTING/ACCEPTED/UNCERTAIN attempts still only reconcile above.
          delete body.recoverySkus;await save(client,accountId,id,body);
        }
        const unresolved=body.attempts.some(a=>["WAITING","IMPORTING","ACCEPTED","UNCERTAIN"].includes(a.status));
        if(Number(input.retryAttempt||0)>Number(body.retryAttempt||0)&&(!unresolved||input.retrySkus)){
          const selected=retrySelection(input,body);
          if(unresolved)selected.source.items=[];
          if(selected.source.items.length){
            const fresh=await preparedFor(selected,client);
            const groups=new Map(selected.source.items.map(group=>[group.listingItem.offer_id,group]));
            if(fresh.items.length!==groups.size||new Set(fresh.items.map(item=>item.offer_id)).size!==groups.size||fresh.items.some(item=>!groups.has(item.offer_id)))throw error("AI_LISTING_SUBMISSION_IDENTITY_MISMATCH",true);
            const failed=body.results.filter(result=>groups.has(result.offerId));
            const knownOffers=new Set(body.results.map(result=>result.offerId));
            body.items=body.items.map(old=>fresh.items.find(item=>item.offer_id===old.offer_id)||old);
            for(const result of failed){
              result.importStatus="PENDING";result.errors=[];
              result.normalizationWarnings=fresh.itemWarnings.find(row=>row.offerId===result.offerId)?.warnings||[];
              if(result.publicationStatus==="REJECTED"){
                result.previousPublicationRejectedAt=result.publicationRejectedAt;
                delete result.publicationStatus;delete result.failureReason;
              }
            }
            for(const item of fresh.items.filter(item=>!knownOffers.has(item.offer_id))){
              body.items.push(item);
              body.results.push({sku:groups.get(item.offer_id).sku,offerId:item.offer_id,importStatus:"PENDING",stockStatus:"PENDING",errors:[],
                normalizationWarnings:fresh.itemWarnings.find(row=>row.offerId===item.offer_id)?.warnings||[]});
              body.stocks.push({offer_id:item.offer_id,warehouse_id:Number(fresh.target.warehouse.platformWarehouseId),stock:body.config.stock,completed:false});
            }
            body.attempts.push({id:randomUUID(),status:"WAITING",offerIds:fresh.items.map(item=>item.offer_id),retryAt:0});
            body.status="PREPARED";
          }
          const providedSkus=new Set(input.retrySkus||input.source.items.map(group=>group.sku));
          if(input.retrySkus)body.recoverySkus=[...input.retrySkus];else delete body.recoverySkus;
          for(const result of body.results)if(providedSkus.has(result.sku)&&
            (result.stockStatus==="FAILED"||result.publicationStatus==='IMAGE_FAILED'||input.retrySkus&&result.publicationWarnings?.some(code=>imageFailureCodes.has(code)))){
            if(result.importStatus==='FAILED'||result.publicationStatus==='REJECTED'||imageRepairPending(result))continue;
            if(result.publicationStatus==='IMAGE_FAILED'||result.publicationWarnings?.some(code=>imageFailureCodes.has(code))){
              result.imageRepair={attempt:Number(input.retryAttempt),status:'WAITING'};
              delete result.stockRecovery;
              result.publicationStatus='IMAGE_REPAIR_PENDING';delete result.failureReason;
            }else if(result.errors?.includes('PRODUCT_IS_NOT_CREATED')||result.publicationStatus==='WAITING_TIMEOUT'){
              result.stockRecovery=true;
            }
            if(result.stockStatus!=='COMPLETED')result.stockStatus="PENDING";
            if(!result.waitSignature)result.errors=[];
          }
          body.retryAttempt=Number(input.retryAttempt);body.retryAt=null;
          if(body.status==='COMPLETED')body.status='STOCKING';
          await save(client,accountId,id,body);
        }
      } else {
        const prepared=await preparedFor(input,client);credential=prepared.credential;
        body={status:"PREPARED",config,items:prepared.items,ozonTaskId:null,retryAttempt:Number(input.retryAttempt||0),
          stocks:prepared.items.map(item=>({offer_id:item.offer_id,warehouse_id:Number(prepared.target.warehouse.platformWarehouseId),stock:config.stock,completed:false})),
          results:prepared.items.map((item,index)=>({sku:input.source.items[index].sku,offerId:item.offer_id,importStatus:"PENDING",stockStatus:"PENDING",errors:[],
            normalizationWarnings:prepared.itemWarnings.find(row=>row.offerId===item.offer_id)?.warnings||[]})),
          attempts:[{id:randomUUID(),status:"WAITING",offerIds:prepared.items.map(item=>item.offer_id),retryAt:0}]};
        await client.query('INSERT INTO ai_image_listing_submissions(id,account_id,task_id,idempotency_key,body) VALUES($1,$2,$3,$4,$5::jsonb)',[id,accountId,input.taskId,idempotencyKey,JSON.stringify(body)]);
      }
      if(!input.deferImport)for(const attempt of body.attempts)await sendImport(client,accountId,id,body,credential,attempt,input.beforeExternalWrite);
      return {submissionId:id};
    });
  }
  async function readSubmission({accountId,submissionId,beforeExternalWrite}) {
    return locked(accountId,submissionId,async client=>{
      const row=await load(client,accountId,submissionId);
      if(!row)throw Object.assign(error("AI_LISTING_SUBMISSION_NOT_FOUND"),{statusCode:404});
      const body=journal(row.body);
      if(body.status==="COMPLETED")return view(body);
      await validateTarget({accountId,config:body.config,validateWarehouse:false,client});
      const credential=pinOzonCredential(await readCredential({accountId,targetStoreId:body.config.targetStoreId,client}),body.config);
      await save(client,accountId,submissionId,body);
      await reconcileImports(client,accountId,submissionId,body,credential);
      for(const attempt of body.attempts)await sendImport(client,accountId,submissionId,body,credential,attempt,beforeExternalWrite);
      await writeStocks(client,accountId,submissionId,body,credential,beforeExternalWrite);
      const result=view(body);body.status=result.status==="SUBMITTED"?"STOCKING":result.status;
      await save(client,accountId,submissionId,body);
      return result;
    });
  }
  return {submitListing,readSubmission,validateTarget};
}

export async function prepareAiListingItems(input, store, { resolveNoBrand, normalizeItems, onWarnings }) {
  try {
    const { source, images, config } = input;
    const items = [];
    for (const group of source.items) {
      const item = structuredClone(group.listingItem);
      const outputs = images.filter(image => image.sku === group.sku).sort((a, b) => a.index - b.index);
      if (outputs.length !== group.images.length || !outputs.length || outputs.some((image, index) => image.index !== index || !image.generatedUrl)) {
        throw error("AI_LISTING_IMAGES_INCOMPLETE");
      }
      item.images = outputs.map(image => image.generatedUrl);
      delete item.primary_image;
      const {record,fallback,variant,evidence,pricing}=aiListingItemPrice(source,group,config,store);
      // Independent media use only the frozen own-SKU facts. Empty edits stay empty.
      for (const key of ["color_image", "videoCoverUrl", "contentDiagnostics"]) {
        if (Object.hasOwn(item, key) && item[key] !== undefined) continue;
        const original = source.sourceSnapshot || {};
        const carrier = [variant, item._sourceVariant,
          ...(String(source.sku) === String(group.sku) ? [original.listingDraft, original] : [])]
          .find(value => value && Object.hasOwn(value, key) && value[key] !== undefined);
        if (carrier) item[key] = structuredClone(carrier[key]);
      }
      // Recover full frozen media before replacing this SKU's image references.
      for (const key of ["descriptionHTML", "richContent", "rich_content"]) {
        const raw = variant[key] ?? fallback[key];
        const full = typeof raw === "string" ? raw.trim() : "";
        const current = typeof item[key] === "string" ? item[key].trim() : "";
        if (full && (item[key] === undefined || (current && full.startsWith(current)))) item[key] = full;
      }
      const rawDescription = variant.description || fallback.description;
      const fullDescription = typeof rawDescription === "string" ? rawDescription.trim() : "";
      const currentDescription = String(item.scraped_description || item.description || "").trim();
      if (item.contentDiagnostics?.description?.source !== "manual" && fullDescription && (!currentDescription || fullDescription.startsWith(currentDescription))) item.scraped_description = fullDescription;
      for (const key of ["videoUrl", "videoCover"]) {
        if (item[key] === undefined && (variant[key] ?? fallback[key]) !== undefined) item[key] = variant[key] ?? fallback[key];
      }
      for (const key of ["complex_attributes", "bundleComplexAttrs"]) {
        const raw = variant[key] || fallback[key];
        if (!item[key]?.length && Array.isArray(raw) && raw.length) item[key] = structuredClone(raw);
      }
      if (item.videos === undefined) {
        const raw = variant.videos ?? fallback.videos;
        if (Array.isArray(raw)) item.videos = structuredClone(raw);
      }
      const replacements = new Map(group.images.map((url, index) => [url, outputs[index].generatedUrl]));
      for (const carrier of [item, item._sourceVariant, item._bundleItem, item._sourceVariant?._bundleItem]) {
        if (!carrier) continue;
        for (const key of ["richContent", "rich_content"]) {
          if (carrier[key] !== undefined) carrier[key] = replaceRichImageReferences(carrier[key], replacements);
        }
        if (Array.isArray(carrier.attributes)) carrier.attributes = carrier.attributes.map(attribute =>
          Number(attribute.id || attribute.key || attribute.attribute_id) === 11254
            ? replaceRichImageReferences(attribute, replacements) : attribute);
      }
      const color = variant.aspectValues?.["Цвет"] || record.aspectValues?.["Цвет"];
      const isColor = attribute => Number(attribute.id || attribute.key || attribute.attribute_id) === 10096;
      // Structured edits (including an explicit clearing) take precedence. A
      // storefront alias such as "Серебро" must not replace a captured dictionary ID.
      if (!(item.attributes || []).some(isColor)) {
        const sourceColor = [item._sourceVariant, variant, record, item._bundleItem || item._sourceVariant?._bundleItem]
          .flatMap(carrier => carrier?.attributes || []).find(isColor);
        if (sourceColor) item.attributes = [...(item.attributes || []), structuredClone(sourceColor)];
        else if (typeof color === "string" && color.trim()) {
          item.attributes = [...(item.attributes || []), { id: 10096, complex_id: 0, values: [{ value: color.trim() }] }];
        }
      }
      item.price = decimalMoney(pricing.finalPriceKopecks);
      item.currency_code = evidence.currency;
      delete item.old_price;
      if (config.brandMode === "FORCE_NO_BRAND") {
        removeAiListingBrandText(item, record, variant, fallback);
        const value = await resolveNoBrand(item);
        if (!Number.isSafeInteger(value?.dictionary_value_id) || value.dictionary_value_id <= 0) throw error("AI_LISTING_NO_BRAND_UNRESOLVED");
        item.brand = "Нет бренда";
        item.attributes = (item.attributes || []).filter(attribute => Number(attribute.id) !== 85);
        item.attributes.push({ id: 85, complex_id: 0, values: [value] });
      }
      items.push(item);
    }
    const normalized = await normalizeItems(items);
    if (normalized.items.length !== items.length || !items.length) throw error("AI_LISTING_IMPORT_INVALID");
    onWarnings?.(normalized.itemWarnings || []);
    return normalized.items;
  } catch (caught) {
    if (caught.code === "AUTO_LISTING_SOURCE_CURRENCY_MISMATCH") throw error("AI_LISTING_CURRENCY_CONVERSION_REQUIRED", true);
    caught.definitelyNotSubmitted = true;
    throw caught;
  }
}
