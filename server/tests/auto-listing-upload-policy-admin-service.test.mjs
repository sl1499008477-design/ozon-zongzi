import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingUploadPolicyAdminService } from "../auto-listing-upload-policy-admin-service.mjs";

const admin = Object.freeze({ id: "account-a", role: "admin" });
const policy = Object.freeze({
  origin: "https://media.example.com",
  baseUrl: "https://media.example.com/listing/",
  prefix: "listing-media/v2",
  publicationVersion: "LISTING_MEDIA_V2",
});

function harness() {
  const calls = [];
  const repository = {
    async findPolicyReplay(input) {
      calls.push(["replay", input]);
      return null;
    },
    async listPolicies(input) {
      calls.push(["list", input]);
      return [{
        id: "policy-a", accountId: "account-a", version: 1, mode: "REVIEW", enabled: true,
        publicationReason: "开发期间人工审核", publishedBy: "account-a",
        publishedAt: "2026-08-08T00:00:00.000Z", publicationOrigin: policy.origin,
        publicationBaseUrl: policy.baseUrl, publicationPrefix: policy.prefix,
        publicationVersion: policy.publicationVersion, publicationPolicyHash: "a".repeat(64),
      }];
    },
    async publishPolicy(input) {
      calls.push(["publish", input]);
      return {
        id: "policy-next", accountId: input.accountId, version: 2, mode: input.mode,
        enabled: true, publicationReason: input.publicationReason, publishedBy: input.actorId,
        publishedAt: "2026-08-08T00:01:00.000Z", publicationOrigin: input.publicationOrigin,
        publicationBaseUrl: input.publicationBaseUrl, publicationPrefix: input.publicationPrefix,
        publicationVersion: input.publicationVersion, publicationPolicyHash: input.publicationPolicyHash,
        duplicate: false,
      };
    },
  };
  const readiness = [];
  const healthChecks = [];
  const service = createAutoListingUploadPolicyAdminService({
    repository,
    publicationPolicy: policy,
    assertDirectReady: async (input) => {
      readiness.push(input);
      return { ready: true, evidenceId: "health-a", expiresAt: "2026-08-08T01:00:00.000Z" };
    },
    checkPublicationHealth: async (input) => {
      healthChecks.push(input);
      return {
        accountId: input.accountId, evidenceId: "health-a", outcome: "PASSED",
        checkedAt: "2026-08-08T00:00:00.000Z", expiresAt: "2026-08-08T00:05:00.000Z",
      };
    },
  });
  return { service, calls, readiness, healthChecks };
}

test("only an account admin may list or publish immutable upload policies", async () => {
  const { service, calls } = harness();
  await assert.rejects(service.listPolicies({ actor: { id: "account-a", role: "member" } }), {
    code: "PERMISSION_FORBIDDEN",
  });
  await assert.rejects(service.publishPolicy({
    actor: { id: "account-a", role: "member" }, mode: "REVIEW", publicationReason: "test",
    idempotencyKey: "policy-key", correlationId: "correlation-a",
  }), { code: "PERMISSION_FORBIDDEN" });
  assert.deepEqual(calls, []);
});

test("review publication freezes the server media policy and never accepts caller URL fields", async () => {
  const { service, calls, readiness } = harness();
  const result = await service.publishPolicy({
    actor: admin, mode: "REVIEW", publicationReason: "开发期间人工审核",
    idempotencyKey: "policy-key", correlationId: "correlation-a",
  });
  assert.equal(result.mode, "REVIEW");
  assert.equal(result.publicationBaseUrl, policy.baseUrl);
  assert.match(result.publicationPolicyHash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(readiness, []);
  const stored = calls.find(([kind]) => kind === "publish")[1];
  assert.equal(stored.publicationVersion, "LISTING_MEDIA_V2");
  assert.equal(Object.hasOwn(stored, "healthEvidenceId"), true);
  assert.equal(stored.healthEvidenceId, null);

  await assert.rejects(service.publishPolicy({
    actor: admin, mode: "REVIEW", publicationReason: "开发期间人工审核",
    idempotencyKey: "policy-other", correlationId: "correlation-b",
    publicationBaseUrl: "https://evil.example/",
  }), { code: "AUTO_LISTING_UPLOAD_POLICY_ADMIN_INVALID" });
});

test("a completed DIRECT command replays before current rollout or media health is checked", async () => {
  let readinessChecks = 0;
  const replay = {
    id: "policy-direct", accountId: "account-a", version: 2, mode: "DIRECT", enabled: true,
    publicationReason: "验收后开启全自动", publishedBy: "account-a",
    publishedAt: "2026-08-08T00:01:00.000Z", publicationOrigin: policy.origin,
    publicationBaseUrl: policy.baseUrl, publicationPrefix: policy.prefix,
    publicationVersion: policy.publicationVersion, publicationPolicyHash: "a".repeat(64), duplicate: true,
  };
  const service = createAutoListingUploadPolicyAdminService({
    repository: {
      findPolicyReplay: async () => replay,
      listPolicies: async () => [],
      publishPolicy: async () => assert.fail("a replay must not publish again"),
    },
    publicationPolicy: policy,
    assertDirectReady: async () => { readinessChecks += 1; throw new Error("expired"); },
    checkPublicationHealth: async () => null,
  });
  assert.deepEqual(await service.publishPolicy({
    actor: admin, mode: "DIRECT", publicationReason: "验收后开启全自动",
    idempotencyKey: "direct-key", correlationId: "correlation-replay",
  }), replay);
  assert.equal(readinessChecks, 0);
});

test("an admin can explicitly run the publication health check", async () => {
  const { service, healthChecks } = harness();
  const result = await service.checkPublicationHealth({ actor: admin });
  assert.equal(result.outcome, "PASSED");
  assert.deepEqual(healthChecks, [{ accountId: "account-a", checkedByAccountId: "account-a" }]);
});

test("direct policy publication requires a fresh account-scoped media readiness proof", async () => {
  const { service, calls, readiness } = harness();
  const result = await service.publishPolicy({
    actor: admin, mode: "DIRECT", publicationReason: "验收后开启全自动",
    idempotencyKey: "direct-key", correlationId: "correlation-direct",
  });
  assert.equal(result.mode, "DIRECT");
  assert.deepEqual(readiness, [{ accountId: "account-a" }]);
  assert.equal(calls.find(([kind]) => kind === "publish")[1].healthEvidenceId, "health-a");

  const blocked = createAutoListingUploadPolicyAdminService({
    repository: { findPolicyReplay: async () => null, listPolicies: async () => [], publishPolicy: async () => assert.fail("must not persist") },
    publicationPolicy: policy,
    assertDirectReady: async () => { const error = new Error("not ready"); error.code = "LISTING_ASSET_PUBLICATION_NOT_READY"; throw error; },
    checkPublicationHealth: async () => null,
  });
  await assert.rejects(blocked.publishPolicy({
    actor: admin, mode: "DIRECT", publicationReason: "direct",
    idempotencyKey: "direct-fail", correlationId: "correlation-fail",
  }), { code: "AUTO_LISTING_DIRECT_POLICY_NOT_READY" });
});

test("listing is tenant scoped and rejects repository rows from another account", async () => {
  const { service, calls } = harness();
  const rows = await service.listPolicies({ actor: admin });
  assert.equal(rows.length, 1);
  assert.deepEqual(calls[0], ["list", { accountId: "account-a" }]);

  const invalid = createAutoListingUploadPolicyAdminService({
    repository: {
      findPolicyReplay: async () => null,
      listPolicies: async () => [{ id: "policy-b", accountId: "account-b", version: 1, mode: "REVIEW",
        enabled: true, publicationReason: "bad", publishedBy: "account-b",
        publishedAt: "2026-08-08T00:00:00.000Z", publicationOrigin: policy.origin,
        publicationBaseUrl: policy.baseUrl, publicationPrefix: policy.prefix,
        publicationVersion: policy.publicationVersion, publicationPolicyHash: "a".repeat(64) }],
      publishPolicy: async () => null,
    }, publicationPolicy: policy, assertDirectReady: async () => null, checkPublicationHealth: async () => null,
  });
  await assert.rejects(invalid.listPolicies({ actor: admin }), {
    code: "AUTO_LISTING_UPLOAD_POLICY_ADMIN_DATA_BOUNDARY",
  });
});
