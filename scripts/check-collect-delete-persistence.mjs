import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSource = readFileSync("app/src/App.jsx", "utf8");
const serverSource = readFileSync("server/index.mjs", "utf8");
const persistenceSource = readFileSync("server/persistence.mjs", "utf8");

const deleteFunction = serverSource.match(
  /async function deleteCollectBoxItemsAtomic[\s\S]*?\n}\n\nasync function saveCollectBoxBatchAtomic/,
)?.[0] || "";
assert.match(deleteFunction, /savePersistedCollectBox/, "collect deletion must use the scoped persistence path");
assert.doesNotMatch(deleteFunction, /loadState\(|saveState\(/, "collect deletion must not reload or rewrite the full state");

const persistenceFunction = persistenceSource.match(
  /export async function savePersistedCollectBox[\s\S]*?\n}\n\nexport async function persistenceHealth/,
)?.[0] || "";
assert.match(persistenceFunction, /jsonb_set\([\s\S]*'\{caches,collectBox}'/, "PostgreSQL deletion must update only the collectBox JSON path");
assert.doesNotMatch(persistenceFunction, /mirrorStateToRelationalTables/, "collect deletion must not mirror unrelated formal tables");

const collectPage = appSource.match(/function CollectPage[\s\S]*?function CollectEditPage/)?.[0] || "";
assert.match(
  collectPage,
  /message\.success\([\s\S]*Promise\.resolve\(onRefresh\?\.\(\{ silent: true \}\)\)/,
  "collect deletion must close promptly and refresh the large state in the background",
);

console.log("collect box delete persistence contract ok");
