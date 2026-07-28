import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const appSource = readFileSync("app/src/App.jsx", "utf8");

assert.match(appSource, /const listingImportJobTypes = new Set\(\[[^\]]*"IMPORT_BY_SKU"[^\]]*"PRODUCT_IMPORT"/s);
assert.match(appSource, /"PUBLIC_IMPORT"/);
assert.match(appSource, /"FOLLOW_FROM_PUBLIC"/);
assert.match(appSource, /"COLLECT_BOX_DRAFT"/);
assert.match(appSource, /"已跳过": new Set\(\["SKIPPED"\]\)/);
assert.match(appSource, /const detailStatusItems = selectedDetailTask\?\.statusResponse\?\.result\?\.items/);
assert.match(appSource, /\.filter\(\(task\) => isListingImportJob\(task\) && currentStoreId && String\(task\.storeId \|\| ""\) === currentStoreId\)/);

console.log("import history type filter ok");
