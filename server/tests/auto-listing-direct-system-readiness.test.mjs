import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingDirectSystemReadiness } from "../auto-listing-direct-system-readiness.mjs";

const env = Object.freeze({
  AUTO_LISTING_ENABLED: "true",
  AUTO_LISTING_AI_ENABLED: "true",
  AUTO_LISTING_UPLOAD_ENABLED: "true",
  AUTO_LISTING_DIRECT_UPLOAD_ALLOWED: "true",
  LISTING_PIPELINE_V3: "1",
  AUTO_LISTING_AI_ALLOWED_SECRET_ENV_NAMES: "SUB2API_KEY",
  AUTO_LISTING_AI_ALLOWED_GATEWAY_BASE_URLS: "https://gateway.example.com/v1",
  SUB2API_KEY: "test-secret-value",
});

function profile(overrides = {}) {
  return {
    id: "profile-a", account_id: "account-a", config_version: 1,
    base_url: "https://gateway.example.com/v1", api_key_env_name: "SUB2API_KEY",
    text_protocol: "SUB2API_RESPONSES", image_protocol: "SUB2API_OPENAI_IMAGES",
    text_model: "text-model", image_model: "image-model", enabled: true,
    capability_checked_at: new Date("2026-08-08T00:00:00.000Z"),
    capability_result: {
      outcome: "PASSED",
      features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"],
      models: { text: "text-model", image: "image-model" },
      checkedAt: "2026-08-08T00:00:00.000Z",
    },
    ...overrides,
  };
}

function pool({ profiles = [profile()], strategies = [{ id: "strategy-a" }] } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql, values });
      if (/FROM accounts/u.test(sql)) return { rows: [{ id: "account-a" }] };
      if (/FROM ai_gateway_profiles/u.test(sql)) return { rows: profiles };
      if (/FROM ai_content_strategy_versions/u.test(sql)) return { rows: strategies };
      throw new Error("unexpected query");
    },
  };
}

test("DIRECT remains fail-closed while the Ozon rich-content adapter is explicitly unverified", async () => {
  for (const richContentContractVersion of [
    "AUTO_LISTING_OZON_RICH_CONTENT_V1_UNVERIFIED",
    "TYPO_OR_UNKNOWN",
    "AUTO_LISTING_OZON_RICH_CONTENT_V1_VERIFIED_TYPO",
  ]) {
    const db = pool();
    const readiness = createAutoListingDirectSystemReadiness({
      env, resolvePool: async () => db, richContentContractVersion,
    });
    await assert.rejects(readiness({ accountId: "account-a" }), {
      code: "AUTO_LISTING_DIRECT_SYSTEM_HEALTH_NOT_READY",
    });
    assert.equal(db.calls.length, 0);
  }
});

test("verified DIRECT readiness checks the account, one capable AI profile and a published strategy", async () => {
  const db = pool();
  const readiness = createAutoListingDirectSystemReadiness({
    env, resolvePool: async () => db,
    richContentContractVersion: "AUTO_LISTING_OZON_RICH_CONTENT_V1",
  });
  assert.deepEqual(await readiness({ accountId: "account-a" }), { ready: true });
  assert.equal(db.calls.length, 3);
  for (const call of db.calls) assert.deepEqual(call.values, ["account-a"]);
});

test("DIRECT readiness fails closed for missing scope, ambiguous/uncapable profiles or no published strategy", async () => {
  for (const fixture of [
    pool({ profiles: [] }),
    pool({ profiles: [profile(), profile({ id: "profile-b" })] }),
    pool({ profiles: [profile({ capability_result: { outcome: "FAILED" } })] }),
    pool({ strategies: [] }),
  ]) {
    const readiness = createAutoListingDirectSystemReadiness({
      env, resolvePool: async () => fixture,
      richContentContractVersion: "AUTO_LISTING_OZON_RICH_CONTENT_V1",
    });
    await assert.rejects(readiness({ accountId: "account-a" }), {
      code: "AUTO_LISTING_DIRECT_SYSTEM_HEALTH_NOT_READY",
    });
  }
});
