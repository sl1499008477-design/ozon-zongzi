import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSource = readFileSync("app/src/App.jsx", "utf8");

const requirePattern = (pattern, message) => {
  assert.match(appSource, pattern, message);
};

const productListSource = appSource.match(/function ProductListPage[\s\S]*?function CollectPage/)?.[0] || "";
assert.doesNotMatch(
  productListSource,
  /title: "操作"[\s\S]*dataIndex: "操作"[\s\S]*source=product/,
  "product list must not render the removed operation column",
);

requirePattern(
  /function CollectPage[\s\S]*navigate\(`\/ozon\/products\/collect\/edit\/\?id=\$\{encodeURIComponent\(row\.id\)\}`\)/,
  "collect box 查看 must route to the collect edit page",
);

requirePattern(
  /const collectItems = localData\?\.caches\?\.collectBox \|\| \[\];[\s\S]*const productItems = localData\?\.caches\?\.products \|\| \[\];[\s\S]*const item = collectItems\.find[\s\S]*\|\| productItems\.find/,
  "collect edit page must resolve items from both collect box and product list caches",
);

requirePattern(
  /const requestExtensionFollowSell = async \(\{ storeId, sku, price, currencyCode, dryRun = false \}\) =>[\s\S]*kind: "follow-sell\.request"[\s\S]*storeId, sku, price, currencyCode, dryRun/,
  "local listing bridge request must send storeId, sku, price, currencyCode and dryRun to the extension",
);

requirePattern(
  /const runListingRequest = async function\(\{ dryRun = false \} = \{\}\) \{[\s\S]*if \(!sku\)[\s\S]*if \(!hasStore\)[\s\S]*const numericPrice = numberFromMoney\(price\);[\s\S]*if \(!numericPrice \|\| numericPrice <= 0\)[\s\S]*const storeId = localStorage\.getItem\("currentOzonStoreId"\)/,
  "listing request must validate sku, store binding, price and current store before submitting",
);

requirePattern(
  /await syncAuthToExtension\(\{ token, storeId \}\);[\s\S]*const ping = await requestExtensionPing\(1500\);[\s\S]*const bridgeStatus = listingBridgeStatusFromPing\(ping\);[\s\S]*if \(bridgeStatus\.status !== "ok" && bridgeStatus\.status !== "partial"\)/,
  "listing request must sync auth and verify extension bridge status before collecting/listing",
);

requirePattern(
  /const submitCurrencyCode = storeCurrencyCode \|\| currencyCode;[\s\S]*bridgeStatus\.status === "ok"[\s\S]*await requestExtensionFollowSell\(\{[\s\S]*storeId,[\s\S]*sku,[\s\S]*price: numericPrice,[\s\S]*currencyCode: submitCurrencyCode,[\s\S]*dryRun,[\s\S]*\}\)[\s\S]*await requestSourcePluginListing\(\{[\s\S]*storeId,[\s\S]*sku,[\s\S]*price: numericPrice,[\s\S]*currencyCode: submitCurrencyCode,[\s\S]*title,[\s\S]*dryRun,/,
  "listing request must prefer the local follow-sell bridge, keep source-plugin fallback, and submit the store contract currency",
);

requirePattern(
  /if \(dryRun && resp\?\.ok\) \{[\s\S]*setListingResult\(\{[\s\S]*title: "预检通过"[\s\S]*message\.success\(\{ content: `预检通过/,
  "dryRun content check must render persistent preview success details",
);

requirePattern(
  /apiRequest\(`\/ozon\/collect-box\/\$\{encodeURIComponent\(item\.id\)\}`,[\s\S]*method: "PATCH"[\s\S]*body: \{ status: "已上架", listingTaskId:/,
  "real listing success must mark collect-box items as listed with the task id",
);

requirePattern(
  /setTimeout\(function\(\) \{ navigate\("\/ozon\/products\/import-history"\); \}, 800\)/,
  "real listing success must navigate to import history",
);

requirePattern(
  /const handlePreview = function\(\) \{[\s\S]*runListingRequest\(\{ dryRun: true \}\);[\s\S]*const handleSubmit = function\(\) \{[\s\S]*runListingRequest\(\{ dryRun: false \}\);/,
  "content check and submit buttons must call the shared listing request with the correct dryRun mode",
);

requirePattern(
  /const handleSaveDraft = async function\(\) \{[\s\S]*listingDraft: draft,[\s\S]*await onRefresh\?\.\(\);[\s\S]*message\.success\("草稿已保存"\)/,
  "collect edit save draft must persist listingDraft back to the collect box and refresh local state",
);

requirePattern(
  /aria-label="上架预检"[\s\S]*>内容体检<\/Button>[\s\S]*aria-label="提交上架到 Ozon"[\s\S]*>上架到 Ozon<\/Button>/,
  "collect edit must expose source-style content check and listing buttons with stable accessibility labels",
);

console.log("collect edit listing contract ok");
