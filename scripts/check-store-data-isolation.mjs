import assert from "node:assert/strict";
import fs from "node:fs";

const appSource = fs.readFileSync(new URL("../app/src/App.jsx", import.meta.url), "utf8");
const serverSource = fs.readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
const storeCacheScopeSource = fs.readFileSync(
  new URL("../server/store-cache-scope.mjs", import.meta.url),
  "utf8",
);
const ozonSyncServiceSource = fs.readFileSync(
  new URL("../server/ozon-sync-service.mjs", import.meta.url),
  "utf8",
);
const formalPersistenceSource = fs.readFileSync(new URL("../server/formal-persistence.mjs", import.meta.url), "utf8");
const persistenceSource = fs.readFileSync(new URL("../server/persistence.mjs", import.meta.url), "utf8");

assert.match(
  appSource,
  /const productBelongsToCurrentStore = [\s\S]*if \(storeId\) return Boolean\(ref\.storeId && String\(storeId\) === String\(ref\.storeId\)\);[\s\S]*if \(clientId\) return Boolean\(ref\.clientId && String\(clientId\) === String\(ref\.clientId\)\);/,
  "product ownership must stop on an explicit store or client identifier instead of falling through to a weaker name match",
);
assert.match(
  appSource,
  /const scopedProductsForCurrentStore = [\s\S]*if \(!ref\.storeId && !ref\.clientId && !ref\.storeNames\.size\) return \[\];[\s\S]*return list\.filter\(\(item\) => productBelongsToCurrentStore\(item, ref\)\);/,
  "product pages must not fall back to unscoped cached products",
);
assert.match(
  appSource,
  /const scopedWarehousesForCurrentStore = [\s\S]*if \(!ref\.storeId && !ref\.clientId && !ref\.storeNames\.size\) return \[\];[\s\S]*return list\.filter\(\(item\) => warehouseBelongsToCurrentStore\(item, ref\)\);/,
  "stock pages must not fall back to unscoped cached warehouses",
);
assert.match(
  appSource,
  /function ProductListPage[\s\S]*const products = scopedProductsForCurrentStore\(localData\?\.caches\?\.products \|\| \[\], binding, localData\);/,
  "product list must use the current-store product scope",
);
assert.match(
  appSource,
  /function StocksPage[\s\S]*const products = scopedProductsForCurrentStore\(localData\?\.caches\?\.products \|\| \[\], binding, localData\);[\s\S]*const warehouses = scopedWarehousesForCurrentStore\(localData\?\.caches\?\.warehouses \|\| \[\], binding, localData\);/,
  "stock management must scope both products and warehouses to the current store",
);
assert.match(
  storeCacheScopeSource,
  /export function cacheItemMatchesStore\([\s\S]*if \(itemStoreId\) return itemStoreId === expectedStoreId;[\s\S]*export function upsertProductByStore\([\s\S]*itemId === productId && cacheItemMatchesStore\(item, store\)/,
  "store cache scope helpers must retain separate cache rows per operating store",
);
assert.match(
  ozonSyncServiceSource,
  /upsertProductByStore\(cache, store, id,/,
  "product synchronization must retain separate cache rows per operating store",
);
assert.match(
  serverSource,
  /\/ozon\/cache\/import-with-hash[\s\S]*storeIdForAccountRequest\([\s\S]*mutateLatestStateWithRetry\([\s\S]*activeStore\(latest, storeId, account\.id\)[\s\S]*cacheItemMatchesStore\(row, latestStore\)[\s\S]*upsertProductByStore\(latest\.caches\.products, latestStore, id,/,
  "plugin product cache imports must validate and preserve the selected operating-store scope",
);
assert.match(
  formalPersistenceSource,
  /export async function hydrateStoreCatalogFromRelationalTables[\s\S]*FROM products[\s\S]*FROM warehouses[\s\S]*state\.caches\.products = products\.rows\.map\(hydratedProductRow\)[\s\S]*state\.caches\.warehouses = warehouses\.rows\.map\(hydratedWarehouseRow\)/,
  "formal PostgreSQL products and warehouses must hydrate the store-scoped frontend cache",
);
assert.match(
  persistenceSource,
  /await hydrateStoreCatalogFromRelationalTables\(pool, state\)/,
  "PostgreSQL state loads must restore the normalized store catalog before serving the frontend",
);

console.log("store data isolation contract ok");
