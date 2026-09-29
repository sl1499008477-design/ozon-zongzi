import { amountToMinorUnits, kopecksToRubles } from "./auto-listing-config.js";
import { displaySalePriceFormula } from "../../shared/sale-pricing.mjs";

export const AI_LISTING_DEFAULT_PROMPT = "请根据这套商品图片重新生成一份适用于 ozon 的全新商品图，产品主体以及产品上的文字、logo 等信息保持不变，生成数量跟这套商品图相同，不要移除图片中既有的卖点、材质、规格型号等信息";

export const AI_LISTING_FORM_DEFAULTS = Object.freeze({
  targetStoreId: "",
  targetWarehouseId: "",
  stock: 5,
  priceAdjustmentAmount: "0",
  priceMultiplier: "1",
  brandMode: "FORCE_NO_BRAND",
  manualReview: false,
  generationMode: "GRID",
  image: Object.freeze({ ratio: "3:4", language: "ru", resolution: "2K", quality: "high" }),
  prompt: AI_LISTING_DEFAULT_PROMPT,
});

const IMAGE_OPTIONS = Object.freeze({
  ratio: new Set(["1:1", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9"]),
  language: new Set(["ru", "en", "zh"]),
  resolution: new Set(["1K", "2K", "4K"]),
  quality: new Set(["low", "medium", "high", "auto"]),
});
const RETRYABLE = new Set([
  "COLLECTION_FAILED", "GENERATION_FAILED", "UPLOAD_FAILED", "SUBMISSION_FAILED", "SUBMISSION_UNCERTAIN",
]);
const NOT_CANCELLABLE = new Set([
  "SUBMITTING", "SUBMITTED", "COMPLETED", "SUBMISSION_FAILED", "SUBMISSION_UNCERTAIN", "CANCELLED",
]);

function stateError(code) {
  return Object.assign(new Error(code), { code });
}

function requiredId(value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > 200 || /[\u0000-\u001f\u007f]/u.test(result)) {
    throw stateError("AI_LISTING_CONFIG_INVALID");
  }
  return result;
}

export function aiListingCurrency(value) {
  const code = String(value || "").trim().toUpperCase();
  if (code === "CNY") return Object.freeze({ code, symbol: "¥", name: "人民币" });
  if (code === "RUB") return Object.freeze({ code, symbol: "₽", name: "卢布" });
  throw stateError("AI_LISTING_CURRENCY_UNSUPPORTED");
}

export function isAiListingPriceSkipped(task = {}) {
  return (task.status === "GENERATION_FAILED" || task.status === "SUBMISSION_FAILED") && task.priceFailure?.code === "PRICE_FINAL_NOT_POSITIVE"
    && !task.submissionId && !task.submissionResults?.length;
}

const TASK_STATUS_LABELS = {
  QUEUED: "排队中", COLLECTING: "采集中", GENERATING: "AI 生图中", AWAITING_REVIEW: "等待人工审核",
  READY_TO_SUBMIT: "等待提交", SUBMITTING: "正在提交", SUBMITTED: "已提交，等待结果", COMPLETED: "上架完成",
  COLLECTION_FAILED: "采集失败", GENERATION_FAILED: "生图失败", UPLOAD_FAILED: "图片保存失败",
  SUBMISSION_FAILED: "提交失败", SUBMISSION_UNCERTAIN: "提交结果待确认", CANCELLED: "已取消", PAUSED: "已暂停",
};
const TASK_STATUS_COLORS = {
  QUEUED: "default", COLLECTING: "processing", GENERATING: "processing", AWAITING_REVIEW: "gold",
  READY_TO_SUBMIT: "blue", SUBMITTING: "processing", SUBMITTED: "cyan", COMPLETED: "green",
  COLLECTION_FAILED: "red", GENERATION_FAILED: "red", UPLOAD_FAILED: "red", SUBMISSION_FAILED: "red",
  SUBMISSION_UNCERTAIN: "orange", CANCELLED: "default", PAUSED: "gold",
};
const GENERATION_STEP_DESCRIPTIONS = {
  queued: "已进入生图队列，轮到后自动开始。",
  waiting_product: "等待同批商品资料齐全后继续。",
  waiting_channel: "等待空闲 AI 通道或服务器处理名额，释放后自动继续。",
  waiting_source: "等待 Ozon 类目服务恢复，系统将自动重试，已有进度保留。",
  preparing: "正在准备原图并识别图片文字。",
  image: "正在调用 AI 生成图片。",
  slicing: "正在裁切生成结果。",
  saving: "正在保存生成图片。",
};
const SUBMISSION_WAIT_LABELS = {
  DAILY_LIMIT:'等待每日额度',DAILY_UPDATE_LIMIT:'等待每日更新额度',TOTAL_LIMIT:'店铺总容量不足',
  QUOTA_UNAVAILABLE:'额度暂时无法确认',QUOTA_UNKNOWN:'额度暂时无法确认',RATE_LIMIT:'请求频率受限',STORE_QUEUE:'等待店铺提交',
  RESERVED_CAPACITY:'等待店铺提交',RESULT_PENDING:'提交结果待确认',GROUP_EXCEEDS_DAILY_LIMIT:'额度不足，需处理',
  TARGET_UNAVAILABLE:'店铺或仓库待确认',
};
const SUBMISSION_WAIT_DESCRIPTIONS = {
  DAILY_LIMIT:'确认每日新增额度可用后继续，已有图片和成功 SKU 保留。',
  DAILY_UPDATE_LIMIT:'确认每日更新额度可用后继续，已有图片和成功 SKU 保留。',
  TOTAL_LIMIT:'需要先释放店铺商品容量，确认容量可用后继续。',
  QUOTA_UNAVAILABLE:'系统将重新查询店铺额度，已有进度保留；查询失败不代表额度已用完。',
  QUOTA_UNKNOWN:'系统将重新查询店铺额度，已有进度保留；查询失败不代表额度已用完。',
  RATE_LIMIT:'等待请求频率限制解除后继续，已有进度保留。',
  STORE_QUEUE:'等待同店铺前序商品确认导入结果后，按提交队列继续。',
  RESERVED_CAPACITY:'等待同店铺前序商品处理后，按提交队列继续。',
  RESULT_PENDING:'继续核对原提交结果，确认前不会重复创建商品或切换店铺。',
  TARGET_UNAVAILABLE:'系统将重新检查目标店铺和仓库，确认可用后继续；已有进度保留。',
  GROUP_EXCEEDS_DAILY_LIMIT:'当前商品组无法按原额度安排提交，请查看具体原因后处理。',
};

export const AI_LISTING_DELETED_RECOVERY_DESCRIPTION='恢复后回到原失败状态，其他任务回到已暂停；不会自动继续。请在对应分组查看结果，再手动重试或恢复继续。';
export const AI_LISTING_DELETED_RETENTION_DESCRIPTION='已删除任务保留 15 天。清理开始前可以恢复；满 15 天后，关联采集商品若没有其他 SKU 或任务继续使用会一并删除，并清理专属图片、视频和衍生资料；共享素材、已上架商品正在使用的素材和必要的账务/提交记录会保留；提交结果未知不影响永久删除，相关回执和可能在用的素材会保留。';

export function aiListingPurgeDetailEvidence(task,{taskId,scopeKey}={}) {
  const version=task?.version;
  if(!String(scopeKey||'') || String(task?.id||'')!==String(taskId||'') || !Number.isSafeInteger(version)
    || !task?.deletedAt || !['PENDING','RUNNING','FAILED'].includes(task?.purge?.state))return null;
  return {taskId:String(taskId),scopeKey:String(scopeKey),version};
}

export function shouldClosePurgedAiListingDetail({error,taskId,scopeKey,accepted}={}) {
  return Number(error?.status)===404 && String(taskId||'')===String(accepted?.taskId||'')
    && String(scopeKey||'')===String(accepted?.scopeKey||'') && Number.isSafeInteger(accepted?.version);
}

export function aiListingTaskStatus(task = {}) {
  if(task.deletedAt && task.purge?.state==='PENDING')return {
    label:'排队中',color:'default',description:'永久清理请求已接受，正在等待后台处理，尚未完成清理。',
  };
  if(task.deletedAt && task.purge?.state==='RUNNING')return {
    label:'正在清理',color:'processing',description:'正在核对共享文件并清理关联采集商品和专属媒体，尚未完成清理。',
  };
  if(task.deletedAt && task.purge?.state==='FAILED')return {
    label:'清理失败',color:'red',description:task.purge.errorMessage || '永久清理未完成，请重试。',
  };
  if(task.deletedAt)return {label:'已删除',color:'default',description:AI_LISTING_DELETED_RECOVERY_DESCRIPTION};
  if(task.controlAction) return {label:{pause:'正在暂停',cancel:'正在取消',delete:'正在删除'}[task.controlAction] || '正在停止',
    color:'gold',description:'正在接收并保存当前请求的结果，随后停止后续处理。'};
  let label = TASK_STATUS_LABELS[task.status] || task.status || "状态待确认";
  let description = "";
  if(task.status==='PAUSED') description=task.submissionId
    ?'已暂停本任务后续上架和库存写入；已发送到 Ozon 的请求不会撤回，系统仍可核对其结果。恢复后继续原提交记录。'
    :'已保存当前进度，恢复后按队列继续；已开始生图的商品优先补齐。';
  if(task.status==='SUBMISSION_UNCERTAIN')description=SUBMISSION_WAIT_DESCRIPTIONS.RESULT_PENDING;
  if (isAiListingPriceSkipped(task)) label = "售价无效，已跳过";
  else if (task.status === "COLLECTING" && task.sourceType === "COLLECT_BOX") {
    label = "等待资料补全";
    description = "等待商品类目、包装重量和尺寸等资料补全后继续。";
  } else if (task.status === "COLLECTING" && task.collectionStage) {
    label = { waiting_extension: '等待扩展采集', capturing: '采集中', waiting_seller: '等待资料补全' }[task.collectionStage] || label;
    description = task.errorMessage || '';
  } else if (task.status === "GENERATING") {
    label = { queued:"等待生图", waiting_channel:"等待生图", waiting_product:"等待资料补全", waiting_source:"等待类目服务",
      preparing:"准备图片中", image:"AI 生图中", slicing:"裁切图片中", saving:"保存图片中" }[task.generationStage] || "等待生图";
    description = GENERATION_STEP_DESCRIPTIONS[task.generationStage] || "正在处理商品图片。";
    if(task.generationStage==='waiting_source' && task.errorMessage) description=task.errorMessage;
  }
  if(task.status==="SUBMITTING"&&task.submissionStage==="preparing_media"){
    label="准备上架素材中";description="正在准备图片和视频，完成后进入提交队列。";
  }else if(task.status==="SUBMITTED"&&task.submissionStage==="submitting")label="正在提交";
  else if(task.status==="SUBMITTED"&&task.submissionStage==="waiting_submit")label="等待提交";
  if(task.status==='SUBMISSION_FAILED'&&(task.submissionStage==='image_failed'||task.submissionResults?.some(row=>row.publicationStatus==='IMAGE_FAILED'))){
    label='图片接收失败';description='已生成图片保留；重试会重传失败 SKU 的完整图片组，完成后继续设置库存。';
  }else if(['SUBMITTED','SUBMISSION_UNCERTAIN'].includes(task.status)&&(task.submissionStage==='repairing_images'||task.submissionResults?.some(row=>row.publicationStatus==='IMAGE_REPAIR_PENDING'))){
    label=task.status==='SUBMISSION_UNCERTAIN'?'图片重传结果未知':'图片重传处理中';
    description=task.status==='SUBMISSION_UNCERTAIN'?'正在核对原商品的图片处理结果，不重复发送图片。':'正在等待 Ozon 处理图片，完成后继续设置库存。';
  }
  let color = TASK_STATUS_COLORS[task.status] || 'default';
  if(task.status==='GENERATING' && task.generationStage==='waiting_source') color='gold';
  const wait=task.submissionWait || task.quotaWait;
  const waitActive=wait && !(task.status==='GENERATING'&&task.generationStage==='waiting_source') && (['GENERATING','READY_TO_SUBMIT','SUBMITTING','SUBMITTED'].includes(task.status)
    || wait.code==='RESULT_PENDING' && task.status==='SUBMISSION_UNCERTAIN'
    || wait.code==='GROUP_EXCEEDS_DAILY_LIMIT' && ['GENERATION_FAILED','SUBMISSION_FAILED'].includes(task.status));
  if(waitActive){
    label=SUBMISSION_WAIT_LABELS[wait.code] || '等待店铺提交';
    const recovery=SUBMISSION_WAIT_DESCRIPTIONS[wait.code] || '已保留当前进度，请查看具体等待原因。';
    description=wait.message || task.errorMessage || recovery;
    color=wait.code==='GROUP_EXCEEDS_DAILY_LIMIT'?'red':'gold';
    if(Number.isFinite(wait.retryAt)&&wait.retryAt>0){
      const time=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(wait.retryAt));
      description+=` 下次检查：${time}（北京时间）。${description===recovery?'':recovery}`;
    }
  }
  const results=task.submissionResults||[];
  if(waitActive){
    const skipped=new Set((task.skuProgress||[]).filter(row=>row.status==='SKIPPED').map(row=>row.sku));
    const eligibleResults=results.filter(row=>!skipped.has(row.sku));
    const created=Number.isSafeInteger(task.createdSkuCount) ? task.createdSkuCount
      : eligibleResults.filter(row=>row.importStatus==='SUCCEEDED'||row.isCreated===true||/^[1-9]\d*$/.test(String(row.productId||''))).length;
    const total=Number.isSafeInteger(task.totalSkuCount) ? task.totalSkuCount
      : (task.skuProgress||task.source?.items||[]).filter(row=>!skipped.has(row.sku)).length
        || Number(task.skuCount) || eligibleResults.length;
    if(created>0&&total>created){
      const remainingLabel={TOTAL_LIMIT:'等待店铺容量',RATE_LIMIT:'等待请求频率限制解除'}[wait.code] || label;
      label=`已创建 ${created}/${total}，剩余 ${total-created} 个${remainingLabel}`;
    }
  }
  const completed=Number(task.completedSkuCount??results.filter(row=>row.stockStatus==='COMPLETED').length);
  const failed=Number(task.failedSubmissionSkuCount??results.filter(row=>row.importStatus==='FAILED'||row.stockStatus==='FAILED').length);
  const pending=Number(task.pendingSubmissionSkuCount??results.filter(row=>row.importStatus!=='FAILED'&&row.stockStatus!=='FAILED'
    &&(row.importStatus==='PENDING'||row.stockStatus==='PENDING')).length);
  const warnings=Number(task.publicationWarningSkuCount??results.filter(row=>row.publicationWarnings?.length||row.publicationCheck?.isCreated===false||row.publicationCheck?.isArchived===true).length);
  if(task.status==='COMPLETED'&&warnings)return {label:'库存完成，卡片待核查',color:'gold',description:'库存已设置；Ozon 商品卡片仍有警告，请查看逐 SKU 平台状态。'};
  if(completed||failed||pending){
    description=`库存完成 ${completed} / 失败 ${failed} / 等待 ${pending}。${description||label}。${task.errorMessage||''}`;
    if(completed&&!waitActive&&!['COMPLETED','PAUSED','CANCELLED','SUBMISSION_UNCERTAIN'].includes(task.status)){label='部分待处理';color='gold';}
  }
  return { label, color, description };
}

function publicationWarningMessages(row = {}) {
  const details = row.publicationWarningDetails || [];
  const detailedCodes = new Set(details.map(warning => warning.code));
  const warnings = [...details, ...(row.publicationWarnings || [])
    .filter(code => !detailedCodes.has(code)).map(code => ({ code }))];
  if (!warnings.length) return row.warningMessage ? [row.warningMessage] : [];
  return warnings.map(warning => {
    const label = {
      warning_attribute_values_out_of_range: '属性值超出 Ozon 允许范围',
      pics_reading_timeout: 'Ozon 下载部分商品图片超时，请重新上传图片',
      primary_image_load_failed: 'Ozon 主图接收失败，请核对图片',
      some_image_failed: 'Ozon 未能完整接收商品图片，请核对图片',
    }[warning.code] || warning.code || 'Ozon 商品卡片警告';
    const attributeId = warning.attribute_id;
    const attributeName = warning.attribute_name || warning.texts?.attribute_name;
    const attribute = attributeId || attributeName
      ? `属性 ${[attributeId, attributeName].filter(Boolean).join(' · ')}`
      : warning.code === 'warning_attribute_values_out_of_range' ? '未记录具体属性，请在 Ozon 商品卡片查看详情' : '';
    const messages = [...new Set([warning.message, warning.description, warning.hint,
      warning.texts?.message, warning.texts?.description, warning.texts?.hint]
      .filter(value => typeof value === 'string' && value.trim()))];
    return [label, attribute, warning.field ? `字段 ${warning.field}` : '', ...messages].filter(Boolean).join('；');
  });
}

export function aiListingSubmissionNotices(results = []) {
  const info = [], warnings = [];
  for (const message of results.flatMap(row => row.normalizationWarnings || [])) {
    // Saved submissions carry text notices; preserve unknown messages as warnings.
    const informational = /未记录来源状态，待核实|待核实，当前来源未能确认用途或 SKU|源未提供（可编辑补充）|当前类目另有 \d+ 项可选属性未提交/.test(message);
    (informational ? info : warnings).push(message);
  }
  for (const row of results) {
    for (const message of publicationWarningMessages(row)) warnings.push(`SKU ${row.sku || row.offerId}：${message}`);
  }
  return {info, warnings};
}

export function aiListingCollectionSource(task = {}) {
  const source = task.collectionSource;
  const type = source?.type || (task.sourceType === "EXCEL" ? "EXCEL" : "COLLECT_BOX");
  const label = {COLLECTOR_ASSISTANT:"Ozon 采集助手", WEB_EXTENSION:"网页链接（扩展采集）",
    EXTENSION:"浏览器扩展", EXCEL:"Excel 导入", COLLECT_BOX:"采集箱（历史来源未记录）"}[type] || "采集箱（历史来源未记录）";
  return {label, taskNames:source?.taskNames || []};
}

export function aiListingPriceFailureMessage(task = {}) {
  if (!isAiListingPriceSkipped(task)) return "";
  const failure = task.priceFailure;
  if(failure.salePriceFormula)return `SKU ${failure.sku||task.sku}：按售价配置「${failure.salePricingName||"原配置"}」的公式 ${displaySalePriceFormula(failure.salePriceFormula)} 计算结果不大于 0，已跳过上架。`;
  try {
    const currency = aiListingCurrency(failure.currency).code;
    const realPrice = kopecksToRubles(String(failure.realPriceKopecks));
    const adjustment = kopecksToRubles(String(failure.priceAdjustmentKopecks));
    if (failure.priceMultiplier === undefined || failure.priceMultiplier === null) throw new Error("missing multiplier");
    return `SKU ${failure.sku || task.sku}：最终售价 =（竞品真实售价计算 ${realPrice} ${currency} + 售价加减 ${adjustment} ${currency}）× ${failure.priceMultiplier}，不大于 0，已跳过上架。`;
  } catch {
    return task.errorMessage || "按任务原公式计算的最终售价不大于 0，已跳过此商品上架。";
  }
}

export function aiListingCreationFeedback(result = {}, collectItemIds = null) {
  const tasks = Array.isArray(result?.tasks) ? result.tasks : [];
  const errors = Array.isArray(result?.errors) ? result.errors : [];
  const retryCollectItemIds = collectItemIds === null ? null : collectItemIds.filter(id =>
    errors.some(error => error.collectItemId === id && error.definitelyNotCreated === true && error.retryable !== false));
  return {
    tasks, errors, retryCollectItemIds,
    level: !tasks.length ? "error" : errors.length ? "warning" : "success",
    message: !tasks.length ? (errors.length ? `未创建任务，${errors.length} 项未成功` : "未创建任务，请刷新任务后核对结果")
      : errors.length ? `已创建 ${tasks.length} 个任务，${errors.length} 项未创建` : "任务已创建",
  };
}

export function serializeAiListingConfig(values = {}) {
  const generationMode = values.generationMode ?? "SINGLE";
  if (!["SINGLE","GRID"].includes(generationMode)) throw stateError("AI_LISTING_CONFIG_INVALID");
  const image = { ...AI_LISTING_FORM_DEFAULTS.image, ...(values.image || {}) };
  if (generationMode === "GRID") Object.assign(image, {ratio:"3:4",resolution:"1K"});
  if (Object.entries(image).some(([key, value]) => !IMAGE_OPTIONS[key]?.has(value))) {
    throw stateError("AI_LISTING_CONFIG_INVALID");
  }
  const stock = values.stock ?? AI_LISTING_FORM_DEFAULTS.stock;
  const multiplier = String(values.priceMultiplier ?? AI_LISTING_FORM_DEFAULTS.priceMultiplier).trim();
  if (!Number.isSafeInteger(stock) || stock < 0 || !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u.test(multiplier)
    || !/[1-9]/u.test(multiplier)) {
    throw stateError("AI_LISTING_PRICE_MULTIPLIER_INVALID");
  }
  let minorText;
  try {
    minorText = amountToMinorUnits(String(values.priceAdjustmentAmount ?? "0"));
  } catch {
    throw stateError("AI_LISTING_PRICE_ADJUSTMENT_INVALID");
  }
  const priceAdjustmentKopecks = Number(minorText);
  if (!Number.isSafeInteger(priceAdjustmentKopecks)) {
    throw stateError("AI_LISTING_PRICE_ADJUSTMENT_INVALID");
  }
  const brandMode = values.brandMode ?? AI_LISTING_FORM_DEFAULTS.brandMode;
  const manualReview = values.manualReview ?? AI_LISTING_FORM_DEFAULTS.manualReview;
  const prompt = String(values.prompt ?? AI_LISTING_DEFAULT_PROMPT);
  if (!new Set(["FORCE_NO_BRAND", "PREFER_SOURCE"]).has(brandMode)
    || typeof manualReview !== "boolean" || !prompt.trim() || prompt.length > 20_000) {
    throw stateError("AI_LISTING_CONFIG_INVALID");
  }
  return Object.freeze({
    ...(values.autoSwitchStores ? {autoSwitchStores:true,fallbackStores:(values.fallbackStores||[]).map(row=>({targetStoreId:requiredId(row.targetStoreId),targetWarehouseId:requiredId(row.targetWarehouseId)}))} : {}),
    targetStoreId: requiredId(values.targetStoreId),
    targetWarehouseId: requiredId(values.targetWarehouseId),
    stock,
    ...(values.salePricingId ? {salePricingId:requiredId(values.salePricingId),salePricingUpdatedAt:values.salePricingUpdatedAt,...(values.realPricingUpdatedAt?{realPricingId:values.realPricingId,realPricingUpdatedAt:values.realPricingUpdatedAt}:{})} : {}),
    priceAdjustmentKopecks:values.salePricingId?0:priceAdjustmentKopecks,
    priceMultiplier:values.salePricingId?"1":multiplier,
    brandMode,
    manualReview,
    generationMode,
    image: Object.freeze(image),
    prompt,
  });
}

export function collectItemIdsFromSearch(search = "") {
  const params = new URLSearchParams(String(search || ""));
  if (params.get("source") !== "collect") return [];
  const seen = new Set();
  const ids = [];
  for (const value of String(params.get("ids") || "").split(",")) {
    const id = value.trim();
    if (!id || id.length > 200 || /[\u0000-\u001f\u007f]/u.test(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length === 100) break;
  }
  return ids;
}

export function groupAiListingImages(images = []) {
  const groups = [];
  const bySku = new Map();
  for (const image of Array.isArray(images) ? images : []) {
    const sku = String(image?.sku || "未提供 SKU");
    let group = bySku.get(sku);
    if (!group) {
      group = { sku, images: [] };
      bySku.set(sku, group);
      groups.push(group);
    }
    group.images.push(image);
  }
  return groups;
}

const IMAGE_STATUS_LABELS = {PENDING:'等待生图',GENERATING:'AI 生图中',COMPLETED:'生图完成',
  GENERATION_FAILED:'生图失败',UPLOAD_FAILED:'图片保存失败',SKIPPED:'已跳过',RESULT_UNKNOWN:'结果待核实',RESULT_UNAVAILABLE:'原拼图不可用'};

export function aiListingImageStatusLabel(image = {}, task = {}) {
  const sameSkuUnknown = row => String(row.sku) === String(image.sku) && row.status === 'RESULT_UNKNOWN';
  if(image.status === 'PENDING' && !image.generatedUrl
    && (task.skuProgress?.some(sameSkuUnknown) || task.images?.some(sameSkuUnknown)))return '等待同组结果核实';
  return IMAGE_STATUS_LABELS[image.status] || '等待生图';
}

export function aiListingSkuStatus(row = {}, task = {}) {
  const submission=task.submissionResults?.find(result=>String(result.sku)===String(row.sku));
  const status=row.status==='READY' && (submission?.importStatus==='UNKNOWN' || (!submission && task.status==='SUBMISSION_UNCERTAIN'))
    ? 'SUBMISSION_UNCERTAIN' : row.status;
  const labels={SKIPPED:'已跳过',RESULT_UNKNOWN:'结果待核实',RESULT_UNAVAILABLE:'原拼图不可用',GENERATION_FAILED:'生图失败',UPLOAD_FAILED:'图片保存失败',
    COMPLETED:'已完成',READY:'待上架',PENDING:'待处理',GENERATING:'生图中',SUBMITTED:'已提交',SUBMISSION_FAILED:'提交失败',SUBMISSION_UNCERTAIN:'提交结果待核实'};
  const colors={SKIPPED:'default',RESULT_UNKNOWN:'orange',RESULT_UNAVAILABLE:'orange',GENERATION_FAILED:'red',UPLOAD_FAILED:'red',COMPLETED:'green',
    READY:'blue',PENDING:'default',GENERATING:'processing',SUBMITTED:'cyan',SUBMISSION_FAILED:'red',SUBMISSION_UNCERTAIN:'orange'};
  const descriptions=[typeof row.reason==='string'?row.reason:''];
  if(row.usedBlackPriceFallback||row.priceBasis==='BLACK_PRICE_FALLBACK')descriptions.push('缺少绿标价，已采用黑标价计算');
  if(status==='RESULT_UNKNOWN')descriptions.push('请求可能已经生成或计费；普通重试不会再次生图，请先核实原请求结果');
  if(status==='RESULT_UNAVAILABLE')descriptions.push('普通重试不会重新生图；需核实后另行确认');
  if(status==='SUBMISSION_UNCERTAIN')descriptions.push('正在核对原提交结果，确认前不会重复提交');
  if(row.paidResultRetained)descriptions.push('已保存完整拼图；重试会先用已有结果重新切片');
  return {label:labels[status]||status||'待处理',color:colors[status]||'default',description:descriptions.filter(Boolean).join('；')};
}

export const canRefreshAiListingPricing = (task = {}) => Boolean(task.config?.salePricingId&&!task.deletedAt
  &&(task.status!=='COMPLETED'||task.skuProgress?.some(row=>row.status==='SKIPPED')));

export function aiListingActionPayload(task,action,options = {}) {
  return {expectedVersion:task.version,...(action==='retry'&&Array.isArray(options.skus)?{skus:[...new Set(options.skus)]}:{}),...(action==='retry'&&options.refreshSalePricing===true&&canRefreshAiListingPricing(task)?{refreshSalePricing:true}:{})};
}

export function aiListingTaskProgress(task = {}) {
  if (task.progress) return { completed: task.progress.completed, total: task.progress.total };
  const images = Array.isArray(task.images) ? task.images : [];
  return Object.freeze({
    completed: images.filter((image) => Boolean(image?.generatedUrl) || image?.status === "COMPLETED").length,
    total: images.length,
  });
}

export function aiListingTaskActions(status, {deletedView=false}={}) {
  if(status && typeof status === 'object') {
    if(status.deletedAt){
      const actions={approve:false,pause:false,cancel:false,delete:false,retry:false,resume:false};
      if(['PENDING','RUNNING'].includes(status.purge?.state))return deletedView?{...actions,permanentDelete:false}:actions;
      if(status.purge?.state==='FAILED')return deletedView
        ? {...actions,permanentDelete:status.taskActions?.permanentDelete===true}:actions;
      const resumable={...actions,resume:status.taskActions?.resume===true};
      return deletedView?{...resumable,permanentDelete:status.taskActions?.permanentDelete===true}:resumable;
    }
    // The server owns eligibility, including submission intent and pending stop requests.
    if(status.taskActions) return status.taskActions.permanentDelete===undefined
      ? status.taskActions : {...status.taskActions,permanentDelete:false};
    return aiListingTaskActions(status.status);
  }
  const value = String(status || "");
  return Object.freeze({
    approve: value === "AWAITING_REVIEW",
    retry: RETRYABLE.has(value),
    cancel: Boolean(value) && !NOT_CANCELLABLE.has(value),
  });
}

export function aiListingCanRetrySku(task,row={}) {
  return aiListingTaskActions(task).retry===true && Boolean(row.sku)
    && Boolean(['FAILED','PENDING'].includes(row.stockStatus)||['FAILED','UNKNOWN','PENDING'].includes(row.importStatus)
      ||row.publicationStatus==='IMAGE_FAILED'||row.publicationWarnings?.some(code=>
        ['all_image_failed','warning_all_image_failed','primary_image_load_failed','pics_reading_timeout','pics_http_error','some_image_failed'].includes(code)));
}

export function assertAiListingGenerationAvailable(mode, capabilities) {
  if(mode === 'GRID' && capabilities?.grid?.available !== true) {
    throw new Error(capabilities?.grid?.reason || '智能拼图切片能力尚未就绪，请稍后重试或手动选择逐张生图');
  }
}

// Shared by task summaries and the open detail: wait for completion before scheduling again.
export function aiListingPollDelay({visible=true,activeTab='tasks',activeCount=0}={}) {
  return !visible?60000:activeTab==='tasks'&&activeCount>0?3000:30000;
}

export function aiListingDetailPollDelay(task,visible=true) {
  const active=(task?.deletedAt&&['PENDING','RUNNING'].includes(task?.purge?.state))
    ||(!task?.deletedAt&&['QUEUED','COLLECTING','GENERATING','READY_TO_SUBMIT','SUBMITTING','SUBMITTED','SUBMISSION_UNCERTAIN'].includes(task?.status));
  return aiListingPollDelay({visible,activeCount:active?1:0});
}

export function startAiListingPolling({load,intervalMs=3000,getInterval=()=>intervalMs,setTimeoutFn=setTimeout,clearTimeoutFn=clearTimeout}) {
  let stopped=false,timer,failures=0;
  const poll=async()=>{
    try{failures=await load()===false?failures+1:0;}catch{failures+=1;}
    finally{if(!stopped)timer=setTimeoutFn(poll,Math.max(getInterval(),failures?Math.min(60000,10000*2**Math.min(failures-1,3)):0));}
  };
  void poll();
  return()=>{stopped=true;clearTimeoutFn(timer);};
}


export function aiListingSubmissionFailureReason(row = {}) {
  if ((row.errors || []).includes('PRODUCT_IS_ARCHIVED')) return '商品已归档，无法设置库存（PRODUCT_IS_ARCHIVED）。请先在对应店铺核对商品归档状态。';
  return row.failureReason || row.statusMessage || (row.errors || []).join('、') || publicationWarningMessages(row).join('；')
    || (row.importStatus === 'SUCCEEDED' && row.stockStatus === 'COMPLETED' ? '—' : '原因待确认');
}

export function aiListingTaskError(task = {}) {
  if(task.status !== 'SUBMISSION_FAILED') return task.errorMessage || '';
  const failures=(task.submissionResults || []).filter(row=>row.importStatus==='FAILED'||row.stockStatus==='FAILED'||row.importStatus==='UNKNOWN');
  if(failures.length) return failures.map(row=>`SKU ${row.sku}：${row.publicationStatus==='IMAGE_FAILED'?'图片接收失败':row.importStatus==='SUCCEEDED'?'商品导入成功，库存设置失败':row.importStatus==='UNKNOWN'?'商品导入结果待确认':'商品导入失败'}；${aiListingSubmissionFailureReason(row)}`).join('；');
  return task.errorMessage?.startsWith('部分商品上架失败') ? '部分商品上架未完成，请查看逐 SKU 结果，成功商品不会重复创建。' : task.errorMessage || '';
}
