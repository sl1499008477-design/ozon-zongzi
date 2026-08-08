import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../index.mjs", import.meta.url), "utf8");
const webRuntimeSource = fs.readFileSync(new URL("../auto-listing-web-runtime.mjs", import.meta.url), "utf8");

test("server mounts the AI admin handler before the broad legacy state transaction", () => {
  assert.match(source, /import \{ createAutoListingWebRuntime \} from "\.\/auto-listing-web-runtime\.mjs";/u);
  assert.match(webRuntimeSource, /createAutoListingAiAdminRuntime/u);
  assert.match(webRuntimeSource, /createAutoListingAiAdminHttpHandler/u);
  assert.match(webRuntimeSource, /maxBytes: 256 \* 1024/u);
  const adminCall = source.indexOf("if (await autoListingWebRuntime.handleAiAdminRoute(req, res, url)) return;");
  const broadTransaction = source.indexOf("return jsonStateTransaction.run(async () => {", adminCall);
  assert.ok(adminCall > 0);
  assert.ok(broadTransaction > adminCall);
});

test("server mounts and lifecycle-manages the isolated user workflow before legacy routes", () => {
  assert.match(webRuntimeSource, /createAutoListingUserWorkflowRuntime/u);
  assert.match(webRuntimeSource, /createAutoListingUserWorkflowHttpHandler/u);
  assert.match(webRuntimeSource, /autoListingExcelRequestBodyLimit/u);
  assert.match(source, /autoListingSkuCollectionService\.collectOzonSkuForAccount\(input\)/u);
  assert.match(source, /if \(await autoListingWebRuntime\.handleUserWorkflowRoute\(req, res, url\)\) return;/u);
  assert.match(source, /autoListingWebRuntime\.startWorkers\(\)/u);
  assert.match(source, /autoListingWebRuntime\.stopWorkers\(\)/u);
  assert.match(source, /mirrorCollectItemV3\(item, \{[\s\S]*accountId: account\.id,[\s\S]*captureRaw: true/u);
});

test("server mounts the isolated ordinary-user item command runtime before legacy state", () => {
  assert.match(webRuntimeSource, /createAutoListingItemRuntime/u);
  assert.match(webRuntimeSource, /createAutoListingItemHttpHandler/u);
  const itemCall = source.indexOf("if (await autoListingWebRuntime.handleItemRoute(req, res, url)) return;");
  const broadTransaction = source.indexOf("return jsonStateTransaction.run(async () => {", itemCall);
  assert.ok(itemCall > 0);
  assert.ok(broadTransaction > itemCall);
});

test("server mounts authenticated review asset reads before item JSON actions and legacy state", () => {
  assert.match(webRuntimeSource, /createAutoListingReviewAssetHttpHandler/u);
  const assetCall = source.indexOf("if (await autoListingWebRuntime.handleReviewAssetRoute(req, res, url)) return;");
  const itemCall = source.indexOf("if (await autoListingWebRuntime.handleItemRoute(req, res, url)) return;");
  const broadTransaction = source.indexOf("return jsonStateTransaction.run(async () => {", assetCall);
  assert.ok(assetCall > 0);
  assert.ok(itemCall > assetCall);
  assert.ok(broadTransaction > itemCall);
});

test("server mounts the upload-policy admin and explicit publication-health handler", () => {
  assert.match(webRuntimeSource, /createAutoListingUploadPolicyAdminRuntime/u);
  assert.match(webRuntimeSource, /createAutoListingUploadPolicyAdminHttpHandler/u);
  assert.match(webRuntimeSource, /createListingAssetPublicationRuntime/u);
  assert.match(webRuntimeSource, /createListingAssetPublicationProbe/u);
  assert.match(webRuntimeSource, /createAutoListingDirectSystemReadiness/u);
  assert.doesNotMatch(webRuntimeSource, /directSystemNotReady/u);
  assert.match(webRuntimeSource, /createUploadRuntime\(\{[\s\S]*?assertDirectSystemReady,/u);
  assert.match(webRuntimeSource, /probePublicPolicy = createListingAssetPublicationProbe\(\{ storage \}\)/u);
  const policyCall = source.indexOf("if (await autoListingWebRuntime.handleAdminRoute(req, res, url)) return;");
  const broadTransaction = source.indexOf("return jsonStateTransaction.run(async () => {", policyCall);
  assert.ok(policyCall > 0);
  assert.ok(broadTransaction > policyCall);
});

test("server mounts the account-scoped reconciliation dead-task recovery behind the combined admin route", () => {
  assert.match(webRuntimeSource, /createAutoListingSubmissionReconciliationAdminRuntime/u);
  assert.match(webRuntimeSource, /createAutoListingSubmissionReconciliationAdminHttpHandler/u);
  assert.match(webRuntimeSource, /handleReconciliationAdminRoute/u);
  assert.match(webRuntimeSource, /async function handleAdminRoute/u);
  assert.match(source, /if \(await autoListingWebRuntime\.handleAdminRoute\(req, res, url\)\) return;/u);
});
