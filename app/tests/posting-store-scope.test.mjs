import assert from "node:assert/strict";
import fs from "node:fs";

let scopedPostingsForCurrentStore;
try {
  ({ scopedPostingsForCurrentStore } = await import("../src/posting-store-scope.js"));
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
}

const postings = [
  { posting_number: "current", storeId: "store-current" },
  { posting_number: "other", storeId: "store-other" },
  { posting_number: "unscoped" },
];

assert.deepEqual(
  scopedPostingsForCurrentStore?.(
    postings,
    { id: "store-current" },
    { currentStoreId: "store-current" },
  ),
  [postings[0]],
  "orders page must expose only postings with the explicit current store ID",
);

assert.deepEqual(
  scopedPostingsForCurrentStore?.(postings, {}, {}),
  [],
  "orders without a resolved current store must not fall back to account-wide data",
);

const appSource = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
assert.match(
  appSource,
  /function PostingsPage[\s\S]*const postings = scopedPostingsForCurrentStore\(localData\?\.caches\?\.postings \|\| \[\], binding, localData\);/,
  "PostingsPage must use the current-store posting scope before counts, rows, and export",
);

console.log("posting store scope test passed");
