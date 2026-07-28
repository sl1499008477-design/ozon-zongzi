import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [serverEntry, appEntry] = await Promise.all([
  readFile(new URL("../index.mjs", import.meta.url), "utf8"),
  readFile(new URL("../../app/src/App.jsx", import.meta.url), "utf8"),
]);

assert.ok(
  serverEntry.split("\n").length <= 5400,
  "server/index.mjs exceeded its migration guard; add new behavior in a focused module",
);
assert.ok(
  appEntry.split("\n").length <= 9850,
  "app/src/App.jsx exceeded its migration guard; add new pages outside App.jsx",
);

for (const functionName of [
  "createAccountRecord",
  "requireAuth",
  "requireAdmin",
  "activeStore",
  "storeIdForAccountRequest",
]) {
  assert.doesNotMatch(
    serverEntry,
    new RegExp(`function\\s+${functionName}\\s*\\(`),
    `${functionName} belongs in account-context.mjs`,
  );
}

for (const functionName of [
  "ozonCall",
  "ozonGet",
  "syncStoreProfile",
  "refreshStoreProfiles",
  "syncProducts",
  "syncPostings",
  "syncWarehouses",
  "syncPromotions",
  "runLocalSync",
]) {
  assert.doesNotMatch(
    serverEntry,
    new RegExp(`(?:async\\s+)?function\\s+${functionName}\\s*\\(`),
    `${functionName} must remain outside server/index.mjs`,
  );
}

for (const pageName of [
  "AccountSettingsPage",
  "PricingSettingsPage",
  "StoresSettingsPage",
  "ProfitTrendPage",
  "DataScreenPage",
]) {
  assert.doesNotMatch(
    appEntry,
    new RegExp(`function\\s+${pageName}\\s*\\(`),
    `${pageName} must remain an independent page module`,
  );
}

console.log("module boundary guards passed");
