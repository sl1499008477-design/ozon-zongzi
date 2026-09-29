import {mergeOzonEnrichmentResult,buildOzonEnrichmentSummary} from './collect-enrichment-policy.mjs';
const skuOf = item => String(item?.sku || item?.sourceSku || item?.scraped_sku || '').trim();
export function mergeSkuEnrichment(draft, result) {
  const sku=skuOf(result);
  if (!sku) return draft;
  let next=(!skuOf(draft) || skuOf(draft)===sku) ? mergeOzonEnrichmentResult(draft,result) : {...draft};
  if (Array.isArray(draft.variants)) next.variants=draft.variants.map(v=>skuOf(v)===sku ? mergeOzonEnrichmentResult(v,result) : v);
  return next;
}
export function skuEnrichmentSummary(draft) {
  const summaries=[{sku:skuOf(draft),...buildOzonEnrichmentSummary(draft)}];
  for(const v of draft.variants||[]) {
    // Category can be shared within the product; package facts cannot.
    summaries.push({sku:skuOf(v),...buildOzonEnrichmentSummary({...v,sourceCategory:v.sourceCategory||draft.sourceCategory})});
  }
  const missing=summaries.filter(s=>s.missingFields.length);
  const packagingConflicts = [...new Map([draft,...(draft.variants||[])].filter(v =>
    Array.isArray(v.packagingCandidates) && v.packagingCandidates.length === 2 &&
    buildOzonEnrichmentSummary(v).missingFields.some(f=>f!=='descriptionCategoryId')
  ).map(v=>[skuOf(v),{sku:skuOf(v),candidates:v.packagingCandidates}])).values()];
  return {...buildOzonEnrichmentSummary(draft),status:packagingConflicts.length?'NEEDS_ATTENTION':missing.length?'PENDING_ENRICHMENT':'COMPLETE',
    ...(packagingConflicts.length ? {packagingConflicts,lastErrorCode:'ZONGZI_ENRICH_DATA_CONFLICT'} : {}),
    missingFields:[...new Set(missing.flatMap(s=>s.missingFields))],missingSkus:[...new Set(missing.map(s=>s.sku))]};
}

// One persisted capture task per source SKU, regardless of which PDP was open.
export function collectCaptureSkus(item = {}) {
  return [...new Set([skuOf(item),
    ...(item.listingDraft?.variants || []).map(skuOf),
    ...(item.variants || []).map(skuOf),
    ...(item.raw?.variantData?.variants || []).map(skuOf),
    ...(item.variantData?.variants || []).map(skuOf),
  ].filter(Boolean))];
}
