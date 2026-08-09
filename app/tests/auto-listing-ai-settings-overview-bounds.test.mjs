import assert from "node:assert/strict";
import test from "node:test";

import {
  createLatestAiSettingsLoader,
  loadAiSettings,
  loadAiSettingsCatalog,
} from "../src/auto-listing-ai-settings-client.js";

const NOW = "2026-08-09T00:00:00.000Z";

function response(data) {
  return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, data }) };
}

function modelCatalog(modelCount = 2_000) {
  const models = Array.from({ length: modelCount }, (_unused, index) => ({
    id: `model-${String(index).padStart(4, "0")}`,
    ownedBy: "provider",
    metadata: {},
  }));
  return {
    schemaVersion: "AUTO_LISTING_AI_MODEL_CATALOG_V1", connectionVersion: 1,
    syncedAt: NOW, requestIdHash: "c".repeat(64), activeSelectionState: "NOT_SELECTED",
    activeSelection: null, models,
    recommendation: {
      ruleVersion: "AUTO_LISTING_MODEL_RECOMMENDATION_V1", verified: false,
      textCandidates: [], imageCandidates: [],
      warnings: ["RECOMMENDATIONS_UNVERIFIED", "NO_TEXT_MODEL_CANDIDATE", "NO_IMAGE_MODEL_CANDIDATE"],
    },
  };
}

function catalogDetail() {
  return {
    accountId: "account-a",
    catalog: {
      id: "catalog-a", accountId: "account-a", connectionId: "connection-a", connectionVersion: 1,
      syncTaskId: "sync-a", catalog: modelCatalog(), catalogHash: "a".repeat(64),
      capabilityResult: { outcome: "NOT_TESTED", checkedAt: NOW, text: false, image: false },
      capabilityHash: "b".repeat(64), rollbackEvidenceIdentity: null, testedAt: NOW, createdAt: NOW,
    },
    actions: { canCreateProfile: true },
  };
}

function overview() {
  return {
    accountId: "account-a", activeConnection: null, activeProfile: null,
    connections: [], catalogs: [], syncTasks: [], profiles: [],
    pagination: {
      connections: { pageSize: 10, hasMore: true, nextCursor: "Y3Vyc29y" },
      profiles: { pageSize: 10, hasMore: false, nextCursor: null },
    },
    actions: { canCreateConnection: true, syncableConnectionIds: [], profileCreatableCatalogIds: [],
      testableProfileIds: [], publishableProfileIds: [], rollbackProfileIds: [] },
  };
}

test("overview stays at 64 KiB while the explicit catalog endpoint accepts a valid 2000-model snapshot", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return String(url).includes("/catalogs/") ? response(catalogDetail()) : response(overview());
  };
  const page = await loadAiSettings({ connectionCursor: "Y3Vyc29y" });
  assert.equal(page.pagination.connections.hasMore, true);
  assert.match(calls[0], /connectionCursor=Y3Vyc29y/u);
  const detail = await loadAiSettingsCatalog("catalog-a");
  assert.equal(detail.catalog.catalog.models.length, 2_000);
  assert.equal(detail.actions.canCreateProfile, true);
  assert.equal(Buffer.byteLength(JSON.stringify({ ok: true, data: detail }), "utf8") > 64 * 1024, true);
  assert.match(calls[1], /\/api\/admin\/auto-listing\/ai-settings\/catalogs\/catalog-a$/u);
});

test("overview pagination rejects duplicate page rows and malformed explicit cursors", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => response({ ...overview(), connections: [{ id: "duplicate" }, { id: "duplicate" }] });
  await assert.rejects(loadAiSettings(), { code: "AI_SETTINGS_CLIENT_RESPONSE_INVALID" });
  await assert.rejects(loadAiSettings({ connectionCursor: "not+base64" }), {
    code: "AI_SETTINGS_CLIENT_REQUEST_INVALID",
  });
});

test("latest-only loader rejects a late catalog response after a newer selection completes", async () => {
  const pending = new Map();
  const loader = createLatestAiSettingsLoader((catalogId) => new Promise((resolve) => {
    pending.set(catalogId, resolve);
  }));
  const first = loader.run("catalog-old");
  const second = loader.run("catalog-new");
  pending.get("catalog-new")({ id: "catalog-new" });
  assert.deepEqual(await second, { accepted: true, value: { id: "catalog-new" } });
  pending.get("catalog-old")({ id: "catalog-old" });
  assert.deepEqual(await first, { accepted: false, value: null });
});
