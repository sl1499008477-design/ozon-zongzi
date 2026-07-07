import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const appSource = readFileSync("app/src/App.jsx", "utf8");

assert.match(appSource, /const listingImportJobTypes = new Set\(\[[^\]]*"IMPORT_BY_SKU"[^\]]*"PRODUCT_IMPORT"/s);
assert.match(appSource, /"PUBLIC_IMPORT"/);
assert.match(appSource, /"FOLLOW_FROM_PUBLIC"/);
assert.match(appSource, /\.filter\(isListingImportJob\)/);

console.log("import history type filter ok");
