import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const pageSource = await readFile(new URL("../src/StoresSettingsPage.jsx", import.meta.url), "utf8");

test("store settings owns the single delete-and-refresh flow without extension no-op adapters", () => {
  assert.doesNotMatch(appSource, /createStoreDeletionCleanup|onStoreDeleted|syncAuthToExtension|logoutExtension/);
  assert.doesNotMatch(pageSource, /createStoreDeletionController|onStoreDeleted|cleanupError/);
  assert.match(pageSource, /await apiRequest\(`\/local\/stores\/\$\{encodeURIComponent\(storeId\)\}`/);
  assert.match(pageSource, /await onRefresh\?\.\(\{ silent: true, source: "store-delete" \}\)/);
});
