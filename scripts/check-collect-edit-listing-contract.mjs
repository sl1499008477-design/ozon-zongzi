import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSource = readFileSync("app/src/App.jsx", "utf8");
const extensionProductSource = readFileSync("extension/content/ozon-product.js", "utf8");

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
  /const collectItems = localData\?\.caches\?\.collectBox \|\| \[\];[\s\S]*const collectCandidate = collectItems\.find[\s\S]*const productCandidate = productItems\.find[\s\S]*const candidateItem = collectCandidate \|\| productCandidate;[\s\S]*const itemScopeCurrent = Boolean\(collectCandidate\) \|\| categoryItemScopeIsCurrent[\s\S]*const item = itemScopeCurrent \? candidateItem : null;/,
  "collect edit page must accept account-scoped collection items while retaining legacy product store scope",
);

requirePattern(
  /const runListingRequest = async function\(\{ dryRun = false \} = \{\}\) \{[\s\S]*if \(!dryRun && listingRequiredMissingFields\.length\) \{[\s\S]*message\.warning\(listingMissingRequiredText\)[\s\S]*if \(!sku\)[\s\S]*if \(!hasStore\)[\s\S]*const numericPrice = numberFromMoney\(price\);[\s\S]*if \(!numericPrice \|\| numericPrice <= 0\)[\s\S]*const storeId = categoryStoreId;/,
  "real listing request must block incomplete fields and scope preparation to the explicit target store",
);

requirePattern(
  /const listingRequiredMissingFields = \[[\s\S]*"上架店铺"[\s\S]*"SKU（商品编码）"[\s\S]*"俄语标题"[\s\S]*"售价"[\s\S]*"上架仓库"[\s\S]*"上架库存"[\s\S]*"包装重量和尺寸"[\s\S]*"产品类目"[\s\S]*\.\.\.missingRequiredCategoryAttributes/,
  "collect edit must build a required-field checklist before real Ozon listing",
);

requirePattern(
  /const listingSubmitDisabledReason = listingMissingRequiredText \|\| categoryReadinessState\.message;[\s\S]*const listingSubmitDisabled = loading \|\| Boolean\(listingRequiredMissingFields\.length\) \|\| !categoryReadinessState\.ready;/,
  "formal listing must depend on persisted draft completeness and authentic category readiness instead of extension availability",
);

requirePattern(
  /if \(dryRun && result\?\.ok\) \{[\s\S]*setListingResult\(\{[\s\S]*title: "预检通过"[\s\S]*message\.success\(\{ content: `预检通过/,
  "dryRun content check must render persistent preview success details",
);

requirePattern(
  /await saveListingDraft\(\{ silent: true, onlyIfChanged: true \}\);[\s\S]*apiRequest\(`\/ozon\/collect-box\/\$\{encodeURIComponent\(item\.id\)\}\/listing\/\$\{dryRun \? "preview" : "submit"\}`,[\s\S]*title: result\.queued \? "已进入正式上架队列" : "Ozon 已受理，等待最终结果"/,
  "real listing must only persist changed drafts, submit that draft, and distinguish queue acceptance from final Ozon success",
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
  /const saveListingDraft = async function\(\{ silent = false, onlyIfChanged = false \} = \{\}\) \{[\s\S]*if \(onlyIfChanged[\s\S]*listingDraft: draft,[\s\S]*await onRefresh\?\.\(\);[\s\S]*message\.success\("草稿已保存"\)[\s\S]*const handleSaveDraft = async function\(\) \{[\s\S]*saveListingDraft\(\{ silent: false \}\)/,
  "collect edit must persist listingDraft through the reusable draft saver and refresh local state",
);

requirePattern(
  /aria-label="上架预检"[\s\S]*>内容体检<\/Button>[\s\S]*listingSubmitDisabledReason[\s\S]*disabled=\{listingSubmitDisabled\}[\s\S]*aria-label="提交上架到 Ozon"[\s\S]*>上架到 Ozon<\/Button>/,
  "collect edit must expose source-style content check and listing buttons with stable accessibility labels",
);

assert.match(
  extensionProductSource,
  /sourceVariant:\s*r\.sourceVariant/,
  "multi-variant collection must persist each SKU source snapshot instead of only the anchor snapshot",
);

requirePattern(
  /const collectEditVariantSourceSnapshot[\s\S]*variant\.sourceVariant[\s\S]*String\(sku \|\| ""\) !== anchorSku[\s\S]*return \{\}/,
  "collect edit must not copy the legacy anchor source snapshot into sibling variants",
);

requirePattern(
  /const draftVariants = variantRows\.map[\s\S]*if \(index !== anchorIndex\) return row;[\s\S]*categoryAttributes: editedCategoryAttributes/,
  "collect edit must persist anchor edits on the anchor variant only",
);

console.log("collect edit listing contract ok");
