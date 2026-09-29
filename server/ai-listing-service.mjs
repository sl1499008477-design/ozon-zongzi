import { createHash, randomUUID } from "node:crypto";
import { taskControlActions, taskControlGroups, taskActions, taskActionReason, finishTaskControl, resumedTaskStatus, submissionPreparing } from './ai-listing-task-controls.mjs';
import { normalizeOzonImportLogistics } from "./ozon-import-normalizer.mjs";
import {AI_LISTING_IMAGE_POLICY_VERSION,planAiListingImages} from './ai-listing-image-policy.mjs';
import {getAiGatewayDiagnostic} from './ai-gateway-port.mjs';
import {skuProgress,skippedSkus,canGenerateImage,imageResultUnknown,submissionSource,requiresPaidResult,isGenerationLeader} from './ai-listing-sku-state.mjs';

export const AI_LISTING_DEFAULT_PROMPT = "请根据这套商品图片重新生成一份适用于 ozon 的全新商品图，产品主体以及产品上的文字、logo 等信息保持不变，生成数量跟这套商品图相同，不要移除图片中既有的卖点、材质、规格型号等信息";
const LEASE_MS = 90000;
const POLL_MS = 15000;
const COLLECT_POLL_MS = 30000;
const transientImageErrors = new Set(["AI_GATEWAY_UNEXPECTED_EOF", "AI_GATEWAY_STREAM_TIMEOUT", "AI_GATEWAY_RATE_LIMITED", "RETRYABLE_GATEWAY"]);
const unavailableImageErrors = new Set(["AI_LISTING_CHANNEL_UNAVAILABLE","AI_LISTING_MODEL_UNAVAILABLE", "AI_GATEWAY_MODEL_UNAVAILABLE", "AI_GATEWAY_NO_CAPACITY", "AI_GATEWAY_QUOTA_EXHAUSTED", "NON_RETRYABLE_AUTH", "AI_LISTING_PROFILE_REQUIRED", "AI_LISTING_PUBLICATION_REQUIRED"]);
const failureStates = new Set(["COLLECTION_FAILED", "GENERATION_FAILED", "UPLOAD_FAILED", "SUBMISSION_FAILED", "SUBMISSION_UNCERTAIN"]);
const submissionStarted = new Set(["SUBMITTING", "SUBMITTED", "COMPLETED", "SUBMISSION_UNCERTAIN", "SUBMISSION_FAILED"]);
const lostLease = Object.assign(new Error('AI task lease lost'),{code:'AI_LISTING_LEASE_LOST'});
const controlStopped = Object.assign(new Error('AI task control completed'),{code:'AI_LISTING_TASK_CONTROL_REQUESTED',deliveryState:'NOT_SENT'});
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const problem = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const invalid = () => problem("AI_LISTING_INVALID_INPUT", "AI 上架参数无效");
function canRestartChannelRound(image) {
  return image.channelAttempts?.length && image.channelAttempts.every(attempt=>attempt.deliveryState==='NOT_SENT'
    // Legacy records predate this field. The adapter's 429 code exclusively means NOT_SENT.
    || !attempt.deliveryState && attempt.code==='AI_GATEWAY_RATE_LIMITED');
}
function identifier(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\u0000-\u001f]/u.test(value)) throw invalid();
  return value.trim();
}
function option(value, fallback) {
  const result = value ?? fallback;
  if (typeof result !== "string" || !result.trim() || result.length > 100) throw invalid();
  return result.trim();
}

// This is the incoming configuration boundary. Stored configurations are not revalidated.
export function normalizeAiListingConfig(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid();
  const generationMode = raw.generationMode ?? "SINGLE";
  if (!["SINGLE", "GRID"].includes(generationMode)) throw invalid();
  const stock = raw.stock ?? 5;
  const priceAdjustmentKopecks = raw.priceAdjustmentKopecks ?? 0;
  const priceMultiplier = raw.priceMultiplier ?? "1";
  const brandMode = raw.brandMode ?? "FORCE_NO_BRAND";
  const manualReview = raw.manualReview ?? false;
  const prompt = raw.prompt ?? AI_LISTING_DEFAULT_PROMPT;
  if (!Number.isSafeInteger(stock) || stock < 0 || !Number.isSafeInteger(priceAdjustmentKopecks)
    || typeof priceMultiplier !== "string" || priceMultiplier.length > 100
    || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(priceMultiplier) || !/[1-9]/.test(priceMultiplier)
    || !["FORCE_NO_BRAND", "PREFER_SOURCE"].includes(brandMode) || typeof manualReview !== "boolean"
    || typeof prompt !== "string" || !prompt.trim() || prompt.length > 20000) throw invalid();
  const autoSwitchStores = raw.autoSwitchStores ?? false;
  if(typeof autoSwitchStores!=="boolean")throw invalid();
  const fallbackStores=autoSwitchStores ? raw.fallbackStores : [];
  if(!Array.isArray(fallbackStores)||fallbackStores.length>20||(autoSwitchStores&&!fallbackStores.length))throw invalid();
  const routes=fallbackStores.map(row=>({targetStoreId:identifier(row.targetStoreId),targetWarehouseId:identifier(row.targetWarehouseId)}));
  if(new Set([raw.targetStoreId,...routes.map(row=>row.targetStoreId)]).size!==routes.length+1)throw invalid();
  return { ...(autoSwitchStores?{autoSwitchStores:true,fallbackStores:routes}:{}), targetStoreId: identifier(raw.targetStoreId), targetWarehouseId: identifier(raw.targetWarehouseId), stock,
    ...(raw.salePricingId ? {salePricingId:identifier(raw.salePricingId)} : {}),
    ...(raw.salePricingUpdatedAt ? {salePricingUpdatedAt:identifier(raw.salePricingUpdatedAt)} : {}),
    ...(raw.salePricing ? {salePricing:structuredClone(raw.salePricing)} : {}),
    priceAdjustmentKopecks, priceMultiplier, brandMode, manualReview, generationMode,
    image: { ratio: generationMode === "GRID" ? "3:4" : option(raw.image?.ratio, "3:4"), language: option(raw.image?.language, "ru"),
      resolution: generationMode === "GRID" ? "1K" : option(raw.image?.resolution, "2K"), quality: option(raw.image?.quality, "high") }, prompt };
}
function listingConfig(config) {
  const { prompt, image, generationMode, ...local } = config;
  return local;
}
function listingModelName(item) {
  return String(item?.scraped_model_name || item?.model_name
    || item?.attributes?.find(attribute=>Number(attribute.id || attribute.key)===9048)?.values?.[0]?.value || '').trim();
}
function applyCollectorModel(source,modelName) {
  if(!modelName)return;
  for(const {listingItem:item} of source.items){
    const current=listingModelName(item);
    // A source-SKU fallback is automatic. A separately edited model is not.
    if(!current || current===String(source.sku))item.scraped_model_name=modelName;
  }
}
function revisionItems(task) {
  if (task.status !== 'SUBMISSION_FAILED' || !task.source?.items?.length) return [];
  const results=task.submissionResults || [];
  // A failed sibling cannot authorize changing the payload of an unresolved request.
  if (results.some(row=>['PENDING','UNCERTAIN','IMPORTING','ACCEPTED'].includes(row.importStatus))) return [];
  const eligible=new Set(results.filter(row=>row.importStatus==='FAILED'||row.publicationStatus==='REJECTED').map(row=>row.sku));
  return task.source.items.filter(item=>eligible.has(item.sku)||!task.submissionId);
}
function submissionRevisions(task) {
  return revisionItems(task).map(({sku,listingItem:item})=>{
    const raw=item.richContent ?? item.rich_content ?? item.attributes?.find(a=>Number(a.id)===11254)?.values?.[0]?.value;
    let richContent=null;try{richContent=typeof raw==='string'&&raw.trim()?JSON.parse(raw):raw||null;}catch{richContent=null;}
    return {sku,name:item.name || '',modelName:listingModelName(item),description:item.description ?? item.scraped_description ?? '',richContent};
  });
}
function applyRevisions(task,revisions) {
  if (!Array.isArray(revisions)||!revisions.length||revisions.length>100||new Set(revisions.map(row=>row?.sku)).size!==revisions.length) throw invalid();
  const eligible=new Map(revisionItems(task).map(item=>[item.sku,item]));
  for(const revision of revisions) {
    if (!revision || typeof revision!=='object' || Array.isArray(revision) || Object.keys(revision).some(key=>!['sku','name','modelName','description','richContent'].includes(key))) throw invalid();
    const group=eligible.get(revision.sku);if(!group)throw problem('AI_LISTING_REVISION_CONFLICT','仅可修订当前任务中已确认上架失败的 SKU；结果待核实或成功商品不能修改',409);
    if(!['name','modelName','description','richContent'].some(key=>Object.hasOwn(revision,key)))throw invalid();
    if(Object.hasOwn(revision,'name')&&(typeof revision.name!=='string'||!revision.name.trim()||revision.name.length>1000))throw invalid();
    if(Object.hasOwn(revision,'description')&&(typeof revision.description!=='string'||revision.description.length>20000))throw invalid();
    if(Object.hasOwn(revision,'richContent')&&(revision.richContent!==null&&(typeof revision.richContent!=='object'||Array.isArray(revision.richContent))||JSON.stringify(revision.richContent).length>250000))throw invalid();
    const item=group.listingItem;
    const replaceAttribute=(id,value)=>{item.attributes=(item.attributes||[]).filter(attr=>Number(attr.id || attr.key || attr.attribute_id)!==id);if(value)item.attributes.push({id,complex_id:0,values:[{value}]});};
    if(Object.hasOwn(revision,'name')){item.name=revision.name.trim();replaceAttribute(4180,item.name);}
    if(Object.hasOwn(revision,'modelName')){
      if(!(task.submissionResults||[]).some(result=>result.sku===revision.sku&&(result.importStatus==='FAILED'||result.publicationStatus==='REJECTED')))
        throw problem('AI_LISTING_REVISION_CONFLICT','仅可更改已确认被拒绝 SKU 的型号分组',409);
      item.scraped_model_name=identifier(revision.modelName);replaceAttribute(9048,item.scraped_model_name);
    }
    if(Object.hasOwn(revision,'description')){item.description=revision.description;item.scraped_description=revision.description;
      item.contentDiagnostics={...item.contentDiagnostics,description:{...item.contentDiagnostics?.description,source:'manual',status:revision.description.trim()?'provided':'empty'}};}
    if(Object.hasOwn(revision,'richContent')){const value=revision.richContent===null?'':JSON.stringify(revision.richContent);item.richContent=value;item.rich_content=value;replaceAttribute(11254,value);
      item.contentDiagnostics={...item.contentDiagnostics,richContent:{...item.contentDiagnostics?.richContent,source:'manual',status:value?'provided':'empty'}};}
  }
}
function dto(task, {detail=false}={}) {
  const skipped=new Set((task.source?.skuPricing||[]).filter(row=>row.status==='SKIPPED').map(row=>row.sku));
  const eligible=[...new Map((task.source?.items||[]).filter(row=>!skipped.has(row.sku)).map(row=>[row.sku,row])).values()];
  const created=new Set((task.submissionResults||[]).filter(row=>row.importStatus==='SUCCEEDED'||row.isCreated===true||/^[1-9]\d*$/.test(String(row.productId||''))).map(row=>row.sku));
  return { id: task.id, version: task.version, taskActions: taskActions(task), controlAction: task.controlAction || null,
    deletedAt: task.deletedAt || null,
    ...(task.purge ? {purge: {state:task.purge.state,requestedAt:task.purge.requestedAt, ...(task.purge.errorMessage?{errorMessage:task.purge.errorMessage}:{}), retainedObjects:task.purge.retainedObjects||0,retainedSources:task.purge.retainedSources||0}} : {}),
    sourceType: task.sourceType, ...(task.sourceType === "COLLECT_BOX" ? {collectItemId:task.sourceId} : {}), sku: task.sku, name: task.name, thumbnail: task.thumbnail,
    ...(task.importBatchId ? { importBatchId: task.importBatchId, importSkus: task.importSkus || [task.sourceId],
      importRows: structuredClone(task.importRows || []) } : {}),
    ...(task.submissionStage ? {submissionStage:task.submissionStage} : {}),
    ...(task.generationStage ? {generationStage:task.generationStage} : {}),
    ...(task.collectionStage ? {collectionStage:task.collectionStage} : {}),
    config: structuredClone(task.config), ...(task.submissionTarget?{submissionTarget:structuredClone(task.submissionTarget)}:{}), status: task.status,
    ...(task.imagePlan?{imagePlan:{version:task.imagePlan.version,requestCount:task.imagePlan.requestCount,
      ...(detail?{items:structuredClone(task.imagePlan.items)}:{})}}:{}),
    skuProgress:skuProgress(task),
    images: task.images.map(({ sku, index, sourceUrl, generatedUrl, previewUrl, status,errorMessage,lastError,paidResultRetained }) => ({ sku, index, sourceUrl, generatedUrl,
      ...(previewUrl ? {previewUrl} : {}), status,...(detail&&errorMessage?{errorMessage}:{}),
      ...(detail&&lastError?.diagnostic?{lastError:{code:lastError.code,diagnostic:lastError.diagnostic}}:{}),
      ...(detail&&paidResultRetained?{paidResultRetained:true}: {}) })),
    createdAt: new Date(task.createdAt).toISOString(), updatedAt: new Date(task.updatedAt).toISOString(),
    ...(task.submissionResults ? { submissionResults: structuredClone(task.submissionResults) } : {}),
    ...(task.priceFailure ? {priceFailure:structuredClone(task.priceFailure)} : {}),
    ...(task.quotaWait ? {quotaWait:structuredClone(task.quotaWait)} : {}),
    ...(task.submissionWait ? {submissionWait:structuredClone(task.submissionWait)} : {}),
    createdSkuCount:eligible.filter(row=>created.has(row.sku)).length,totalSkuCount:eligible.length,
    ...(detail&&task.mediaStage?{mediaStage:task.mediaStage}:{}),
    ...(detail&&task.mediaDiagnostics?{mediaDiagnostics:structuredClone(task.mediaDiagnostics)}:{}),
    ...(detail && task.status==='SUBMISSION_FAILED' ? {submissionRevisions:submissionRevisions(task)} : {}),
    errorMessage: task.errorMessage, submissionId: task.submissionId };
}
function validateSourceItems(source, requireImages = true) {
  // Only the fields required for this operation are checked, not historical listing metadata.
  if (!source || !Array.isArray(source.items) || !source.items.length
    || source.items.some(item => !item.sku || (requireImages && (!Array.isArray(item.images) || !item.images.length)))
    || new Set(source.items.map(item => item.sku)).size !== source.items.length) throw invalid();
  if (source.items.length > 100) throw problem("AI_LISTING_SKU_LIMIT", "每个任务最多 100 个 SKU，请分批选择后创建", 422);
}
function applySource(task, source) {
  validateSourceItems(source);
  // Commit the frozen source only after preparation succeeds, including on worker retries.
  const prepared = structuredClone(source);
  prepareSourceLogistics(prepared);
  if (task.config.generationMode === "GRID") {
    for (const item of prepared.items) item.images = item.images.slice(0, 12);
  }
  task.source = prepared;
  task.sku = source.sku || source.items[0].sku;
  task.name = source.name || task.sku;
  task.thumbnail = source.thumbnail || source.items[0].images[0];
  task.images = task.source.items.flatMap(item => item.images.map((sourceUrl, index) => ({
    sku: item.sku, index, sourceUrl, generatedUrl: null, status: "PENDING",
    requestKey: `ai-image-${digest([task.id, item.sku, index])}`,
  })));
}

function collectEnrichmentPending(source, initialSource = null) {
  const jobs = new Map((source.enrichmentJobs || []).map(job => [job.sku, job.status]));
  const required = new Set((initialSource?.enrichmentJobs || []).map(job => job.sku));
  let pending = false;
  for (const item of source.items) {
    const status = jobs.get(item.sku);
    // Failed history does not invalidate a manually repaired new source; an admitted wait still reports job failure.
    if (initialSource && ((!status && required.has(item.sku)) || (status && !["PENDING", "PROCESSING", "SUCCESS"].includes(status)))) {
      throw problem("AI_LISTING_ENRICHMENT_FAILED", "Seller 资料补全失败或补全任务已不存在，请在采集箱处理后重试", 409);
    }
    // PROCESSING is the enrichment queue's running state; summaries alone cannot admit waiting.
    if (status === "PENDING" || status === "PROCESSING") pending = true;
  }
  return pending;
}

function taskIdentity({ accountId, idempotencyKey, config, selectedSkus }, sourceType, sourceId) {
  const dedupeKey = digest([accountId, sourceType, idempotencyKey, sourceId]);
  return { id: `ai-listing-${dedupeKey}`, dedupeKey, requestHash: digest(selectedSkus ? { config, selectedSkus } : config) };
}
function assertSameRequest(task, requestHash) {
  if (task.permanentlyDeletedAt || task.purge) throw problem("AI_LISTING_TASK_PERMANENTLY_DELETED", "原任务已开始永久清理，请重新采集后创建新任务", 409);
  if (task.requestHash !== requestHash) throw problem("AI_LISTING_IDEMPOTENCY_CONFLICT", "相同请求标识的配置不能更改", 409);
}

function prepareSourceLogistics(source) {
  for (const group of source.items) {
    try { Object.assign(group.listingItem, normalizeOzonImportLogistics(group.listingItem)); }
    catch (error) { error.code = "AI_LISTING_LOGISTICS_REQUIRED"; throw error; }
  }
}

export function createAiListingService({ repository, loadSources, collectSku, generateImage, generateImageGroup, acknowledgeGeneratedResult, reserveChannel, submitListing, readSubmission, routeStores, billing, checkSource, readOzonRoute, imagePolicyVersion, clock = Date.now }) {
  const now = () => Number(clock());
  async function find(input, {includeDeleted=false}={}) {
    const accountId = identifier(input.accountId); const taskId = identifier(input.taskId);
    const task = await repository.get({ accountId, taskId });
    if (!task || task.permanentlyDeletedAt || task.deletedAt && !includeDeleted) throw problem("AI_LISTING_TASK_NOT_FOUND", "任务不存在或已删除", 404);
    if (task.status === "MERGED") {
      const canonical = await repository.get({ accountId, taskId: task.mergedTaskId });
      if (!canonical || canonical.deletedAt || canonical.status === "MERGED" || canonical.importBatchId !== task.importBatchId) throw problem("AI_LISTING_TASK_NOT_FOUND", "任务不存在", 404);
      return canonical;
    }
    return task;
  }
  async function groupImport(task) {
    if (!task.importBatchId || !repository.finalizeImportBatch) return;
    await repository.finalizeImportBatch({accountId:task.accountId,importBatchId:task.importBatchId,now:now(),merge:mergeImportRows});
  }
  function mergeImportRows(rows) {
    const changed = new Map();
    const groups = new Map();
    for (const row of rows) {
      if (!row.source || row.deletedAt || row.controlAction || ['MERGED','PAUSED','CANCELLED','COLLECTION_FAILED'].includes(row.status)) continue;
      // Unconfirmed identities stay independent. Configuration is part of the grouping boundary.
      const key = digest([row.source.collectItemId || row.id, row.requestHash]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    for (const group of groups.values()) {
      const fresh = group.filter(row=>!row.importGrouped);
      if (!fresh.length) continue;
      // A previously finalized product owns its original ID and successes, even when an earlier failed row retries.
      const canonical = group.find(row=>row.importGrouped) || group[0];
      if (canonical.leaseToken && canonical.leaseExpiresAt > now()) continue;
      const started = canonical.importGrouped && (canonical.images.some(image=>image.generatedUrl || image.attempts) || canonical.submissionStarted || !['QUEUED','GENERATING'].includes(canonical.status));
      const items = new Map(canonical.source.items.map(item=>[item.sku, structuredClone(item)]));
      const accepted = [];
      for (const row of fresh) {
        if (row.id === canonical.id) { accepted.push(row); continue; }
        if (started && row.resumedAfterStop && row.source.items.every(item=>!items.has(item.sku))) {
          // The sibling product already started while this Excel row was stopped.
          // Resume only this row's disjoint SKU selection under its original task ID.
          row.importGrouped=true;row.generationStage='queued';row.nextRunAt=now();row.updatedAt=now();
          delete row.resumedAfterStop;changed.set(row.id,row);continue;
        }
        const tooManyGridImages=canonical.config.generationMode==='GRID'&&row.source.items.some(item=>{const existing=items.get(item.sku);return existing&&new Set([...existing.images,...item.images]).size>12;});
        const incompatible = tooManyGridImages || new Set([...items.keys(), ...row.source.items.map(item=>item.sku)]).size > 100 || row.source.items.some(item=>{
          const existing=items.get(item.sku);
          return started ? !existing || digest(existing.listingItem)!==digest(item.listingItem) || item.images.some(url=>!existing.images.includes(url))
            : existing && digest(existing.listingItem)!==digest(item.listingItem);
        });
        if (incompatible) {
          row.status='COLLECTION_FAILED';row.errorMessage=tooManyGridImages?'同商品合并后单 SKU 超过 12 张拼图上限，请在采集箱统一选图后重新创建任务':'同商品来源 SKU 资料不一致或已有商品开始生成，请核对来源后重试';row.importGrouped=true;
          changed.set(row.id,row);continue;
        }
        if (!started) for(const item of row.source.items) {
          const existing=items.get(item.sku);
          if(existing)existing.images=[...new Set([...existing.images,...item.images])];else items.set(item.sku,structuredClone(item));
        }
        accepted.push(row);
      }
      if (!accepted.length) continue;
      if (!started) {applySource(canonical,{...canonical.source,items:[...items.values()]});canonical.generationStage='queued';}
      const mappings=new Map((canonical.importRows || []).map(row=>[row.row,row]));
      for(const row of accepted) for(const mapping of row.importRows || []) mappings.set(mapping.row,{...mapping,taskId:canonical.id});
      canonical.importRows=[...mappings.values()].sort((a,b)=>a.row-b.row);
      canonical.importSkus=[...new Set(canonical.importRows.map(row=>row.sku))];
      canonical.importGrouped=true;delete canonical.resumedAfterStop;canonical.nextRunAt=now();canonical.updatedAt=now();changed.set(canonical.id,canonical);
      for(const row of accepted) if(row.id!==canonical.id) {
        row.status='MERGED';row.mergedTaskId=canonical.id;row.importGrouped=true;row.updatedAt=now();changed.set(row.id,row);
      }
    }
    return [...changed.values()];
  }
  async function actionSave(task, requeue = false) {
    task.updatedAt = now();
    const saved = await repository.save({ task, expectedVersion: task.version, now: now(), releaseLease: true, requeue, guardControl:true });
    if (!saved) throw problem("AI_LISTING_TASK_CONFLICT", "任务状态已变化，请刷新后重试", 409);
    if ((!task.collectWait || task.source) && (!task.importBatchId || task.importGrouped)) await billing?.reconcile({accountId:task.accountId,taskId:task.id});
    await groupImport(saved);
    return dto(await find({accountId:saved.accountId,taskId:saved.id}));
  }
  function checkAction(task, input, action) {
    if (input.expectedVersion != null && (task.id!==input.taskId.trim() || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion !== task.version)) {
      throw problem('AI_LISTING_TASK_CONFLICT','任务状态已变化，请刷新后重试',409);
    }
    const reason = taskActionReason(task, action);
    if (reason) throw problem('AI_LISTING_TASK_CONFLICT',reason,409);
  }
  async function stopTask(input, action) {
    const task = await find(input);
    if (input.expectedVersion == null && ((action==='cancel' && task.status==='CANCELLED') || task.controlAction===action)) return dto(task);
    checkAction(task,input,action);
    const saved = await repository.requestControl({task:finishTaskControl(task,action,now()),action,expectedVersion:task.version,now:now()});
    if (!saved) throw problem('AI_LISTING_TASK_CONFLICT','任务状态已变化，请刷新后重试',409);
    if (!saved.controlAction && (!saved.collectWait || saved.source) && (!saved.importBatchId || saved.importGrouped)) {
      await billing?.reconcile({accountId:saved.accountId,taskId:saved.id});
    }
    return dto(saved);
  }
  function request(input) {
    return { accountId: identifier(input.accountId), idempotencyKey: identifier(input.idempotencyKey), config: normalizeAiListingConfig(input.config) };
  }
  async function createTask({ accountId, idempotencyKey, config, selectedSkus }, sourceType, sourceId, source, metadata, deferSave = false) {
    const identity = taskIdentity({ accountId, idempotencyKey, config, selectedSkus }, sourceType, sourceId);
    const { id } = identity; const timestamp = now();
    const task = { ...identity, ...metadata, accountId, sourceType, sourceId, mediaJournalVersion:1,
      ...(imagePolicyVersion===AI_LISTING_IMAGE_POLICY_VERSION?{imagePolicyVersion}:{}),
      sku: sourceType === "EXCEL" ? sourceId : "", name: "", thumbnail: "", source: null, config,
      status: "QUEUED", images: [], approved: false, errorMessage: null, submissionId: null, submissionStarted: false,
      submissionKey: `ai-listing-submit-${digest([accountId, id])}`, createdAt: timestamp, updatedAt: timestamp, nextRunAt: timestamp };
    // Automatic handoff must observe collection failures; only explicit manual
    // creation can accept a repaired source with historical failed enrichment.
    if (source && sourceType === "COLLECT_BOX" && collectEnrichmentPending(source, metadata?.collectorAuto ? source : null)) {
      validateSourceItems(source, false);
      task.collectWait = { selectedSkus: source.items.map(item => item.sku), initialSource: structuredClone(source) };
      task.sku = source.sku || source.items[0].sku; task.name = source.name || task.sku;
      task.thumbnail = source.thumbnail || source.items[0].images?.[0] || "";
      task.status = "COLLECTING";
    } else if (source) applySource(task, source);
    if (deferSave) return task;
    const saved = await repository.create(task);
    assertSameRequest(saved, task.requestHash);
    return dto(saved);
  }
  const service = {
    async createFromCollectorRun(input, { beforeCreate } = {}) {
      const accountId = identifier(input.accountId), runId = identifier(input.runId);
      // Group membership is resolved by the collector's account/run boundary, never the caller's SKU list.
      const groups = input.groups.map(group => ({ ...group, skus: [...new Set(group.skus)].sort(),
        sources: group.sources || [{collectItemId:group.collectItemId,skus:group.skus}] }));
      const skus = [...new Set(groups.flatMap(group => group.skus))].sort();
      const existing = await repository.readCollectorAutomaticOwners({ accountId, skus });
      const neededSourceIds = [...new Set(groups.flatMap(group => group.sources
        .filter(source => source.skus.some(sku => !existing.has(sku))).map(source => source.collectItemId)))];
      const sourceErrors = new Map(), skuErrors = new Map();
      let config, sources = [];
      if (neededSourceIds.length) {
        config = normalizeAiListingConfig(beforeCreate ? await beforeCreate(input.config) : input.config);
        // Several old, independently edited drafts may belong to one captured product. The category
        // read boundary accepts at most 500 source IDs; do not combine these drafts or truncate them.
        for (let offset = 0; offset < neededSourceIds.length; offset += 500) sources.push(...await loadSources({ accountId, collectItemIds: neededSourceIds.slice(offset, offset + 500),
          config: listingConfig(config), excludeSubmittedSkus: true, onSourceError: ({ collectItemId, error }) => {
            if (!['AI_LISTING_LOGISTICS_REQUIRED','ZONGZI_IMPORT_LOGISTICS_REQUIRED','AI_LISTING_SKU_LIMIT','AI_LISTING_INVALID_INPUT','AI_LISTING_ALREADY_LISTED','AI_LISTING_SELECTION_CHANGED'].includes(error?.code)) throw error;
            sourceErrors.set(collectItemId, error);
          } }));
      }
      const byId = new Map(sources.map(source => [source.collectItemId, source]));
      const { owners, createdTaskIds } = await repository.createCollectorAutomatic({ accountId, skus, prepare: async (missingSkus, lockedOwners = existing) => {
        const groupModels=new Map(groups.filter(group=>group.groupId).map(group=>{
          const previous=[...new Set(group.skus.map(sku=>lockedOwners.get(sku)).filter(task=>task && (!task.collectorAuto?.groupId || task.collectorAuto.groupId===group.groupId)
            && (task.submissionTarget?.targetStoreId || task.config?.targetStoreId)===config?.targetStoreId))]
            .sort((a,b)=>Number(b.sourceId===group.collectItemId)-Number(a.sourceId===group.collectItemId)||a.createdAt-b.createdAt||a.id.localeCompare(b.id));
          const prior=previous.map(task=>task.collectorAuto?.modelName || listingModelName((task.source || task.collectWait?.initialSource)?.items?.[0]?.listingItem)).find(Boolean);
          const primary=byId.get(group.collectItemId);
          return [group.groupId,prior || listingModelName(primary?.items?.[0]?.listingItem) || primary?.sku || group.groupId];
        }));
        const missing = new Set(missingSkus), tasks = [];
        for (const group of groups) for (const origin of group.sources) {
          const requested = origin.skus.filter(sku => missing.has(sku));
          if (!requested.length) continue;
          try {
            if (sourceErrors.has(origin.collectItemId)) throw sourceErrors.get(origin.collectItemId);
            const source = byId.get(origin.collectItemId);
            if (!source) throw problem('AI_LISTING_SOURCE_NOT_FOUND', '采集商品不存在或不属于当前账号', 404);
            if (!['ozon','auto_listing_excel_sku'].includes(String(source.sourceSnapshot?.source || '').toLowerCase())) {
              throw problem('AI_LISTING_SOURCE_PLATFORM_MISMATCH', '自动采集生图仅接受 Ozon 来源商品', 422);
            }
            const available = new Set(source.items.map(item => item.sku));
            const selected = requested.filter(sku => available.has(sku)), excluded = requested.filter(sku => !available.has(sku));
            if (excluded.length) {
              const error = problem('AI_LISTING_SELECTION_CHANGED',
                `SKU ${excluded.slice(0,20).join('、')}${excluded.length > 20 ? ' 等' : ''} 已上架或已从当前草稿移除，未自动重新生成`, 422);
              for (const sku of excluded) skuErrors.set(sku, error);
            }
            if (!selected.length) continue;
            const prepared = [];
            for (let offset = 0; offset < selected.length; offset += 100) {
              const chunk = selected.slice(offset, offset + 100);
              const subset = structuredClone({ ...source, items: source.items.filter(item => chunk.includes(item.sku)) });
              // Independent drafts retain their own media and facts, but a known
              // collector family must not become several models just because its
              // source SKUs were saved in separate drafts.
              const modelName=groupModels.get(group.groupId);applyCollectorModel(subset,modelName);
              subset.thumbnail = subset.items[0]?.images?.[0] || '';
              prepared.push(await createTask({ accountId, config, selectedSkus: chunk,
                idempotencyKey: `collector-auto-${runId}-${digest(chunk)}` }, 'COLLECT_BOX', origin.collectItemId, subset,
              { collectorAuto: { runId, groupId: group.groupId, skus: chunk,...(modelName?{modelName}:{}) } }, true));
            }
            tasks.push(...prepared);
            for (const sku of selected) missing.delete(sku);
          } catch (error) {
            if (!['AI_LISTING_SOURCE_NOT_FOUND','AI_LISTING_SOURCE_PLATFORM_MISMATCH','AI_LISTING_LOGISTICS_REQUIRED','ZONGZI_IMPORT_LOGISTICS_REQUIRED','AI_LISTING_SKU_LIMIT','AI_LISTING_INVALID_INPUT','AI_LISTING_ALREADY_LISTED','AI_LISTING_SELECTION_CHANGED','AI_LISTING_ENRICHMENT_FAILED'].includes(error?.code)) throw error;
            for (const sku of requested) skuErrors.set(sku, error);
          }
        }
        return tasks;
      } });
      const created = new Set(createdTaskIds), allTasks = new Map(), errors = [];
      const results = groups.map(group => {
        const blocked=group.skus.filter(sku=>owners.get(sku)?.deletedAt || owners.get(sku)?.status==='MERGED');
        const tasks = new Map(group.skus.flatMap(sku => owners.has(sku)&&!blocked.includes(sku) ? [[owners.get(sku).id, owners.get(sku)]] : []));
        for (const [id, task] of tasks) allTasks.set(id, task);
        const missingSkus = group.skus.filter(sku => !owners.has(sku));
        const unprocessedSkus=group.skus.filter(sku=>missingSkus.includes(sku)||blocked.includes(sku));
        if(blocked.length)errors.push({collectItemId:group.collectItemId,skus:blocked,definitelyNotCreated:true,retryable:false,
          code:'AI_LISTING_DELETED_TASK_BLOCKED',message:blocked.some(sku=>owners.get(sku)?.purge)?'这些 SKU 的原任务已开始永久清理，不能重放；请重新采集并核对已上架商品后创建新任务':'这些 SKU 由已删除或不可访问的历史 AI 任务保护，未继续处理；请到任务中心“已删除”分组恢复原任务，再核对后继续或重试',
          blockedTaskIds:[...new Set(blocked.map(sku=>owners.get(sku).id))]});
        if (missingSkus.length) {
          const causes = missingSkus.map(sku => skuErrors.get(sku)).filter(Boolean), error = causes[0];
          errors.push({ collectItemId: group.collectItemId, skus: missingSkus, definitelyNotCreated: true,
            code: error?.code || 'AI_LISTING_SOURCE_NOT_FOUND',
            message: [...new Set(causes.map(cause => cause.code === 'AI_LISTING_INVALID_INPUT'
              ? '新增 SKU 缺少可用图片，请补全资料后重试' : cause.message))].join('；') || '新增 SKU 来源不存在，请在采集箱核对后重试' });
        }
        const taskIds = [...tasks.keys()];
        return { collectItemId: group.collectItemId, taskIds, createdTaskIds: taskIds.filter(id => created.has(id)),
          reusedTaskIds: taskIds.filter(id => !created.has(id)), unprocessedSkus };
      });
      return { results, tasks: [...allTasks.values()].map(dto), errors };
    },
    async createFromCollect(input, {onSourceError} = {}) {
      const req = request(input);
      if (!Array.isArray(input.collectItemIds) || !input.collectItemIds.length) throw invalid();
      const collectItemIds = [...new Set(input.collectItemIds.map(identifier))];
      const requests = collectItemIds.map(id => {
        const selectedSkus = input.selectedSkus?.[id];
        if (selectedSkus !== undefined && (!Array.isArray(selectedSkus) || !selectedSkus.length
          || selectedSkus.some(sku => typeof sku !== "string" || !sku))) throw invalid();
        return { sourceId: id, selectedSkus, ...taskIdentity({ ...req, selectedSkus }, "COLLECT_BOX", id) };
      });
      // Replays of frozen historical tasks must not depend on the collect row still existing.
      const existing = new Map((await repository.getMany({ accountId: req.accountId, taskIds: requests.map(row => row.id) }))
        .map(task => [task.id, task]));
      for (const row of requests) if (existing.has(row.id)) assertSameRequest(existing.get(row.id), row.requestHash);
      const missingIds = requests.filter(row => !existing.has(row.id)).map(row => row.sourceId);
      const rejected = new Set();
      const rejectSource = ({collectItemId,error}) => {
        if(!onSourceError || !['AI_LISTING_LOGISTICS_REQUIRED','ZONGZI_IMPORT_LOGISTICS_REQUIRED','AI_LISTING_SKU_LIMIT','AI_LISTING_INVALID_INPUT','AI_LISTING_ALREADY_LISTED','AI_LISTING_SELECTION_CHANGED'].includes(error?.code))throw error;
        rejected.add(collectItemId);
        onSourceError({collectItemId,code:error.code,definitelyNotCreated:true,...(['AI_LISTING_ALREADY_LISTED','AI_LISTING_SELECTION_CHANGED'].includes(error.code)?{retryable:false}:{}),
          message:error.code==='AI_LISTING_INVALID_INPUT'?'商品来源缺少可用 SKU 或图片，请补全资料后重试':error.code==='ZONGZI_IMPORT_LOGISTICS_REQUIRED'?'商品包装重量或尺寸不完整，请补全资料后重试':error.message});
      };
      const sources = missingIds.length
        ? await loadSources({ accountId: req.accountId, collectItemIds: missingIds, config: listingConfig(req.config),...(onSourceError?{onSourceError:rejectSource}:{}) }) : [];
      const byId = new Map(sources.map(source => [source.collectItemId, source]));
      if (missingIds.some(id => !byId.has(id)&&!rejected.has(id))) throw problem("AI_LISTING_SOURCE_NOT_FOUND", "采集商品不存在或不属于当前账号", 404);
      const tasks = [];
      for (const row of requests) {
        if (existing.has(row.id)) { tasks.push(dto(existing.get(row.id))); continue; }
        const id = row.sourceId;if(rejected.has(id))continue;
        const source = structuredClone(byId.get(id));
        const selected = row.selectedSkus;
        let prepared;
        try {
          if (selected !== undefined) {
            if (selected.some(sku => !source.items.some(item => item.sku === sku))) throw problem('AI_LISTING_SELECTION_CHANGED','选中的 SKU 已上架或来源已变化，请刷新采集箱后重新选择',422);
            source.items=source.items.filter(item=>selected.includes(item.sku));
            source.thumbnail=source.items[0]?.images?.[0] || "";
          }
          prepared=await createTask({...req,selectedSkus:selected}, "COLLECT_BOX", id, source,undefined,true);
        }catch(error){rejectSource({collectItemId:id,error});continue;}
        // Unknown writes and identity conflicts must never be reported as definitely not created.
        const saved=await repository.create(prepared);assertSameRequest(saved,prepared.requestHash);tasks.push(dto(saved));
      }
      return tasks;
    },
    async createFromSkus(input) {
      const req = request(input);
      if (!Array.isArray(input.skus) || !input.skus.length) throw invalid();
      const skus=input.skus.map(identifier);
      const importBatchId=digest([req.accountId,'EXCEL',req.idempotencyKey]);
      const importRequestHash=digest([req.config,skus]);
      const tasks=[];
      for(const sku of new Set(skus)) {
        const id=taskIdentity(req,'EXCEL',sku).id;
        const importRows=skus.flatMap((value,index)=>value===sku?[{row:index+1,sku,taskId:id,originalTaskId:id}]:[]);
        tasks.push(await createTask(req,'EXCEL',sku,null,{importBatchId,importRequestHash,importRows,importSkus:[sku],importGrouped:false},true));
      }
      const saved=await repository.createBatch(tasks);
      return Promise.all(saved.map(task=>find({accountId:task.accountId,taskId:task.id}).then(dto)));
    },
    async listTasks({ accountId }) { return (await repository.list({ accountId: identifier(accountId) })).map(dto); },
    async permanentlyDeleteTask(input) {
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw invalid();
      const task = await find(input,{includeDeleted:true});
      checkAction(task,input,'permanentDelete');
      const saved = await repository.requestPurge({accountId:task.accountId,taskId:task.id,expectedVersion:task.version,now:now()});
      if (!saved) throw problem('AI_LISTING_TASK_CONFLICT','任务状态已变化，请刷新后重试',409);
      return dto(saved);
    },
    async getTask(input) { return dto(await find(input,{includeDeleted:input.includeDeleted===true}),{detail:true}); },
    async previewTaskAction({accountId,group,action}) {
      if (!taskControlGroups.includes(group) || !taskControlActions.includes(action)) throw invalid();
      const tasks = await repository.listActionCandidates({accountId:identifier(accountId),group});
      const items=[], skipped=[];
      for (const task of tasks) {
        const reason=taskActionReason(task,action);
        if (reason) skipped.push({taskId:task.id,message:reason});
        else items.push({taskId:task.id,expectedVersion:task.version});
      }
      return {group,action,total:tasks.length,items,skipped};
    },
    async batchTaskAction({accountId,action,items}, options = {}) {
      accountId=identifier(accountId);
      if (!taskControlActions.includes(action) || !Array.isArray(items) || !items.length || items.length>100
        || items.some(item=>!item || !Number.isSafeInteger(item.expectedVersion) || item.expectedVersion<1)) throw invalid();
      const inputs=items.map(item=>({accountId,taskId:identifier(item.taskId),expectedVersion:item.expectedVersion}));
      if (new Set(inputs.map(item=>item.taskId)).size!==inputs.length) throw invalid();
      const result={applied:0,pending:0,skipped:[],errors:[]};
      for (const input of inputs) {
        try { const task=await service[`${action}Task`](input,options); result.applied++; if(task.controlAction)result.pending++; }
        catch(error) {
          if ([404,409].includes(error.statusCode)) result.skipped.push({taskId:input.taskId,message:error.message});
          else result.errors.push({taskId:input.taskId,code:/^[A-Z][A-Z0-9_]{0,100}$/.test(error?.code||'')?error.code:'AI_LISTING_ACTION_UNCONFIRMED',
            message:'该任务操作结果未确认，请刷新核对后再操作；不会自动重发。'});
        }
      }
      return result;
    },
    async reviseAndRetryTask(input, options = {}) {
      if(!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<1||!Array.isArray(input.revisions)||!input.revisions.length)throw invalid();
      return service.retryTask(input,{...options,revisions:input.revisions});
    },
    async retryTask(input, {beforeRetry,revisions} = {}) {
      const task = await find(input);
      if(input.skus!==undefined && (!Array.isArray(input.skus)||!input.skus.length||input.skus.length>100
        ||new Set(input.skus).size!==input.skus.length||input.skus.some(sku=>typeof sku!=='string'||!task.source?.items?.some(row=>row.sku===sku))))throw invalid();
      checkAction(task,input,'retry');
      if(task.status==='SUBMITTED'&&!input.skus)throw problem('AI_LISTING_RETRY_SKUS_REQUIRED','请选择需要恢复的失败 SKU；其他正在处理的 SKU 保持原请求',409);
      if(input.skus)task.submissionRetrySkus=[...input.skus];else delete task.submissionRetrySkus;
      if(task.status==='COMPLETED'&&input.refreshSalePricing!==true)throw problem('AI_LISTING_PRICING_REFRESH_REQUIRED','已完成商品保持不变；恢复跳过 SKU 时请明确选择使用当前售价配置',409);
      if(revisions!==undefined){if(task.status!=='SUBMISSION_FAILED')throw problem('AI_LISTING_REVISION_CONFLICT','仅上架失败任务可修订后重试',409);applyRevisions(task,revisions);}
      const refreshed=await beforeRetry?.(dto(task),{refreshSalePricing:input.refreshSalePricing===true,
        needsImageChannel:task.images.some(image=>!image.generatedUrl&&isGenerationLeader(task,image)
          &&!task.images.some(other=>other.sku===image.sku&&imageResultUnknown(other,task))&&!requiresPaidResult(image)
          &&(input.refreshSalePricing===true||!skippedSkus(task).has(image.sku)))});
      if(input.refreshSalePricing===true){
        if(!refreshed?.salePricing)throw problem('AI_LISTING_PRICING_REFRESH_FAILED','当前售价配置不可用，原任务与价格保持不变',409);
        task.pricingProtectedSkus=[...new Set([...(task.pricingProtectedSkus||[]),
          ...(task.status==='COMPLETED'?task.submittedSkus||[]:[]),
          ...(task.submissionResults||[]).filter(row=>row.importStatus==='SUCCEEDED'||row.stockStatus==='COMPLETED').map(row=>row.sku)])];
        task.config={...task.config,salePricing:refreshed.salePricing,salePricingUpdatedAt:refreshed.salePricingUpdatedAt};
        task.pricingRefreshPending=true;
      }
      for(const image of task.images){
        if(imageResultUnknown(image,task))image.resultUnknown=true;
        if(requiresPaidResult(image))image.reusePaidResult=true;
      }
      delete task.priceFailure; delete task.submissionStage;
      if (task.importBatchId && task.status === "COLLECTION_FAILED") {
        task.source=null;task.images=[];task.importGrouped=false;
        task.collectionAttempt = (task.collectionAttempt || 0) + 1;
        delete task.collectionJobId; delete task.collectionEnrichmentSource; delete task.collectionStage;
      }
      task.submissionExternalWriteStarted=task.status==='SUBMISSION_UNCERTAIN' || task.status!=='SUBMISSION_FAILED' && Boolean(task.submissionExternalWriteStarted);
      task.submissionStarted = task.submissionStarted || submissionStarted.has(task.status);
      if (task.submissionStarted) task.submissionRetryAttempt = (task.submissionRetryAttempt || 0) + 1;
      for (const image of task.images) if (!image.generatedUrl&&!image.resultUnknown) {
        image.status = "PENDING"; image.attempts = 0; image.retryAt = null; image.channelAttempts=[]; image.excludeChannelIds=[]; image.activeAttemptId=null;
      }
      task.extraImageAttempts = 0; task.consecutiveImageFailures = 0;
      task.status = !task.source ? "QUEUED" : task.images.some(image => !image.generatedUrl) ? "GENERATING"
        : task.config.manualReview && !task.approved ? "AWAITING_REVIEW" : "READY_TO_SUBMIT";
      if (task.importBatchId && !task.source) task.importGrouped=false;
      task.errorMessage = null; task.nextRunAt = now();
      return actionSave(task,true);
    },
    cancelTask(input) { return stopTask(input,'cancel'); },
    pauseTask(input) { return stopTask(input,'pause'); },
    deleteTask(input) { return stopTask(input,'delete'); },
    async resumeTask(input) {
      const task=await find(input,{includeDeleted:true});
      if(task.deletedAt && (!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<1))throw invalid();
      checkAction(task,input,'resume');
      if(task.deletedAt){
        // Restore the original record for inspection. A separate retry/resume authorizes more work.
        task.status=failureStates.has(task.stoppedFrom)?task.stoppedFrom:'PAUSED';
        task.deletedAt=null;task.updatedAt=now();
        const saved=await repository.restoreDeleted({task,expectedVersion:task.version,now:now()});
        if(!saved)throw problem('AI_LISTING_TASK_CONFLICT','任务状态已变化，请刷新后重试',409);
        return dto(saved);
      }
      if (task.importBatchId && !task.importGrouped) task.resumedAfterStop=true;
      task.status=resumedTaskStatus(task); task.nextRunAt=now();
      if (!failureStates.has(task.status)) {task.errorMessage=null;task.generationStage='queued';}
      delete task.stoppedFrom;
      return actionSave(task,true);
    },
    async approveTask(input) {
      const task = await find(input);
      checkAction(task,input,'approve');
      task.approved = true; task.status = "READY_TO_SUBMIT"; task.nextRunAt = now();
      return actionSave(task);
    },
    async processNext({ phase = "all", capacity } = {}) {
      const leaseToken = randomUUID();
      let task = await repository.claimNext({ now: now(), leaseMs: LEASE_MS, leaseToken, phase });
      if (!task) return null;
      let leaseLost = false; let renewal = Promise.resolve(); let productChannel = null;
      const heartbeat = setInterval(() => {
        renewal = renewal.then(async () => {
          if (!await repository.renewLease({ accountId: task.accountId, taskId: task.id, leaseToken, now: now(), leaseMs: LEASE_MS })) leaseLost = true;
        }).catch(() => { leaseLost = true; });
      }, LEASE_MS / 3);
      heartbeat.unref?.();
      async function finishControl(action,{client}={}) {
        // A local pause cannot replace an in-flight submission's final receipt.
        // There is no remaining automatic work in these states; settle the
        // pending control while retaining completion or actionable failure.
        if(!(action==='pause'&&task.submissionId&&(task.status==='COMPLETED'||failureStates.has(task.status))))
          finishTaskControl(task,action,now());
        const saved=await repository.save({task,expectedVersion:task.version,leaseToken,now:now(),releaseLease:true,finishControl:action,client});
        if (!saved) throw lostLease;
        task=saved;
        if ((!task.collectWait || task.source) && (!task.importBatchId || task.importGrouped)) await billing?.reconcile({accountId:task.accountId,taskId:task.id,client});
        throw controlStopped;
      }
      async function leaseState({client}={}) {
        if (leaseLost) throw lostLease;
        const scope={accountId:task.accountId,taskId:task.id,leaseToken,now:now(),expectedVersion:task.version,client};
        const state=repository.leaseState ? await repository.leaseState(scope)
          : await repository.get(scope).then(row=>({owned:row?.leaseToken===leaseToken && row.version===task.version && row.status!=='CANCELLED',controlAction:row?.controlAction}));
        if (!state.owned) {leaseLost=true;throw lostLease;}
        return state;
      }
      async function stopAtBoundary(context) {
        const state=await leaseState(context);
        if (state.controlAction) await finishControl(state.controlAction,context);
      }
      async function checkpoint(releaseLease = false, {safeBoundary=false,guardControl=false,requeue=false,reconcile=false,generatedResult,client}={}) {
        if (leaseLost) throw lostLease;
        task.updatedAt = now();
        const saved = await repository.save({ task, expectedVersion: task.version, leaseToken, now: now(), releaseLease, guardControl, requeue,client });
        if (!saved && guardControl) {
          // A stop won the race with submission intent. Restore the last durable stage, before SUBMITTING.
          const current=await repository.get({accountId:task.accountId,taskId:task.id,client});
          if(current?.version===task.version && current.leaseToken===leaseToken && current.leaseExpiresAt>now() && current.controlAction) {
            task=current; await finishControl(current.controlAction,{client});
          }
        }
        if (!saved) throw lostLease;
        task = saved;
        // The paid-result spool can be retired once URLs are durable, including a pending stop.
        // Cleanup failure must not undo the saved result; the bounded spool can retry cleanup later.
        if(generatedResult)try{await acknowledgeGeneratedResult?.({accountId:task.accountId,taskId:task.id,...generatedResult});}catch{}
        if (task.controlAction && (releaseLease || safeBoundary)) await finishControl(task.controlAction,{client});
        if (releaseLease && task.importBatchId && !task.importGrouped) {
          await groupImport(task);
          task = await find({accountId:task.accountId,taskId:task.id});
        }
        if (reconcile && (!task.collectWait || task.source) && (!task.importBatchId || task.importGrouped)) await billing?.reconcile({accountId:task.accountId,taskId:task.id,client});
      }
      async function progress(stage) {
        task.generationStage=stage;task.updatedAt=now();
        if(!repository.saveProgress){await checkpoint();return;}
        const saved=await repository.saveProgress({accountId:task.accountId,taskId:task.id,expectedVersion:task.version,leaseToken,now:now(),
          patch:{generationStage:stage,updatedAt:task.updatedAt}});
        if(!saved)throw lostLease;
        task.version=saved.version;task.controlAction=saved.controlAction;
      }
      async function waitForTarget(result) {
        task.submissionWait=result.submissionWait || {code:'TARGET_UNAVAILABLE',message:result.message||'目标店铺暂时无法确认',retryAt:now()+60000};
        task.errorMessage=task.submissionWait.message;
        delete task.quotaReservation;delete task.quotaWait;
        task.status='READY_TO_SUBMIT';task.nextRunAt=task.submissionWait.retryAt||now()+60000;
      }
      function firstSubmissionImageError() {
        if((task.source?.items?.length||0)<2)return null;
        // A local PREPARED journal is not proof that an external write happened.
        // Historical sent or successful items must still use their original recovery path.
        if(task.submissionExternalWriteStarted===true || task.submissionResults?.some(row=>row.importStatus==='SUCCEEDED'||row.stockStatus==='COMPLETED'))return null;
        const unfinished=skuProgress(task).filter(row=>!['READY','COMPLETED','SKIPPED'].includes(row.status));
        if(!unfinished.length)return null;
        return Object.assign(problem('AI_LISTING_PRODUCT_IMAGES_INCOMPLETE',
          `同一商品还有 ${unfinished.length} 个 SKU 图片未完成，整组尚未上架；成功图片已保留。${unfinished[0].reason||'请完成图片处理后重试'}`,409),
        {definitelyNotSubmitted:true,imageFailureStatus:unfinished.some(row=>row.status==='UPLOAD_FAILED')?'UPLOAD_FAILED':'GENERATION_FAILED'});
      }
      async function beforeExternalWrite(context) {
        if(task.submissionExternalWriteStarted===true){await assertActive(context);return;}
        await stopAtBoundary(context);
        const incomplete=firstSubmissionImageError();if(incomplete)throw incomplete;
        task.submissionStarted=true;task.submissionExternalWriteStarted=true;task.submissionStage='submitting';
        task.status=task.submissionId?'SUBMITTED':'SUBMITTING';
        await checkpoint(false,{guardControl:true,...context});
      }
      async function assertActive(context) {
        const state=await leaseState(context);
        if (state.controlAction) throw Object.assign(problem('AI_LISTING_TASK_CONTROL_REQUESTED','任务正在停止后续请求',409),{deliveryState:'NOT_SENT'});
      }
      async function releaseChannel() {
        const channel = productChannel; productChannel = null;
        if (channel) await channel.release();
      }
      async function fail(status, message, priceFailure) {
        task.status = status; task.errorMessage = message;
        if(status==='SUBMISSION_UNCERTAIN'){task.submissionExternalWriteStarted=true;task.submissionStarted=true;if(task.submissionStage!=='repairing_images')task.submissionStage='submitting';}
        if(priceFailure)task.priceFailure=structuredClone(priceFailure);
        await checkpoint(true,{reconcile:true}); return dto(task);
      }
      try {
        await stopAtBoundary();
        if(!task.config.ozonRoute&&readOzonRoute){task.config.ozonRoute=await readOzonRoute(task.accountId);await checkpoint();}
        if (task.status === "SUBMITTING" && task.submissionStage!=="preparing_media") return await fail("SUBMISSION_UNCERTAIN", "上次提交结果未知，请重试以查询或恢复同一上架请求");
        if (task.status === "SUBMITTED" || task.status==='READY_TO_SUBMIT'&&task.submissionStage==='prepared'&&task.submissionId) {
          let result;
          try { result = await readSubmission({ accountId: task.accountId, submissionId: task.submissionId,checkControl:stopAtBoundary,beforeExternalWrite }); }
          catch(error) { if(error===lostLease||error===controlStopped)throw error;
            if(error?.code==='AI_LISTING_PRODUCT_IMAGES_INCOMPLETE')return await fail(error.imageFailureStatus,error.message);
            task.nextRunAt = now() + POLL_MS; task.errorMessage = "暂时无法查询上架结果，将继续查询"; await checkpoint(true); return dto(task); }
          if(result?.quotaWait){task.quotaWait=result.quotaWait;task.errorMessage=result.quotaWait.message;}else{delete task.quotaWait;task.errorMessage=null;}
          if(result?.submissionWait){task.submissionWait=result.submissionWait;task.errorMessage=result.submissionWait.message;}else delete task.submissionWait;
          if(result?.submissionTarget)task.submissionTarget=result.submissionTarget;
          if(task.submissionExternalWriteStarted!==true&&submissionPreparing(task))task.submissionStage='prepared';
          else if(result?.submissionStage)task.submissionStage=result.submissionStage;else delete task.submissionStage;
          if (result?.items){
            task.submissionResults = result.items;
            task.pricingProtectedSkus=[...new Set([...(task.pricingProtectedSkus||[]),...result.items.filter(row=>row.importStatus==='SUCCEEDED'||row.stockStatus==='COMPLETED').map(row=>row.sku)])];
          }
          // Only a confirmed whole-group quota rejection can change destination.
          // The submission port validates this again against its durable journal.
          const canSwitch=result?.storeSwitchEligible===true && task.config.autoSwitchStores===true
            && result.status!=='UNCERTAIN' && result.items?.length>0
            && result.items.every(row=>['FAILED','PENDING'].includes(row.importStatus) && !row.productId && row.isCreated!==true);
          if(canSwitch){
            const current=task.submissionTarget?.targetStoreId||task.config.targetStoreId;
            const tried=new Set([...(task.storeSwitchTried||[]),current]);
            const target=(task.config.fallbackStores||[]).find(row=>!tried.has(row.targetStoreId));
            if(target){
              task.storeSwitchTried=[...tried];task.submissionTarget={...target};task.submissionStoreSwitch=true;
              task.submissionExternalWriteStarted=false;task.status='READY_TO_SUBMIT';task.submissionStage='switching_store';
              delete task.quotaWait;delete task.submissionWait;task.errorMessage=null;task.nextRunAt=now();
              await checkpoint(true);return dto(task);
            }
          }
          if (["COMPLETED", "SUCCEEDED"].includes(result?.status)) {
            // A retry may finish local images while an older import is still uncertain.
            // Only the journal's returned SKU results establish what was actually submitted.
            if(Array.isArray(result.items)){
              const recorded=new Set(result.items.map(row=>row.sku));
              const awaitingImport=skuProgress(task).filter(row=>row.status==='READY'&&!recorded.has(row.sku));
              if(awaitingImport.length){
                task.submissionRetryAttempt=(task.submissionRetryAttempt||0)+1;
                task.status='READY_TO_SUBMIT';delete task.submissionStage;task.nextRunAt=now();
                task.errorMessage=`原提交结果已确认，继续上架 ${awaitingImport.length} 个已恢复 SKU`;
                await checkpoint(true);return dto(task);
              }
            }
            const unfinished=skuProgress(task).filter(row=>!['SKIPPED','READY','COMPLETED'].includes(row.status));
            if(unfinished.length)return await fail('GENERATION_FAILED',`正常 SKU 已上架；${unfinished.length} 个 SKU 尚未完成，成功商品不会重提。${unfinished[0].reason||''}`);
            task.status = "COMPLETED"; task.errorMessage = null;
          }
          else if (result?.status === "FAILED") return await fail("SUBMISSION_FAILED", result.quotaWait?.message || (result.submissionStage==='image_failed'
            ? "Ozon 图片接收失败；重试只重传失败 SKU 的完整图片组，已生成图片和成功商品保留"
            : "部分商品上架失败，请检查逐 SKU 结果后重试失败项；类目错误请先重新确认类目，成功商品不会重提"));
          else if (result?.status === "UNCERTAIN") return await fail("SUBMISSION_UNCERTAIN", result.submissionStage==='repairing_images'
            ? "图片重传结果待核实，重试只查询原商品，不重复发送图片"
            : "提交结果待核实，已按商品货号查询；未确认商品不会自动重复创建");
          else { task.nextRunAt = result?.quotaWait?.retryAt || result?.submissionWait?.retryAt || now() + (Number.isSafeInteger(result?.retryAfterMs)
            ? Math.min(300_000, Math.max(POLL_MS, result.retryAfterMs)) : POLL_MS); }
          await checkpoint(true); return dto(task);
        }
        // Previous versions reserved Ozon creation quota before paid generation.
        // Retire that local admission state without replaying an external request.
        if(!task.submissionId && task.submissionExternalWriteStarted!==true){
          delete task.quotaReservation;delete task.quotaWait;delete task.submissionWait;
          if(task.generationStage==='waiting_quota'){task.generationStage='queued';task.errorMessage=null;}
        }
        if (!task.source) {
          task.status = "COLLECTING"; await checkpoint();
          let source;
          try {
            if (task.sourceType === "COLLECT_BOX") {
              const waiting = task.collectWait;
              if (!waiting) throw problem("AI_LISTING_SOURCE_CHANGED", "任务缺少创建时的来源 SKU 选集，请重新创建");
              const sources = await loadSources({ accountId: task.accountId, collectItemIds: [task.sourceId], config: listingConfig(task.config) });
              source = sources.find(row => row.collectItemId === task.sourceId);
              if (!source) throw problem("AI_LISTING_SOURCE_NOT_FOUND", "采集来源已删除或不可用，任务已停止；创建时的来源证据已保留");
              if (source.sku !== waiting.initialSource.sku || waiting.selectedSkus.some(sku => source.items.filter(item => item.sku === sku).length !== 1)) {
                throw problem("AI_LISTING_SOURCE_CHANGED", "创建时选定的来源 SKU 已变化，任务已停止；请核对采集箱后重新创建");
              }
              source = { ...source, items: waiting.selectedSkus.map(sku => source.items.find(item => item.sku === sku)) };
              applyCollectorModel(source,task.collectorAuto?.modelName);
              source.thumbnail = source.items[0]?.images?.[0] || "";
              if (collectEnrichmentPending(source, waiting.initialSource)) {
                task.errorMessage = null; task.nextRunAt = now() + COLLECT_POLL_MS;
                await checkpoint(true); return dto(task);
              }
            } else {
              source = await collectSku({ accountId: task.accountId, sku: task.sourceId, config: listingConfig(task.config),
                taskId: task.id, collectionJobId: task.collectionJobId, collectionAttempt: task.collectionAttempt || 0 });
              if (collectEnrichmentPending(source, task.collectionEnrichmentSource)) {
                task.collectionEnrichmentSource = { enrichmentJobs: structuredClone(source.enrichmentJobs) };
                task.collectionStage = 'waiting_seller'; task.errorMessage = '商品已采集，等待 Seller 类目与包装资料补全';
                task.nextRunAt = now() + COLLECT_POLL_MS;
                await checkpoint(true); return dto(task);
              }
            }
            applySource(task, source);
            delete task.collectionStage; delete task.collectionEnrichmentSource;
          } catch (error) {
            if (error === lostLease || error === controlStopped) throw error;
            if (error?.code === 'AI_LISTING_COLLECTION_PENDING') {
              task.collectionJobId = error.collectionJobId; task.collectionStage = error.collectionStage || 'waiting_extension';
              task.errorMessage = error.message; task.nextRunAt = now() + COLLECT_POLL_MS;
              await checkpoint(true); return dto(task);
            }
            const actionable = ["AI_LISTING_COLLECTION_FAILED", "AI_LISTING_ALREADY_LISTED", "AI_LISTING_SOURCE_NOT_FOUND", "AI_LISTING_SOURCE_CHANGED", "AI_LISTING_ENRICHMENT_FAILED", "AI_LISTING_LOGISTICS_REQUIRED"].includes(error?.code);
            return await fail("COLLECTION_FAILED", actionable || error?.code?.startsWith("PRODUCT_RESTRICTION_") ? error.message
              : task.sourceType === "COLLECT_BOX" ? "读取采集来源或 Seller 补全结果失败，请重试" : "SKU 采集失败，请重试");
          }
          task.status = "GENERATING"; task.errorMessage = null;
          if (task.importBatchId && !task.importGrouped) {
            task.generationStage='waiting_product';task.nextRunAt=now()+COLLECT_POLL_MS;await checkpoint(true);
            if (phase === "all" && task.importGrouped && task.status === "GENERATING") return await service.processNext({phase,capacity});
            return dto(task);
          }
          await checkpoint(false,{safeBoundary:true});
        }
        if (phase === "prepare" || (task.importBatchId && !task.importGrouped)) {
          task.nextRunAt=now()+COLLECT_POLL_MS;await checkpoint(true);return dto(task);
        }
        if (task.pricingRefreshPending||task.images.some(image => !image.generatedUrl)) {
          if (checkSource) {
            try {
              task.source = await checkSource({accountId:task.accountId,source:task.source,config:listingConfig(task.config),protectedSkus:task.pricingProtectedSkus||[]});
            } catch (error) {
              if(error?.code!=='ZONGZI_CATEGORY_TREE_UNAVAILABLE')throw error;
              if(error.diagnostic?.retryable===true){
                task.status='GENERATING';task.generationStage='waiting_source';
                task.errorMessage='等待 Ozon 类目服务恢复，尚未开始新的生图请求，将自动继续检查。';
                task.nextRunAt=now()+60_000;await checkpoint(true);return dto(task);
              }
              task.generationStage=null;
              return await fail('GENERATION_FAILED',[401,403].includes(error.diagnostic?.sourceStatus)||error.diagnostic?.sourceCode==='ZONGZI_CREDENTIALS_MISSING'
                ?'Ozon 类目读取未获授权，请检查目标店铺的 API Key 与接口权限后重试；已有图片保留。'
                :'无法读取 Ozon 类目，请检查目标店铺配置后重试；已有图片保留。');
            }
            if(task.generationStage==='waiting_source'){task.generationStage='queued';task.errorMessage=null;}
            task.pricingRefreshPending=false;
            for(const image of task.images){
              if(skippedSkus(task).has(image.sku)&&!image.generatedUrl)image.status='SKIPPED';
              else if(image.status==='SKIPPED')image.status='PENDING';
            }
            await checkpoint();
          }
          if(task.imagePolicyVersion===AI_LISTING_IMAGE_POLICY_VERSION){
            const plan=planAiListingImages({...task,source:{...task.source,items:task.source.items.filter(item=>!skippedSkus(task).has(item.sku))}});
            if(plan!==task.imagePlan){task.imagePlan=plan;await checkpoint(false,{safeBoundary:true});}
          }
        }
        const funding=task.images.some(image=>canGenerateImage(task,image,now()))?await billing?.reconcile({accountId:task.accountId,taskId:task.id,reserve:true}):null;
        if(funding&&!funding.funded){task.status='GENERATING';task.errorMessage=funding.message;task.nextRunAt=now()+30_000;await checkpoint(true);return dto(task);}
        // A crashed request may have reached the paid provider; explicit user retry is required.
        for(const image of task.images)if(imageResultUnknown(image,task)&&!image.generatedUrl){
          image.resultUnknown=true;image.status='GENERATION_FAILED';image.retryAt=null;
          image.errorMessage='上次图片请求结果未知，已保留记录，普通重试不会再次生图';
        }
        async function acquireChannel(pending) {
          if(!reserveChannel||productChannel||requiresPaidResult(pending))return true;
          try {
            productChannel = await reserveChannel({ accountId: task.accountId, taskId: task.id, capacity,
              excludeChannelIds: pending.excludeChannelIds || [] });
          } catch (error) {
            if (!["AI_GATEWAY_NO_CAPACITY", "AI_LISTING_PRODUCT_ALREADY_RESERVED"].includes(error.code)) throw error;
            // Reservation still enforces cooldown and quarantine. Only exclusions backed by known
            // unsent attempts may start another round; actual attempts retain their finite budget.
            if(error.code==='AI_GATEWAY_NO_CAPACITY'&&pending.excludeChannelIds?.length&&canRestartChannelRound(pending))pending.excludeChannelIds=[];
            task.status = "GENERATING"; task.generationStage = "waiting_channel";
            task.errorMessage = "等待可用商品通道或服务器处理名额"; task.nextRunAt = now() + POLL_MS;
            await checkpoint(true); return false;
          }
          return true;
        }
        for (let position = 0; position < task.images.length; position++) {
          await stopAtBoundary();
          if (!canGenerateImage(task,task.images[position],now())) continue;
          let candidate = task.images[position];
          candidate=task.images[position];
          if(!await acquireChannel(candidate))return dto(task);
          const grid = task.config.generationMode === "GRID";
          const plannedItem=task.imagePlan?.items.find(item=>item.sku===candidate.sku);
          const gridGroup=grid?plannedItem?.groups.find(group=>group.indices.includes(candidate.index)):null;
          if(task.imagePolicyVersion===AI_LISTING_IMAGE_POLICY_VERSION&&(!plannedItem||grid&&!gridGroup))
            throw problem('AI_LISTING_IMAGE_PLAN_INCOMPLETE','图片尚未获得完整冻结计划，尚未发送新图片请求；请核对来源类目与分组后重试，成功图片和付费结果已保留');
          // Each frozen group owns its leader and retry state. Legacy tasks keep one SKU group.
          const positions = grid ? task.images.map((item, i) => item.sku === candidate.sku && !item.generatedUrl
            && (!gridGroup||gridGroup.indices.includes(item.index)) ? i : -1).filter(i => i >= 0) : [position];
          if (grid && position !== positions[0]) continue;
          if (candidate.status.endsWith("FAILED") && (!candidate.retryAt || candidate.retryAt > now())) continue;
          if (candidate.attempts > 0 && !candidate.channelAttempts?.length) {
            if ((task.extraImageAttempts || 0) >= 3) { candidate.retryAt = null; continue; }
            task.extraImageAttempts = (task.extraImageAttempts || 0) + 1;
          }
          candidate.attempts = (candidate.attempts || 0) + 1;
          candidate.activeAttemptId=randomUUID();
          candidate.retryAt = null;
          task.status = "GENERATING"; task.images[position].status = "GENERATING";
          await checkpoint();
          const image = task.images[position]; let result;
          try {
            await assertActive();
            const input = { accountId: task.accountId, taskId: task.id, sku: image.sku, index: image.index,
              sourceUrl: image.sourceUrl, prompt: task.config.prompt, image: structuredClone(task.config.image),
              ...(requiresPaidResult(image)?{mustReusePaidResult:true}:{}),
              ...(task.imagePlan?{imagePolicy:Object.fromEntries(['version','minWidth','minHeight','maxWidth','maxHeight'].map(key=>[key,task.imagePlan[key]]))}:{}),
              ...(gridGroup?{gridGroup:structuredClone(gridGroup)}:{}),
              requestKey: `${image.requestKey}:${image.activeAttemptId}`, excludeChannelIds: image.excludeChannelIds || [],
              beforeRequest:async()=>{await assertActive();},onProgress:progress,
              ...(productChannel ? { channelId: productChannel.channelId, productToken: productChannel.productToken } : {}) };
            result = grid ? await generateImageGroup({ ...input,
              sources: positions.map(i => ({ index: task.images[i].index, sourceUrl: task.images[i].sourceUrl })) }) : await generateImage(input);
            if (grid && (!Array.isArray(result?.images) || result.images.length !== positions.length
              || new Set(result.images.map(item => item.index)).size !== positions.length
              || result.images.some(item => item.sku !== image.sku || !positions.some(i => task.images[i].index === item.index)))) throw invalid();
            for (const output of grid ? result.images : [result]) {
              const url = new URL(output?.generatedUrl);
              if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw invalid();
            }
          } catch (error) {
            if (error === lostLease || error === controlStopped) throw error;
            // Progress checkpoints replace the task snapshot while preparation is running.
            const image = task.images[position];
            if(['AI_LISTING_IMAGE_DIMENSIONS_UNSUPPORTED','AI_LISTING_GRID_GEOMETRY_INVALID'].includes(error.code)){
              image.status='GENERATION_FAILED';image.retryAt=null;
              image.lastError={code:error.code,requestId:error.requestId||null,diagnostic:error.diagnostic,occurredAt:new Date(now()).toISOString()};
              image.paidResultRetained=error.paidResultRetained===true;
              if(error.generationConfig)image.generationConfig=error.generationConfig;
              image.errorMessage=error.code==='AI_LISTING_IMAGE_DIMENSIONS_UNSUPPORTED'?error.message:
                '通道返回的拼图分隔带不完整，已保留付费结果且不会自动再生图。请核对通道对冻结画布尺寸与分隔带的支持；如需新图，请使用已验证通道新建任务（将产生新的模型请求费用）。';
              await checkpoint();continue;
            }
            if (error.deliveryState === "POSSIBLY_SENT" || error.details?.deliveryState === "POSSIBLY_SENT") {
              image.status = "GENERATION_FAILED"; image.retryAt = null;
              image.lastError = { code: error.code || "AI_LISTING_IMAGE_RESULT_UNKNOWN",deliveryState:'POSSIBLY_SENT',diagnostic:getAiGatewayDiagnostic(error),occurredAt: new Date(now()).toISOString() };
              image.resultUnknown=true;image.errorMessage='图片请求结果未知，可能已经生成或计费；请先核实请求结果，成功图片已保留';
              await checkpoint();await releaseChannel();continue;
            }
            if(error.code==="AI_GATEWAY_NO_CAPACITY"||(["AI_LISTING_WORKER_STOPPING","AI_LISTING_TASK_CONTROL_REQUESTED"].includes(error.code)&&error.deliveryState==="NOT_SENT")) {
              image.attempts=Math.max(0,image.attempts-1);image.status="PENDING";image.activeAttemptId=null;
              // No request was sent. Keep waiting without spending an attempt.
              // A later round can probe cooled channels if all alternatives were tried.
              if(canRestartChannelRound(image))image.excludeChannelIds=[];
              task.generationStage="waiting_channel";
              task.errorMessage=error.code==="AI_LISTING_WORKER_STOPPING"?"后台正在切换，已保存成功图片，等待继续":"等待可用通道：健康通道忙碌或暂不可用，恢复后自动继续";
              task.nextRunAt=now()+15_000;
              await checkpoint(true);return dto(task);
            }
            if(error.channelId && error.stage!=="upload") {
              image.channelAttempts=[...(image.channelAttempts||[]),{channelId:error.channelId,attemptId:image.activeAttemptId,code:error.code,at:now(),
                ...(error.deliveryState==='NOT_SENT'||error.details?.deliveryState==='NOT_SENT'?{deliveryState:'NOT_SENT'}:{})}];
              image.excludeChannelIds=[...new Set([...(image.excludeChannelIds||[]),error.channelId])];
              image.lastError={code:error.code,diagnostic:getAiGatewayDiagnostic(error),occurredAt:new Date(now()).toISOString()};
              if(error.code==='AI_GATEWAY_QUOTA_EXHAUSTED'&&(error.deliveryState==='NOT_SENT'||error.details?.deliveryState==='NOT_SENT')){
                image.attempts=Math.max(0,image.attempts-1);image.status='PENDING';image.activeAttemptId=null;
                image.retryAt=now()+POLL_MS;task.nextRunAt=image.retryAt;task.generationStage='waiting_channel';
                task.errorMessage='通道额度不足，等待其他可用通道；尚未发送生图请求，不消耗 SKU 尝试次数';
                await checkpoint(true);return dto(task);
              }
              image.status="GENERATION_FAILED";image.errorMessage="通道请求失败，准备切换其他可用通道";
              if(image.channelAttempts.length>=3){image.retryAt=null;await checkpoint();await releaseChannel();continue;}
              image.retryAt=now();
              task.nextRunAt=now();task.errorMessage="图片请求失败，正在切换可用通道继续";
              await checkpoint();await releaseChannel();continue;
            }
            if (error.generationConfig) image.generationConfig = error.generationConfig;
            image.lastError = {
              code: /^[A-Z][A-Z0-9_]{0,100}$/.test(error?.code || "") ? error.code : "AI_LISTING_IMAGE_FAILED",
              requestId: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(error?.requestId || "") ? error.requestId : null,
              occurredAt: new Date(now()).toISOString(),
              diagnostic:getAiGatewayDiagnostic(error)||error.diagnostic,
            };
            console.warn("[ai-listing] image request failed", {
              taskId: task.id, sku: image.sku, index: image.index, ...image.lastError,
            });
            const status = error?.stage === "upload" ? "UPLOAD_FAILED" : "GENERATION_FAILED";
            task.images[position].status = status;
            const messages = {
              AI_LISTING_GRID_GEOMETRY_INVALID: "拼图分隔带不完整，未保存错误切片，请重试或使用逐张生图新建任务",
              AI_LISTING_OCR_UNAVAILABLE: "本机文字识别不可用，请检查 macOS Swift/Vision 环境",
              AI_LISTING_OCR_FAILED: "原图文字识别失败，请检查原图后重试",
              AI_GATEWAY_UNEXPECTED_EOF: "图片服务响应中断，成功图片已保留",
              AI_GATEWAY_STREAM_TIMEOUT: "图片服务等待上游数据超时，成功图片已保留",
              AI_GATEWAY_NO_CAPACITY: "图片服务当前没有可用通道，请检查服务账号状态或稍后重试",
              AI_GATEWAY_QUOTA_EXHAUSTED: "图片服务额度已耗尽，请补充额度后重试",
              AUTO_LISTING_SOURCE_DOWNLOAD_INPUT_INVALID: "原图下载参数错误，请联系管理员检查应用配置",
              AUTO_LISTING_SOURCE_DOWNLOAD_BLOCKED: "原图下载被安全检查拦截，请检查图片链接",
              AUTO_LISTING_SOURCE_DOWNLOAD_FAILED: "原图下载失败，请检查网络后重试",
              AUTO_LISTING_SOURCE_IMAGE_INVALID: "原图格式无效，请更换图片后重试",
              AI_LISTING_CHANNEL_UNAVAILABLE: "专属通道不可用，请联系管理员检查用户通道分配",
              AI_LISTING_MODEL_UNAVAILABLE: "当前模型已不在最新网关目录中，请在管理员配置中同步模型、选择并保存启用后重试",
              AI_GATEWAY_MODEL_UNAVAILABLE: "请求模型没有可用账号，请在管理员配置中同步模型，并检查网关账号是否支持当前模型",
              AI_LISTING_PROFILE_REQUIRED: "没有可用的 AI 图片配置，请先发布配置",
              AI_LISTING_PUBLICATION_REQUIRED: "图片存储未配置，请先配置公开图片存储",
              AI_LISTING_RESULT_SPOOL_FULL: "生成结果暂存已满或磁盘空间不足，尚未发送新的生图请求；请先恢复未保存图片或释放已确认可清理的暂存",
              AI_LISTING_RESULT_CHECKPOINT_INVALID: "已生成结果暂存不完整，已停止再次生图，请先检查暂存文件",
              AI_LISTING_RESULT_INPUT_CHANGED: "原图片配置与已生成暂存结果不一致，已保留原结果，请先核对",
              AI_LISTING_PAID_RESULT_MISSING: "原付费拼图或图片已不可用，无法从暂存恢复；本次未再次生图，请核实后另行确认重新生图",
            };
            image.errorMessage = messages[error?.code] || (status === "UPLOAD_FAILED" ? "生成图片存储失败，已保留其他成功图片" : "图片生成失败，已保留其他成功图片");
            const transient = transientImageErrors.has(error?.code) && status !== "UPLOAD_FAILED";
            task.consecutiveImageFailures = transient ? (task.consecutiveImageFailures || 0) + 1 : 0;
            if (unavailableImageErrors.has(error?.code)) return await fail(status, image.errorMessage);
            if (task.consecutiveImageFailures >= 2) {
              return await fail(status, `${image.errorMessage}；连续两次通道失败，任务已暂停，请检查服务后重试`);
            }
            if (transient && image.attempts < 2 && (task.extraImageAttempts || 0) < 3) {
              image.retryAt = now() + 30_000 + Math.floor(Math.random() * 15_000);
            }
            await checkpoint();
            continue;
          }
          task.consecutiveImageFailures = 0;
          task.errorMessage = null;
          // Approval covers saved images only; recovered images need their own review.
          if(task.config.manualReview)task.approved=false;
          for (const target of positions) {
          const output = grid ? result.images.find(item => item.index === task.images[target].index) : result;
          Object.assign(task.images[target], { errorMessage: null, lastError: null, retryAt: null, generatedUrl: output.generatedUrl, status: "COMPLETED",
            ...(output.previewUrl ? { previewUrl: output.previewUrl } : {}),
            ...(output.generationConfig ? { generationConfig: output.generationConfig } : {}),
            ...(output.objectKey ? { objectKey: output.objectKey } : {}), ...(output.contentType ? { contentType: output.contentType } : {}) });
          }
          const completeSku=task.images.filter(image=>image.sku===candidate.sku).every(image=>image.generatedUrl);
          await checkpoint(false,{safeBoundary:true,reconcile:completeSku,
            generatedResult:{sku:candidate.sku,index:candidate.index,generationMode:task.config.generationMode,
              ...(gridGroup?{gridGroup:{id:gridGroup.id}}:{})}});
        }
        const missing = task.images.filter(image => !image.generatedUrl&&!skippedSkus(task).has(image.sku));
        if (missing.length) {
          const retries = missing.filter(image => image.retryAt && (task.extraImageAttempts || 0) < 3);
          if (retries.length) {
            task.status = "GENERATING";
            task.nextRunAt = Math.min(...retries.map(image => image.retryAt));
            task.errorMessage = "部分图片失败，成功图片已保留；等待自动补试（每张最多一次）";
            await checkpoint(true); return dto(task);
          }
          const incomplete=firstSubmissionImageError();if(incomplete)return await fail(incomplete.imageFailureStatus,incomplete.message);
          if(!submissionSource(task).items.length)return await fail(missing.some(image => image.status === "UPLOAD_FAILED") ? "UPLOAD_FAILED" : "GENERATION_FAILED",
            missing.some(image=>image.channelAttempts?.length>=3)?"部分图片已尝试三次，已保留成功图片，请检查通道后手动重试":missing[0].errorMessage || "仍有图片未完成，成功图片已保留，请重试");
        }
        const readySource=submissionSource(task);
        if(!readySource.items.length)return await fail('GENERATION_FAILED','全部 SKU 已跳过，请查看逐 SKU 原因；可更新售价配置后重试');
        task.generationStage = null;
        await releaseChannel();
        if (task.config.manualReview && !task.approved) {
          task.status = "AWAITING_REVIEW"; task.errorMessage = null; await checkpoint(true,{reconcile:true}); return dto(task);
        }
        if (phase === "generate") {
          task.status="READY_TO_SUBMIT";task.errorMessage=null;task.nextRunAt=now();await checkpoint(true);return dto(task);
        }
        // Preparation is stoppable. Only the submission port's actual write boundary closes that fence.
        const commitTarget=async (target,reservation,{client}={})=>{
          if(target)task.submissionTarget=target;
          delete task.quotaReservation;delete task.quotaWait;delete task.submissionWait;
          task.submissionStarted=true;task.status="SUBMITTING";task.submissionStage=task.submissionExternalWriteStarted===true?'submitting':'preparing_media';task.errorMessage=null;await checkpoint(false,{guardControl:true,client});
        };
        if(routeStores && task.submissionExternalWriteStarted!==true){
          const result=await routeStores({task:{...task,source:readySource},commit:commitTarget});
          if(!result.selected){await waitForTarget(result);await checkpoint(true);return dto(task);}
        }else await commitTarget();
        let submission;
        try {
          submission = await submitListing({ accountId: task.accountId, taskId: task.id, idempotencyKey: task.submissionKey,
            retryAttempt: task.submissionRetryAttempt || 0, deferImport:phase==="media",
            ...(task.submissionStoreSwitch?{switchStore:true}:{}),
            ...(task.submissionRetrySkus?{retrySkus:task.submissionRetrySkus}:{}),
            checkControl:stopAtBoundary,beforeExternalWrite,
            config: {...listingConfig(task.config),...task.submissionTarget}, source: structuredClone(readySource),
            images: task.images.filter(image=>readySource.items.some(item=>item.sku===image.sku)).map(({ sku, index, sourceUrl, generatedUrl }) => ({ sku, index, sourceUrl, generatedUrl })) });
          if (!submission?.submissionId) throw invalid();
        } catch (error) {
          if(error===lostLease||error===controlStopped)throw error;
          if(error?.code==='AI_LISTING_PRODUCT_IMAGES_INCOMPLETE')return await fail(error.imageFailureStatus,error.message);
          if(error?.code==='AI_LISTING_MEDIA_PREPARATION_FAILED'){
            if(error.mediaStage)task.mediaStage=error.mediaStage;
            if(error.mediaDiagnostics)task.mediaDiagnostics=structuredClone(error.mediaDiagnostics);
          }
          if(error?.definitelyNotSubmitted===true&&error?.code==='PRICE_FINAL_NOT_POSITIVE')return await fail('SUBMISSION_FAILED',error.priceFailure?error.message:'最终售价不大于 0，本商品已跳过上架；已生成图片保留，其他商品继续处理。',error.priceFailure||{code:error.code,sku:task.sku});
          if(error?.priceValidationFailure===true&&error?.definitelyNotSubmitted===true)return await fail('SUBMISSION_FAILED',error.message);
          return await fail(error?.definitelyNotSubmitted === true ? "SUBMISSION_FAILED" : "SUBMISSION_UNCERTAIN",
            error?.definitelyNotSubmitted === true
              ? ((error?.code?.startsWith("PRODUCT_RESTRICTION_") || error?.code === "ZONGZI_PRODUCT_RUSSIAN_REQUIRED" || error?.code === "AI_LISTING_MEDIA_PREPARATION_FAILED") ? error.message : error?.code === "AI_LISTING_CURRENCY_CONVERSION_REQUIRED"
                ? "来源与目标店铺币种不同，缺少可靠汇率；图片已保留，请确认币种后重试"
                : error?.code === "AI_LISTING_CATEGORY_UNRESOLVED"
                  ? "商品类目尚未确认，请根据任务保留的来源重新确认类目映射后重试，生成图片已保留"
                  : error?.code === "AI_LISTING_NO_BRAND_UNRESOLVED"
                    ? "当前类目的无品牌选项未匹配，请检查类目字典后重试"
                    : "上架提交失败，请重试")
              : "提交结果未知，请重试以查询或恢复同一上架请求");
        }
        await stopAtBoundary();
        delete task.mediaStage;delete task.mediaDiagnostics;
        delete task.submissionStoreSwitch;
        task.submissionId = submission.submissionId; task.status = phase==="media"?"READY_TO_SUBMIT":"SUBMITTED";
        task.submittedSkus=[...new Set([...(task.submittedSkus||[]),...readySource.items.map(item=>item.sku)])];
        if(phase==="media")task.submissionStage="prepared";else delete task.submissionStage;
        task.errorMessage = null; task.nextRunAt = phase==="media"?now():now() + POLL_MS;
        await checkpoint(true); return dto(task);
      } catch (error) {
        if (error === controlStopped) return dto(task);
        if(error?.priceValidationFailure===true)return await fail('GENERATION_FAILED',error.message);
        if(error?.code==='PRICE_FINAL_NOT_POSITIVE')return await fail('GENERATION_FAILED',error.priceFailure?error.message:'最终售价不大于 0，本商品已跳过上架，尚未开始生图；其他商品继续处理。',error.priceFailure||{code:error.code,sku:task.sku});
        if(error?.code==='AI_LISTING_CURRENCY_CONVERSION_REQUIRED')return await fail('GENERATION_FAILED','来源与目标店铺币种不同，缺少可靠汇率；请确认币种后重试');
        if (error?.code === "AI_LISTING_CATEGORY_UNRESOLVED") return await fail("GENERATION_FAILED", "商品类目尚未确认，请根据任务保留的来源重新确认类目映射后重试，成功图片已保留");
        if(error?.code?.startsWith('AI_LISTING_IMAGE_PLAN_'))return await fail('GENERATION_FAILED',error.message);
        if (error?.code === "AI_LISTING_LOGISTICS_REQUIRED") return await fail("GENERATION_FAILED", error.message);
        if(error?.code?.startsWith("PRODUCT_RESTRICTION_"))return await fail("GENERATION_FAILED",error.message);
        if (error !== lostLease) throw error;
        const current = await repository.get({ accountId: task.accountId, taskId: task.id });
        return current ? dto(current) : null;
      } finally { clearInterval(heartbeat); await renewal; await releaseChannel().catch(() => {}); }
    },
  };
  return service;
}
