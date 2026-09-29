// SKU decisions stay with the original task; filtering never discards source evidence.
export function imageResultUnknown(image, task) {
  return Boolean(image.resultUnknown || image.lastError?.diagnostic?.deliveryState === 'POSSIBLY_SENT'
    || image.lastError?.deliveryState === 'POSSIBLY_SENT'
    || !image.generatedUrl && image.status === 'GENERATING'
    || !image.generatedUrl && /结果未知|结果待核实/.test(task.errorMessage || '')
      && ['RETRYABLE_GATEWAY','NON_RETRYABLE_GATEWAY','AI_GATEWAY_UNEXPECTED_EOF','AI_GATEWAY_STREAM_TIMEOUT','AI_GATEWAY_MODEL_MISMATCH'].includes(image.lastError?.code));
}
export function requiresPaidResult(image) {
  return Boolean(image.reusePaidResult || image.paidResultRetained || image.status==='UPLOAD_FAILED'
    || ['AI_LISTING_GRID_GEOMETRY_INVALID','AI_LISTING_IMAGE_DIMENSIONS_UNSUPPORTED','AI_LISTING_PAID_RESULT_MISSING'].includes(image.lastError?.code));
}
export function skuProgress(task) {
  const rows = new Map();
  for (const image of task.images || []) {
    if (!rows.has(image.sku)) rows.set(image.sku, []);
    rows.get(image.sku).push(image);
  }
  return [...rows].map(([sku, images]) => {
    const pricing = task.source?.skuPricing?.find(row => row.sku === sku);
    const failed = images.find(image => !image.generatedUrl && image.status?.endsWith('FAILED'));
    const unknown = images.find(image => imageResultUnknown(image, task));
    const completed = images.filter(image => image.generatedUrl).length;
    const submitted = task.submissionResults?.find(row => row.sku === sku);
    const status = pricing?.status === 'SKIPPED' ? 'SKIPPED' : unknown ? 'RESULT_UNKNOWN'
      : failed?.lastError?.code==='AI_LISTING_PAID_RESULT_MISSING' ? 'RESULT_UNAVAILABLE'
      : completed === images.length ? submitted?.stockStatus === 'COMPLETED' || task.status === 'COMPLETED' ? 'COMPLETED' : 'READY'
      : failed ? failed.status : 'PENDING';
    return {sku,total:images.length,completed,status,
      ...(pricing?.priceBasis ? {priceBasis:pricing.priceBasis,usedBlackPriceFallback:pricing.usedBlackPriceFallback===true} : {}),
      ...(pricing?.status === 'SKIPPED' ? {reason:pricing.reason,code:pricing.code} : unknown ? {reason:'图片请求结果待核实，普通重试不会再次生图'} : failed ? {reason:failed.errorMessage} : {}),
      ...((unknown || failed)?.lastError?.diagnostic ? {diagnostic:(unknown || failed).lastError.diagnostic} : {})};
  });
}
export function skippedSkus(task) {
  return new Set((task.source?.skuPricing || []).filter(row => row.status === 'SKIPPED').map(row => row.sku));
}
export function isGenerationLeader(task,image) {
  if(task.config?.generationMode!=='GRID')return true;
  const group=task.imagePlan?.items?.find(item=>item.sku===image.sku)?.groups?.find(row=>row.indices.includes(image.index));
  return task.images.find(other=>other.sku===image.sku&&!other.generatedUrl&&(!group||group.indices.includes(other.index)))===image;
}
export function canGenerateImage(task, image, now = Date.now()) {
  if (image.generatedUrl || skippedSkus(task).has(image.sku)) return false;
  if (!isGenerationLeader(task,image)) return false;
  if (task.images.some(other => other.sku === image.sku && imageResultUnknown(other, task))) return false;
  return !image.status?.endsWith('FAILED') || Boolean(image.retryAt && image.retryAt <= now);
}
export function submissionSource(task) {
  const ready = new Set(skuProgress(task).filter(row => ['READY','COMPLETED'].includes(row.status)).map(row => row.sku));
  return {...task.source,items:task.source.items.filter(item => ready.has(item.sku))};
}
