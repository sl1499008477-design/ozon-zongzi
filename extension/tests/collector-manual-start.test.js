const assert = require("assert");
const fs = require("fs");
const path = require("path");

const extensionRoot = path.resolve(__dirname, "..");
const read = (relativePath) =>
  fs.readFileSync(path.join(extensionRoot, relativePath), "utf8");

const search = read("content/ozon-search.js");
const dataPanel = read("content/ozon-data-panel.js");
const ozonProduct = read("content/ozon-product.js");
const collectorPanel = read("content/collector/panel.js");
const collectorDb = read("content/collector/db.js");
const sharedUtils = read("content/shared-utils.js");
const keywordPilot = read("content/collector/keyword-pilot.js");
const serviceWorker = read("background/service-worker.js");
const collectActions = read("background/agent/collect-actions.js");
const popup = read("popup/popup.js");

assert(
  search.includes("let collectorRunning = false;"),
  "search collector must start stopped in memory",
);
assert(
  search.includes("chrome.storage.local.remove(COLLECTOR_RUNNING_STORAGE_KEY)"),
  "search collector must not persist running=true across page loads",
);
assert(
  !search.includes("[COLLECTOR_RUNNING_STORAGE_KEY]: true"),
  "search collector must never write persistent running=true",
);
assert(
  search.includes("collectorStartedByKeywordPilot: startedHere"),
  "keyword pilot must persist whether it owns the collector running state",
);
assert(
  search.includes("session?.collectorStartedByKeywordPilot !== false"),
  "keyword pilot restore must keep manual collector ownership across navigation",
);
assert(
  keywordPilot.includes("this.collectorStartedByKeywordPilot = collectorStartedByKeywordPilot"),
  "keyword pilot auto-advance should preserve collector ownership across keywords",
);
assert(
  keywordPilot.includes("collectorStartedByKeywordPilot,"),
  "keyword pilot session should carry collector ownership across pages",
);
assert(
  search.includes("let collectorEnabled = true;") &&
    search.includes("collectorEnabled = r[COLLECTOR_STORAGE_KEY] !== false"),
  "search collector panel should be visible by default",
);
assert(
  dataPanel.includes("let collectorEnabled = true;"),
  "non-search collector panel should be visible by default",
);
assert(
  dataPanel.includes("collectorEnabled = r[COLLECTOR_KEY] !== false"),
  "non-search collector panel should only hide on explicit false",
);
assert(
  /function shouldPersistToBucket\(\)\s*\{\s*return collectorRunning;\s*\}/.test(dataPanel),
  "non-search bucket writes must be gated by manual collectorRunning",
);
assert(
  !/async function loadPanelData\(card, panel\)\s*\{\s*if \(!collectorRunning\)/.test(search),
  "search card data should load for display before manual collection starts",
);
assert(
  !/async function loadPanelData\(card, panel\)\s*\{\s*if \(!collectorRunning\)/.test(dataPanel),
  "non-search card data should load for display before manual collection starts",
);
assert(
  !search.includes("if (panelState.enabled && collectorRunning)") &&
    !dataPanel.includes("if (panelState.enabled && collectorRunning)") &&
    search.includes("if (panelState.enabled)") &&
    dataPanel.includes("if (panelState.enabled)"),
  "card data panels should mount from the panel setting, independent of collector running state",
);
assert(
  /async function collectSaleIfMatched\(productId, card, info, data, panel\)\s*\{\s*if \(!collectorRunning\) return false;[\s\S]*await window\.JZCollectorDB\.putSale\(record\);/.test(search),
  "search bucket writes must still require manual collectorRunning",
);
assert(
  collectorPanel.includes('<span class="jz-c-stat-label">已加载</span>'),
  "queue stats should be labeled as loaded data, not collected bucket data",
);
assert(
  !collectorPanel.includes('<span class="jz-c-stat-label">已采集</span>'),
  "collector panel queue stats must not imply stopped pages are collecting",
);

assert(
  collectorPanel.includes("cb.disabled = !running;") &&
    collectorPanel.includes("cb.checked = running && autoScrollerRunning;"),
  "auto-scroll toggle must stay off while collector is stopped",
);
assert(
  collectorPanel.includes("? queue.stats()") &&
    collectorPanel.includes(": { success: 0, running: 0, failed: 0 }"),
  "collector panel queue counters must stay zero while collector is stopped",
);
assert(
  search.includes("if (next && !collectorRunning)") &&
    dataPanel.includes("if (next && !collectorRunning)"),
  "auto-scroll callbacks must reject starting while collector is stopped",
);
assert(
  /function ensurePanelLoadStarted\(card, options = \{\}\)[\s\S]*if \(!collectorRunning \|\| !panelState\.enabled/.test(search) &&
    /function ensurePanelLoadStarted\(card, options = \{\}\)[\s\S]*if \(!collectorRunning \|\| !panelState\.enabled/.test(dataPanel),
  "auto-scroll readiness must only trigger panel loads after manual collector start",
);
assert(
  /function collectCurrentCardsOnce\(\)[\s\S]*ensurePanelLoadStarted\(card, \{ forceCollect: true \}\)/.test(search) &&
    /function collectCurrentCardsOnce\(\)[\s\S]*ensurePanelLoadStarted\(card, \{ forceCollect: true \}\)/.test(dataPanel),
  "manual collector start must revisit ready default-loaded cards for bucket collection",
);
assert(
  /options\.forceCollect && status === 'ready'/.test(search) &&
    /options\.forceCollect && status === "ready"/.test(dataPanel),
  "ready panels must be recollected from cache only on explicit manual start",
);
assert(
  /function isCurrentViewportDataReady\(\)[\s\S]*if \(!collectorRunning \|\| !panelState\.enabled\) return true;[\s\S]*ensurePanelLoadStarted\(card\)/.test(search) &&
    /function isCurrentViewportDataReady\(\)[\s\S]*if \(!collectorRunning \|\| !panelState\.enabled\) return true;[\s\S]*ensurePanelLoadStarted\(card\)/.test(dataPanel),
  "auto-scroll readiness must actively start visible card panel loads",
);
assert(
  search.includes("maxReadinessWaitMs: 20000") &&
    dataPanel.includes("maxReadinessWaitMs: 20000"),
  "auto-scroll must not wait forever for a stuck panel",
);

assert(
  serviceWorker.includes("const heartbeatActive =") &&
    serviceWorker.includes("collectorTabs.delete(tabId);") &&
    serviceWorker.includes("!!message.running"),
  "collector heartbeat should not expose stopped tabs in popup monitor",
);
assert(
  popup.includes("const currentlyOn = ozon_collector_enabled !== false;") &&
    popup.includes("const on = ozon_collector_enabled !== false;"),
  "popup collector badge/toggle should treat unset storage as visible by default",
);

assert(
  search.includes("function detectPriceCurrency(text)") &&
    dataPanel.includes("function detectPriceCurrency(text)") &&
    search.includes("function extractMoneyToken(text)") &&
    dataPanel.includes("function extractMoneyToken(text)") &&
    search.includes("\\u00a5") &&
    dataPanel.includes("\\u00a5"),
  "collector card extraction must detect source price currency",
);
assert(
  collectActions.includes("const extractPriceText = (text) =>") &&
    collectActions.includes("moneyTokenPattern"),
  "browser-agent Ozon collection must normalize price text before detecting currency",
);
assert(
  search.includes("window.normalizePrice(rawNodeText) > 0") &&
    dataPanel.includes("window.normalizePrice(rawNodeText) > 0"),
  "collector card extraction must keep numeric-only price nodes for unknown-currency RUB fallback",
);
assert(
  search.includes("function mergeRefreshedCardInfo(prev, refreshed)") &&
    dataPanel.includes("function mergeRefreshedCardInfo(prev, refreshed)") &&
    search.includes("priceCurrency: refreshed.priceCurrency || prev.priceCurrency") &&
    dataPanel.includes("priceCurrency: refreshed.priceCurrency || prev.priceCurrency"),
  "collector card refresh should not erase a previously detected priceCurrency",
);
assert(
  /priceCurrency:\s*info\.priceCurrency \|\| null/.test(search) &&
    /priceCurrency:\s*info\.priceCurrency \|\| null/.test(dataPanel),
  "collector local bucket records must preserve priceCurrency",
);
assert(
  /priceCurrency:\s*rec\.priceCurrency \|\| undefined/.test(search) &&
    /priceCurrency:\s*rec\.priceCurrency \|\| undefined/.test(dataPanel),
  "collector batch push must forward priceCurrency to backend source provider",
);
assert(
  /priceCurrency:\s*info\.priceCurrency \|\| undefined/.test(search) &&
    /priceCurrency:\s*info\.priceCurrency \|\| undefined/.test(dataPanel),
  "single collect/edit payloads must forward priceCurrency to backend source provider",
);
assert(
  collectActions.includes("priceCurrency: detectPriceCurrency(priceText) || undefined"),
  "browser-agent Ozon collection must forward priceCurrency",
);

assert(
  serviceWorker.includes("part_marketing_price") &&
    serviceWorker.includes("marketing_price") &&
    serviceWorker.includes("seller_price") &&
    serviceWorker.includes("marketing_price_currency") &&
    serviceWorker.includes("partMarketingPrice?.price?.currencyCode") &&
    serviceWorker.includes("partMarketingPrice?.price?.currency_code"),
  "searchVariants must preserve Ozon marketing black-label price fields",
);

assert(
  collectorDb.includes("{ key: 'price', label: '当前价(¥)' }") &&
    collectorDb.includes("{ key: 'gmvSumCny', label: '月销售额(¥)' }") &&
    collectorDb.includes("{ key: 'lowestFollowerPrice', label: '跟卖最低价(¥)' }"),
  "collector Excel export money columns should default to CNY labels",
);
const imageFieldIndex = collectorDb.indexOf("{ key: 'image', label: '主图' }");
const skuFieldIndex = collectorDb.indexOf("{ key: 'sku', label: 'SKU' }");
assert(
  imageFieldIndex >= 0 &&
    skuFieldIndex > imageFieldIndex &&
    collectorDb.includes("{ key: 'marketingPrice', label: '黑标价(¥)' }") &&
    collectorDb.includes("if (key === 'marketingPrice') return _resolveMarketingPriceCny(rec)") &&
    collectorDb.includes("function _resolveMarketingPriceCny(rec)") &&
    collectorDb.includes("part_marketing_price"),
  "collector Excel export should put image first and include black-label marketing price",
);
assert(
  !collectorDb.includes("当前价(₽)") &&
    !collectorDb.includes("月销售额(₽)") &&
    !collectorDb.includes("{ key: 'gmvSum', label: '月销售额"),
  "collector Excel export should not expose default RUB money columns",
);
assert(
  collectorDb.includes("async function _refreshExportFxRate()") &&
    collectorDb.includes("action: 'getFxRate'") &&
    collectorDb.includes("return n / rate;"),
  "collector Excel export should use the dynamic CNY/RUB rate for explicit/default RUB values",
);
assert(
  collectorDb.includes("rec?.priceCurrency") &&
    collectorDb.includes("_moneyToCny(rec?.price, priceCurrency)") &&
    collectorDb.includes("_moneyToCny(raw.priceRub, 'RUB')"),
  "collector Excel export should convert known/default RUB prices to CNY",
);
assert(
  !sharedUtils.includes("function _jzMoneyToCny") &&
    !sharedUtils.includes("const gmvCny = _jzMoneyToCny") &&
    collectorPanel.includes("_moneyToCny(data?.gmvSum, _currencyFromMoneyText(data?.gmvSum))") &&
    collectorPanel.includes("_moneyToCny(data?.price, dataCurrency)") &&
    collectorPanel.includes("_moneyToCny(data?.lowestFollowerPrice, _firstValue(data?.lowestFollowerPriceCurrency") &&
    collectorPanel.includes("info?.priceCurrency"),
  "collector local bucket and smart filters should convert explicit/default RUB money values to CNY",
);
assert(
  collectorPanel.includes("{ key: 'marketingPrice', label: '黑标价范围：'") &&
    collectorPanel.includes("if (key === 'marketingPrice') return _marketingPriceCny(data, info)") &&
    sharedUtils.includes("function _jzMarketingPriceInfo(data, info)") &&
    sharedUtils.includes("out.marketingPriceCny = marketingPriceInfo.cny"),
  "collector smart filters should use black-label marketing price when it is available",
);

assert(
  sharedUtils.includes("const visitPriceState =") &&
    sharedUtils.includes("node.blackPrice ?? node.black_price ?? node.marketingPrice ?? node.marketing_price") &&
    sharedUtils.includes("window.jzDetectOzonMoneyCurrency"),
  "Ozon card price extraction should recursively read black-label price fields and their currency",
);
const searchCurrencyDetector = search.slice(
  search.indexOf("function detectPriceCurrency(text)"),
  search.indexOf("function getCurrentKeywordText()"),
);
const dataPanelCurrencyDetector = dataPanel.slice(
  dataPanel.indexOf("function detectPriceCurrency(text)"),
  dataPanel.indexOf("function keywordTextFromUrl(url)"),
);
assert(
  sharedUtils.includes("function _jzDetectOzonMoneyCurrency(value)") &&
    sharedUtils.includes("window.jzDetectOzonMoneyCurrency = _jzDetectOzonMoneyCurrency") &&
    searchCurrencyDetector.includes("return window.jzDetectOzonMoneyCurrency?.(text) || null;") &&
    dataPanelCurrencyDetector.includes("return window.jzDetectOzonMoneyCurrency?.(text) || null;") &&
    !searchCurrencyDetector.includes("\\b(?:CNY|RMB)") &&
    !dataPanelCurrencyDetector.includes("\\b(?:CNY|RMB)") &&
    ozonProduct.includes("const shared = window.jzDetectOzonMoneyCurrency?.(s);") &&
    ozonProduct.includes("if (shared) return shared;"),
  "Ozon currency detection should be centralized in shared-utils with product-page legacy fallbacks only",
);
assert(
  ozonProduct.includes("pagePriceTags = window.jzExtractOzonCalcPriceTags?.(document)") &&
    ozonProduct.includes("function buildMarketingPricePayload(product)") &&
    ozonProduct.includes("mergeMarketingPriceIntoVariantData(collectVariantData, product)") &&
    ozonProduct.includes("mergeMarketingPriceIntoVariantData(editCollectVariantData, product)") &&
    ozonProduct.includes("mergeMarketingPriceIntoVariantData(variantData, anchorProduct)") &&
    ozonProduct.includes("function buildPdpBucketRecord(product") &&
    ozonProduct.includes("const keyword = getCurrentKeywordText()") &&
    ozonProduct.includes("raw.keyword = keyword") &&
    ozonProduct.includes("const bucketRecord = buildPdpBucketRecord(anchorProduct") &&
    ozonProduct.includes("bucketRecord };") &&
    ozonProduct.includes("const bucketRecord = result?.bucketRecord;") &&
    ozonProduct.includes("await window.JZCollectorDB?.putSale(bucketRecord);"),
  "PDP collection should reuse calculator price extraction and carry the same black-label price into backend and local bucket exports",
);
assert(
  sharedUtils.includes("info?.marketingPrice,") &&
    collectorPanel.includes("info?.marketingPrice,") &&
    collectorDb.includes("rec.marketingPrice,"),
  "black-label price resolution should accept current card info and top-level record fallbacks",
);
assert(
  search.includes("const needsMarketingPrice = missing.some((key) => key === 'marketingPrice');") &&
    search.includes("const shouldSoftWaitMarketing = !hasMarketing && softMarketingWaits < 6;") &&
    search.includes("const readyData = window.jzExtractPanelFilterData") &&
    search.includes("const record = buildSaleRecord(productId, readyInfo, readyData);") &&
    dataPanel.includes('const needsMarketingPrice = missing.some((key) => key === "marketingPrice");') &&
    dataPanel.includes("const shouldSoftWaitMarketing = !hasMarketing && softMarketingWaits < 6;") &&
    dataPanel.includes("const readyData = window.jzExtractPanelFilterData") &&
    dataPanel.includes("const record = buildSaleRecord(productId, readyInfo, readyData);"),
  "collector should briefly wait for black-label price and write the refreshed data to local bucket records",
);
assert(
  sharedUtils.includes("window.jzExtractOzonCalcPriceTags = function (root)") &&
    sharedUtils.includes("window.jzExtractOzonVisiblePriceTags = function (root)") &&
    sharedUtils.includes("const primaryCurrency = tokens[0].currency || 'RUB'") &&
    sharedUtils.includes("window.jzFetchOzonPagePriceTags = async function (url)") &&
    sharedUtils.includes("window.jzExtractOzonCalcPriceTags(doc)") &&
    sharedUtils.includes("window.jzExtractOzonPageHashtags = function (root)") &&
    sharedUtils.includes("window.jzExtractOzonPageHashtags(doc)") &&
    search.includes("window.jzExtractOzonCalcPriceTags(card)") &&
    search.includes("async function enrichInfoWithDetailMarketingPrice(info)") &&
    search.includes("marketingPrice: priceTags.blackPrice ?? info.marketingPrice ?? null") &&
    search.includes("nextInfo = await enrichInfoWithDetailMarketingPrice(nextInfo)") &&
    search.includes("raw.hashtags = hashtags") &&
    search.includes("mergeSourceHashtagsIntoVariant?.(variantMatch, info.hashtags)") &&
    dataPanel.includes("window.jzExtractOzonCalcPriceTags(card)") &&
    dataPanel.includes("async function enrichInfoWithDetailMarketingPrice(info)") &&
    dataPanel.includes("marketingPrice: priceTags.blackPrice ?? info.marketingPrice ?? null") &&
    dataPanel.includes("nextInfo = await enrichInfoWithDetailMarketingPrice(nextInfo)") &&
    dataPanel.includes("raw.hashtags = hashtags") &&
    dataPanel.includes("mergeSourceHashtagsIntoVariant?.(variantMatch, info.hashtags)"),
  "collector should fall back to the product detail page for black-label price and source hashtags",
);
assert(
  collectorDb.includes("function _mergeSaleRecord(existing, record)") &&
    collectorDb.includes("'keyword',") &&
    collectorDb.includes("'hashtags',") &&
    collectorDb.includes("'marketingPrice',") &&
    collectorDb.includes("_resolveHashtagKeyword(rec)") &&
    collectorDb.includes("record = _mergeSaleRecord(existing, record);"),
  "collector local bucket writes should preserve existing keywords, hashtags, and black-label price when a later record is missing them",
);
assert(
  collectorDb.includes("function _priceSourceRank(source)") &&
    collectorDb.includes("_preserveHigherSource(next, existing, '_marketingPriceSource'") &&
    collectorDb.includes("_preserveHigherSource(mergedRaw, existingRaw, '_marketingPriceSource'") &&
    collectorDb.includes("store.put(_mergeSaleRecord(req.result, r));") &&
    search.includes("marketingPriceSource: priceTags.blackPrice != null ? 'pdp'") &&
    search.includes("greenPriceSource: priceTags.greenPrice != null ? 'pdp'") &&
    dataPanel.includes('marketingPriceSource: priceTags.blackPrice != null ? "pdp"') &&
    dataPanel.includes('greenPriceSource: priceTags.greenPrice != null ? "pdp"') &&
    ozonProduct.includes("raw._marketingPriceSource = 'pdp'") &&
    ozonProduct.includes("raw._greenPriceSource = 'pdp'"),
  "collector local bucket should keep PDP black/green-label prices ahead of card/list prices and batch writes should use the same merge rules",
);

const dbPriceCase = collectorDb.slice(
  collectorDb.indexOf("if (key === 'price')"),
  collectorDb.indexOf("if (key === 'marketingPrice')"),
);
const dbFollowerCase = collectorDb.slice(
  collectorDb.indexOf("if (key === 'lowestFollowerPrice')"),
  collectorDb.indexOf("return rec[key];"),
);
const panelPriceCase = collectorPanel.slice(
  collectorPanel.indexOf("if (key === 'price')"),
  collectorPanel.indexOf("if (key === 'marketingPrice')"),
);
const panelFollowerCase = collectorPanel.slice(
  collectorPanel.indexOf("if (key === 'lowestFollowerPrice')"),
  collectorPanel.indexOf("return null;", collectorPanel.indexOf("if (key === 'lowestFollowerPrice')")),
);
assert(
  dbPriceCase.indexOf("_moneyToCny(rec?.price, priceCurrency)") >= 0 &&
    dbPriceCase.indexOf("_extractCny(rec?.price)") > dbPriceCase.indexOf("_moneyToCny(rec?.price, priceCurrency)") &&
    dbFollowerCase.indexOf("_moneyToCny(raw.lowestFollowerPrice, _firstValue(raw.lowestFollowerPriceCurrency") >= 0 &&
    dbFollowerCase.indexOf("_extractCny(raw.lowestFollowerPrice)") > dbFollowerCase.indexOf("_moneyToCny(raw.lowestFollowerPrice, _firstValue(raw.lowestFollowerPriceCurrency") &&
    panelPriceCase.indexOf("_moneyToCny(data?.price, dataCurrency)") >= 0 &&
    panelPriceCase.indexOf("_moneyTextToCny(data?.price)") > panelPriceCase.indexOf("_moneyToCny(data?.price, dataCurrency)") &&
    panelFollowerCase.indexOf("_moneyToCny(data?.lowestFollowerPrice, _firstValue(data?.lowestFollowerPriceCurrency") >= 0 &&
    panelFollowerCase.indexOf("_moneyTextToCny(data?.lowestFollowerPrice)") > panelFollowerCase.indexOf("_moneyToCny(data?.lowestFollowerPrice, _firstValue(data?.lowestFollowerPriceCurrency"),
  "collector price export and smart filters must try currency-aware conversion before numeric CNY fast-path fallbacks",
);

console.log("collector manual start smoke passed");
