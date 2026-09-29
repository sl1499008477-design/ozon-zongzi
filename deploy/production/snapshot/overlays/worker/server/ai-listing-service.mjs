import { createHash, randomUUID } from "node:crypto";
import { normalizeOzonImportLogistics } from "./ozon-import-normalizer.mjs";

export const AI_LISTING_DEFAULT_PROMPT = "请根据这套商品图片重新生成一份适用于 ozon 的全新商品图，产品主体以及产品上的文字、logo 等信息保持不变，生成数量跟这套商品图相同，不要移除图片中既有的卖点、材质、规格型号等信息";
const LEASE_MS = 90000;
const POLL_MS = 15000;
const COLLECT_POLL_MS = 30000;
const transientImageErrors = new Set(["AI_GATEWAY_UNEXPECTED_EOF", "AI_GATEWAY_STREAM_TIMEOUT", "AI_GATEWAY_RATE_LIMITED", "RETRYABLE_GATEWAY"]);
const unavailableImageErrors = new Set(["AI_LISTING_CHANNEL_UNAVAILABLE","AI_LISTING_MODEL_UNAVAILABLE", "AI_GATEWAY_MODEL_UNAVAILABLE", "AI_GATEWAY_NO_CAPACITY", "AI_GATEWAY_QUOTA_EXHAUSTED", "NON_RETRYABLE_AUTH", "AI_LISTING_PROFILE_REQUIRED", "AI_LISTING_PUBLICATION_REQUIRED"]);
const failureStates = new Set(["COLLECTION_FAILED", "GENERATION_FAILED", "UPLOAD_FAILED", "SUBMISSION_FAILED", "SUBMISSION_UNCERTAIN"]);
const submissionStarted = new Set(["SUBMITTING", "SUBMITTED", "COMPLETED", "SUBMISSION_UNCERTAIN", "SUBMISSION_FAILED"]);
const lostLease = Symbol("lostLease");
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const problem = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const invalid = () => problem("AI_LISTING_INVALID_INPUT", "AI 上架参数无效");
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
    priceAdjustmentKopecks, priceMultiplier, brandMode, manualReview, generationMode,
    image: { ratio: generationMode === "GRID" ? "3:4" : option(raw.image?.ratio, "3:4"), language: option(raw.image?.language, "ru"),
      resolution: generationMode === "GRID" ? "1K" : option(raw.image?.resolution, "2K"), quality: option(raw.image?.quality, "high") }, prompt };
}
function listingConfig(config) {
  const { prompt, image, generationMode, ...local } = config;
  return local;
}
function dto(task) {
  return { id: task.id, sourceType: task.sourceType, ...(task.sourceType === "COLLECT_BOX" ? {collectItemId:task.sourceId} : {}), sku: task.sku, name: task.name, thumbnail: task.thumbnail,
    ...(task.importBatchId ? { importBatchId: task.importBatchId, importSkus: task.importSkus || [task.sourceId],
      importRows: structuredClone(task.importRows || []) } : {}),
    ...(task.generationStage ? {generationStage:task.generationStage} : {}),
    ...(task.collectionStage ? {collectionStage:task.collectionStage} : {}),
    config: structuredClone(task.config), ...(task.submissionTarget?{submissionTarget:structuredClone(task.submissionTarget)}:{}), status: task.status,
    images: task.images.map(({ sku, index, sourceUrl, generatedUrl, status }) => ({ sku, index, sourceUrl, generatedUrl, status })),
    createdAt: new Date(task.createdAt).toISOString(), updatedAt: new Date(task.updatedAt).toISOString(),
    ...(task.submissionResults ? { submissionResults: structuredClone(task.submissionResults) } : {}),
    ...(task.priceFailure ? {priceFailure:structuredClone(task.priceFailure)} : {}),
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
  if (task.requestHash !== requestHash) throw problem("AI_LISTING_IDEMPOTENCY_CONFLICT", "相同请求标识的配置不能更改", 409);
}

function prepareSourceLogistics(source) {
  for (const group of source.items) {
    try { Object.assign(group.listingItem, normalizeOzonImportLogistics(group.listingItem)); }
    catch (error) { error.code = "AI_LISTING_LOGISTICS_REQUIRED"; throw error; }
  }
}

export function createAiListingService({ repository, loadSources, collectSku, generateImage, generateImageGroup, reserveChannel, submitListing, readSubmission, routeStores, billing, checkSource, checkRestrictions, clock = Date.now }) {
  const now = () => Number(clock());
  async function find(input) {
    const accountId = identifier(input.accountId); const taskId = identifier(input.taskId);
    const task = await repository.get({ accountId, taskId });
    if (!task) throw problem("AI_LISTING_TASK_NOT_FOUND", "任务不存在", 404);
    if (task.status === "MERGED") {
      const canonical = await repository.get({ accountId, taskId: task.mergedTaskId });
      if (!canonical || canonical.status === "MERGED" || canonical.importBatchId !== task.importBatchId) throw problem("AI_LISTING_TASK_NOT_FOUND", "任务不存在", 404);
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
      if (!row.source || row.status === 'MERGED' || (row.status === 'CANCELLED' && !row.importGrouped) || row.status === 'COLLECTION_FAILED') continue;
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
      if (!started) {applySource(canonical,{...canonical.source,items:[...items.values()]});canonical.generationStage='queued';}
      const mappings=new Map((canonical.importRows || []).map(row=>[row.row,row]));
      for(const row of accepted) for(const mapping of row.importRows || []) mappings.set(mapping.row,{...mapping,taskId:canonical.id});
      canonical.importRows=[...mappings.values()].sort((a,b)=>a.row-b.row);
      canonical.importSkus=[...new Set(canonical.importRows.map(row=>row.sku))];
      canonical.importGrouped=true;canonical.nextRunAt=now();canonical.updatedAt=now();changed.set(canonical.id,canonical);
      for(const row of accepted) if(row.id!==canonical.id) {
        row.status='MERGED';row.mergedTaskId=canonical.id;row.importGrouped=true;row.updatedAt=now();changed.set(row.id,row);
      }
    }
    return [...changed.values()];
  }
  async function actionSave(task) {
    task.updatedAt = now();
    const saved = await repository.save({ task, expectedVersion: task.version, now: now(), releaseLease: true });
    if (!saved) throw problem("AI_LISTING_TASK_CONFLICT", "任务状态已变化，请刷新后重试", 409);
    if ((!task.collectWait || task.source) && (!task.importBatchId || task.importGrouped)) await billing?.reconcile({accountId:task.accountId,taskId:task.id});
    await groupImport(saved);
    return dto(await find({accountId:saved.accountId,taskId:saved.id}));
  }
  function request(input) {
    return { accountId: identifier(input.accountId), idempotencyKey: identifier(input.idempotencyKey), config: normalizeAiListingConfig(input.config) };
  }
  async function createTask({ accountId, idempotencyKey, config, selectedSkus }, sourceType, sourceId, source, metadata, deferSave = false) {
    const identity = taskIdentity({ accountId, idempotencyKey, config, selectedSkus }, sourceType, sourceId);
    const { id } = identity; const timestamp = now();
    const task = { ...identity, ...metadata, accountId, sourceType, sourceId,
      sku: sourceType === "EXCEL" ? sourceId : "", name: "", thumbnail: "", source: null, config,
      status: "QUEUED", images: [], approved: false, errorMessage: null, submissionId: null, submissionStarted: false,
      submissionKey: `ai-listing-submit-${digest([accountId, id])}`, createdAt: timestamp, updatedAt: timestamp, nextRunAt: timestamp };
    if (source && sourceType === "COLLECT_BOX" && collectEnrichmentPending(source)) {
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
      const { owners, createdTaskIds } = await repository.createCollectorAutomatic({ accountId, skus, prepare: async missingSkus => {
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
              const subset = { ...structuredClone(source), items: source.items.filter(item => chunk.includes(item.sku)) };
              subset.thumbnail = subset.items[0]?.images?.[0] || '';
              prepared.push(await createTask({ accountId, config, selectedSkus: chunk,
                idempotencyKey: `collector-auto-${runId}-${digest(chunk)}` }, 'COLLECT_BOX', origin.collectItemId, subset,
              { collectorAuto: { runId, groupId: group.groupId, skus: chunk } }, true));
            }
            tasks.push(...prepared);
            for (const sku of selected) missing.delete(sku);
          } catch (error) {
            if (!['AI_LISTING_SOURCE_NOT_FOUND','AI_LISTING_SOURCE_PLATFORM_MISMATCH','AI_LISTING_LOGISTICS_REQUIRED','ZONGZI_IMPORT_LOGISTICS_REQUIRED','AI_LISTING_SKU_LIMIT','AI_LISTING_INVALID_INPUT','AI_LISTING_ALREADY_LISTED','AI_LISTING_SELECTION_CHANGED'].includes(error?.code)) throw error;
            for (const sku of requested) skuErrors.set(sku, error);
          }
        }
        return tasks;
      } });
      const created = new Set(createdTaskIds), allTasks = new Map(), errors = [];
      const results = groups.map(group => {
        const tasks = new Map(group.skus.flatMap(sku => owners.has(sku) ? [[owners.get(sku).id, owners.get(sku)]] : []));
        for (const [id, task] of tasks) allTasks.set(id, task);
        const unprocessedSkus = group.skus.filter(sku => !owners.has(sku));
        if (unprocessedSkus.length) {
          const causes = unprocessedSkus.map(sku => skuErrors.get(sku)).filter(Boolean), error = causes[0];
          errors.push({ collectItemId: group.collectItemId, skus: unprocessedSkus, definitelyNotCreated: true,
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
    async getTask(input) { return dto(await find(input)); },
    async retryTask(input) {
      const task = await find(input);
      if (!failureStates.has(task.status)) throw problem("AI_LISTING_TASK_CONFLICT", "当前任务不能重试", 409);
      delete task.priceFailure;
      if (task.importBatchId && task.status === "COLLECTION_FAILED") {
        task.source=null;task.images=[];task.importGrouped=false;
        task.collectionAttempt = (task.collectionAttempt || 0) + 1;
        delete task.collectionJobId; delete task.collectionEnrichmentSource; delete task.collectionStage;
      }
      task.submissionStarted = task.submissionStarted || submissionStarted.has(task.status);
      if (task.submissionStarted) task.submissionRetryAttempt = (task.submissionRetryAttempt || 0) + 1;
      for (const image of task.images) if (!image.generatedUrl) {
        image.status = "PENDING"; image.attempts = 0; image.retryAt = null; image.channelAttempts=[]; image.excludeChannelIds=[]; image.activeAttemptId=null;
      }
      task.extraImageAttempts = 0; task.consecutiveImageFailures = 0;
      task.status = !task.source ? "QUEUED" : task.images.some(image => !image.generatedUrl) ? "GENERATING"
        : task.config.manualReview && !task.approved ? "AWAITING_REVIEW" : "READY_TO_SUBMIT";
      if (task.importBatchId && !task.source) task.importGrouped=false;
      task.errorMessage = null; task.nextRunAt = now();
      return actionSave(task);
    },
    async cancelTask(input) {
      const task = await find(input);
      if (task.status === "CANCELLED") return dto(task);
      if (task.submissionStarted || submissionStarted.has(task.status)) throw problem("AI_LISTING_TASK_CONFLICT", "上架提交已开始，不能取消已发送的请求", 409);
      task.status = "CANCELLED"; task.errorMessage = null;
      return actionSave(task);
    },
    async approveTask(input) {
      const task = await find(input);
      if (task.status !== "AWAITING_REVIEW") throw problem("AI_LISTING_TASK_CONFLICT", "当前任务不在待审核状态", 409);
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
      async function checkpoint(releaseLease = false) {
        if (leaseLost) throw lostLease;
        task.updatedAt = now();
        const saved = await repository.save({ task, expectedVersion: task.version, leaseToken, now: now(), releaseLease });
        if (!saved) throw lostLease;
        task = saved;
        if (releaseLease && task.importBatchId && !task.importGrouped) {
          await groupImport(task);
          task = await find({accountId:task.accountId,taskId:task.id});
        }
        if ((!task.collectWait || task.source) && (!task.importBatchId || task.importGrouped)) await billing?.reconcile({accountId:task.accountId,taskId:task.id});
      }
      async function assertActive() {
        if (leaseLost) throw lostLease;
        const scope = { accountId: task.accountId, taskId: task.id, leaseToken, now: now(), expectedVersion: task.version };
        const active = repository.ownsLease ? await repository.ownsLease(scope)
          : await repository.get(scope).then(row => row?.leaseToken === leaseToken && row.version === task.version && row.status !== "CANCELLED");
        if (!active) { leaseLost = true; throw lostLease; }
      }
      async function releaseChannel() {
        const channel = productChannel; productChannel = null;
        if (channel) await channel.release();
      }
      async function fail(status, message, priceFailure) {
        task.status = status; task.errorMessage = message;
        if(priceFailure)task.priceFailure=structuredClone(priceFailure);
        await checkpoint(true); return dto(task);
      }
      try {
        if (task.status === "SUBMITTING") return await fail("SUBMISSION_UNCERTAIN", "上次提交结果未知，请重试以查询或恢复同一上架请求");
        if (task.status === "SUBMITTED") {
          let result;
          try { result = await readSubmission({ accountId: task.accountId, submissionId: task.submissionId }); }
          catch { task.nextRunAt = now() + POLL_MS; task.errorMessage = "暂时无法查询上架结果，将继续查询"; await checkpoint(true); return dto(task); }
          if (result?.items) task.submissionResults = result.items;
          if (["COMPLETED", "SUCCEEDED"].includes(result?.status)) { task.status = "COMPLETED"; task.errorMessage = null; }
          else if (result?.status === "FAILED") return await fail("SUBMISSION_FAILED", "部分商品上架失败，请检查逐 SKU 结果后重试失败项；类目错误请先重新确认类目，成功商品不会重提");
          else if (result?.status === "UNCERTAIN") return await fail("SUBMISSION_UNCERTAIN", "提交结果待核实，已按商品货号查询；未确认商品不会自动重复创建");
          else { task.nextRunAt = now() + (Number.isSafeInteger(result?.retryAfterMs)
            ? Math.min(300_000, Math.max(POLL_MS, result.retryAfterMs)) : POLL_MS); }
          await checkpoint(true); return dto(task);
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
            if (error === lostLease) throw error;
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
          await checkpoint();
        }
        if (phase === "prepare" || (task.importBatchId && !task.importGrouped)) {
          task.nextRunAt=now()+COLLECT_POLL_MS;await checkpoint(true);return dto(task);
        }
        if (task.images.some(image => !image.generatedUrl)) {
          if (checkSource) task.source = await checkSource({accountId:task.accountId,source:task.source,config:listingConfig(task.config)});
        }
        await checkRestrictions?.({accountId:task.accountId,source:task.source,config:listingConfig(task.config),stage:"generate"});
        const funding=await billing?.reconcile({accountId:task.accountId,taskId:task.id,reserve:true});
        if(funding&&!funding.funded){task.status='GENERATING';task.errorMessage=funding.message;task.nextRunAt=now()+30_000;await checkpoint(true);return dto(task);}
        // A crashed request may have reached the paid provider; explicit user retry is required.
        if (task.images.some(image => image.status === "GENERATING" && !image.generatedUrl)) {
          return await fail("GENERATION_FAILED", "上次图片请求结果未知，已保留成功图片，请重试未完成图片");
        }
        if (reserveChannel && task.images.some(image => !image.generatedUrl)) {
          try {
            productChannel = await reserveChannel({ accountId: task.accountId, taskId: task.id, capacity,
              excludeChannelIds: task.images.find(image => !image.generatedUrl)?.excludeChannelIds || [] });
          } catch (error) {
            if (!["AI_GATEWAY_NO_CAPACITY", "AI_LISTING_PRODUCT_ALREADY_RESERVED"].includes(error.code)) throw error;
            task.status = "GENERATING"; task.generationStage = "waiting_channel";
            task.errorMessage = "等待可用商品通道或服务器处理名额"; task.nextRunAt = now() + POLL_MS;
            await checkpoint(true); return dto(task);
          }
        }
        for (let position = 0; position < task.images.length; position++) {
          if (task.images[position].generatedUrl) continue;
          const candidate = task.images[position];
          const grid = task.config.generationMode === "GRID";
          // One leader owns the SKU retry state. Followers never send a second request.
          const positions = grid ? task.images.map((item, i) => item.sku === candidate.sku && !item.generatedUrl ? i : -1).filter(i => i >= 0) : [position];
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
            const input = { accountId: task.accountId, taskId: task.id, sku: image.sku, index: image.index,
              sourceUrl: image.sourceUrl, prompt: task.config.prompt, image: structuredClone(task.config.image),
              requestKey: `${image.requestKey}:${image.activeAttemptId}`, excludeChannelIds: image.excludeChannelIds || [],
              ...(productChannel ? { channelId: productChannel.channelId, productToken: productChannel.productToken,
                beforeRequest: assertActive, onProgress: async stage => { task.generationStage = stage; await checkpoint(); } } : {}) };
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
            if (error === lostLease) throw error;
            if (error.deliveryState === "POSSIBLY_SENT" || error.details?.deliveryState === "POSSIBLY_SENT") {
              image.status = "GENERATION_FAILED"; image.retryAt = null;
              image.lastError = { code: error.code || "AI_LISTING_IMAGE_RESULT_UNKNOWN", occurredAt: new Date(now()).toISOString() };
              return await fail("GENERATION_FAILED", "图片请求结果未知，可能已经生成或计费；请先核实请求结果，成功图片已保留");
            }
            if(error.code==="AI_GATEWAY_NO_CAPACITY"||(error.code==="AI_LISTING_WORKER_STOPPING"&&error.deliveryState==="NOT_SENT")) {
              image.attempts=Math.max(0,image.attempts-1);image.status="PENDING";image.activeAttemptId=null;
              // No request was sent. Keep waiting without spending an attempt.
              // A later round can probe cooled channels if all alternatives were tried.
              image.excludeChannelIds=[];
              task.generationStage="waiting_channel";
              task.errorMessage=error.code==="AI_LISTING_WORKER_STOPPING"?"后台正在切换，已保存成功图片，等待继续":"等待可用通道：健康通道忙碌或暂不可用，恢复后自动继续";
              task.nextRunAt=now()+15_000;
              await checkpoint(true);return dto(task);
            }
            if(error.channelId && error.stage!=="upload") {
              image.channelAttempts=[...(image.channelAttempts||[]),{channelId:error.channelId,attemptId:image.activeAttemptId,code:error.code,at:now()}];
              image.excludeChannelIds=[...new Set([...(image.excludeChannelIds||[]),error.channelId])];
              image.lastError={code:error.code,occurredAt:new Date(now()).toISOString()};
              image.status="GENERATION_FAILED";image.errorMessage="通道请求失败，准备切换其他可用通道";
              if(image.channelAttempts.length>=3){image.retryAt=null;await checkpoint();continue;}
              image.retryAt=now();
              task.nextRunAt=now();task.errorMessage="图片请求失败，正在切换可用通道继续";
              await checkpoint(true);return dto(task);
            }
            if (error.generationConfig) image.generationConfig = error.generationConfig;
            image.lastError = {
              code: /^[A-Z][A-Z0-9_]{0,100}$/.test(error?.code || "") ? error.code : "AI_LISTING_IMAGE_FAILED",
              requestId: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(error?.requestId || "") ? error.requestId : null,
              occurredAt: new Date(now()).toISOString(),
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
          for (const target of positions) {
          const output = grid ? result.images.find(item => item.index === task.images[target].index) : result;
          Object.assign(task.images[target], { errorMessage: null, lastError: null, retryAt: null, generatedUrl: output.generatedUrl, status: "COMPLETED",
            ...(output.generationConfig ? { generationConfig: output.generationConfig } : {}),
            ...(output.objectKey ? { objectKey: output.objectKey } : {}), ...(output.contentType ? { contentType: output.contentType } : {}) });
          }
          await checkpoint();
        }
        const missing = task.images.filter(image => !image.generatedUrl);
        if (missing.length) {
          const retries = missing.filter(image => image.retryAt && (task.extraImageAttempts || 0) < 3);
          if (retries.length) {
            task.status = "GENERATING";
            task.nextRunAt = Math.min(...retries.map(image => image.retryAt));
            task.errorMessage = "部分图片失败，成功图片已保留；等待自动补试（每张最多一次）";
            await checkpoint(true); return dto(task);
          }
          return await fail(missing.some(image => image.status === "UPLOAD_FAILED") ? "UPLOAD_FAILED" : "GENERATION_FAILED",
            missing.some(image=>image.channelAttempts?.length>=3)?"部分图片已尝试三次，已保留成功图片，请检查通道后手动重试":missing[0].errorMessage || "仍有图片未完成，成功图片已保留，请重试");
        }
        task.generationStage = null;
        await releaseChannel();
        if (task.config.manualReview && !task.approved) {
          task.status = "AWAITING_REVIEW"; task.errorMessage = null; await checkpoint(true); return dto(task);
        }
        if (phase === "generate") {
          task.status="READY_TO_SUBMIT";task.errorMessage=null;task.nextRunAt=now();await checkpoint(true);return dto(task);
        }
        // Persist intent before crossing the external-write boundary. Cancellation is no longer offered after this CAS.
        const commitTarget=async target=>{
          await checkRestrictions?.({accountId:task.accountId,source:task.source,config:{...listingConfig(task.config),...target},stage:"submit"});
          if(target)task.submissionTarget=target;
          task.submissionStarted=true;task.status="SUBMITTING";task.errorMessage=null;await checkpoint();
        };
        if(task.config.autoSwitchStores && !task.submissionStarted){
          const result=await routeStores({task,commit:commitTarget});
          if(!result.selected){task.status="READY_TO_SUBMIT";task.errorMessage=result.message;task.nextRunAt=now()+300_000;await checkpoint(true);return dto(task);}
        }else await commitTarget();
        let submission;
        try {
          submission = await submitListing({ accountId: task.accountId, taskId: task.id, idempotencyKey: task.submissionKey,
            retryAttempt: task.submissionRetryAttempt || 0,
            config: {...listingConfig(task.config),...task.submissionTarget}, source: structuredClone(task.source),
            images: task.images.map(({ sku, index, sourceUrl, generatedUrl }) => ({ sku, index, sourceUrl, generatedUrl })) });
          if (!submission?.submissionId) throw invalid();
        } catch (error) {
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
        task.submissionId = submission.submissionId; task.status = "SUBMITTED"; task.errorMessage = null; task.nextRunAt = now() + POLL_MS;
        await checkpoint(true); return dto(task);
      } catch (error) {
        if(error?.priceValidationFailure===true)return await fail('GENERATION_FAILED',error.message);
        if(error?.code==='PRICE_FINAL_NOT_POSITIVE')return await fail('GENERATION_FAILED',error.priceFailure?error.message:'最终售价不大于 0，本商品已跳过上架，尚未开始生图；其他商品继续处理。',error.priceFailure||{code:error.code,sku:task.sku});
        if(error?.code==='AI_LISTING_CURRENCY_CONVERSION_REQUIRED')return await fail('GENERATION_FAILED','来源与目标店铺币种不同，缺少可靠汇率；请确认币种后重试');
        if (error?.code === "AI_LISTING_CATEGORY_UNRESOLVED") return await fail("GENERATION_FAILED", "商品类目尚未确认，请根据任务保留的来源重新确认类目映射后重试，成功图片已保留");
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
