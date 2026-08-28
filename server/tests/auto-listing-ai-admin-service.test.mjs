import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingAiAdminService } from "../auto-listing-ai-admin-service.mjs";

const admin = Object.freeze({ id: "account-admin", role: "admin" });
const ordinary = Object.freeze({ id: "account-user", role: "user" });

const profileInput = Object.freeze({
  displayName: "Primary Sub2API",
  baseUrl: "https://gateway.example/v1",
  apiKeyEnvName: "SUB2API_PRIMARY_KEY",
  textProtocol: "SUB2API_RESPONSES",
  imageProtocol: "SUB2API_OPENAI_IMAGES",
  textModel: "text-model-a",
  imageModel: "image-model-a",
});

const profileRow = Object.freeze({
  id: "profile-a",
  accountId: "account-admin",
  displayName: "Primary Sub2API",
  configVersion: 1,
  baseUrl: "https://gateway.example/v1",
  apiKeyEnvName: "SUB2API_PRIMARY_KEY",
  textProtocol: "SUB2API_RESPONSES",
  imageProtocol: "SUB2API_OPENAI_IMAGES",
  textModel: "text-model-a",
  imageModel: "image-model-a",
  enabled: false,
  capabilityResult: {},
  capabilityCheckedAt: null,
  connectionId: null,
  connectionVersion: null,
  createdAt: "2026-08-04T10:00:00.000Z",
});

function fixture({
  capabilityResult = null,
  capabilityError = null,
  allowLocalGateway = false,
  resolveGatewayHostname = async () => [{ address: "203.0.113.10", family: 4 }],
  allowedSecretEnvNames = ["SUB2API_PRIMARY_KEY"],
  allowedGatewayBaseUrls = ["https://gateway.example/v1"],
  gatewayDnsTimeoutMs = 5_000,
  strategyRows = [],
} = {}) {
  const calls = [];
  const repository = {
    async createProfile(input) { calls.push(["createProfile", input]); return { ...profileRow, duplicate: false }; },
    async listProfiles(input) { calls.push(["listProfiles", input]); return [{ ...profileRow }]; },
    async recordCapabilityAudit(input) { calls.push(["recordCapabilityAudit", input]); return { recorded: true }; },
    async publishProfile(input) { calls.push(["publishProfile", input]); return { ...profileRow, enabled: true, duplicate: false }; },
    async createStrategyVersion(input) {
      calls.push(["createStrategyVersion", input]);
      return { id: "strategy-version-a", accountId: input.accountId, strategyKey: input.strategyKey,
        version: input.version, status: "DRAFT", content: input.content, rules: input.rules, duplicate: false };
    },
    async listStrategyVersions(input) { calls.push(["listStrategyVersions", input]); return strategyRows; },
    async publishStrategyVersion(input) {
      calls.push(["publishStrategyVersion", input]);
      return { id: input.strategyVersionId, accountId: input.accountId, strategyKey: input.strategyKey,
        version: input.version, status: "PUBLISHED", duplicate: false };
    },
    async publishCategoryStrategyDraft(input) {
      calls.push(["publishCategoryStrategyDraft", input]);
      return {
        id: "strategy-category-v2", accountId: input.accountId, strategyKey: "default", version: 8,
        status: "PUBLISHED", content: { schemaVersion: "V2" }, duplicate: false,
        rules: [{
          ruleId: "category-rule-v2", ruleOrder: 1, matchType: "EXACT_CATEGORY_TYPE_V2",
          scope: { taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 170, typeId: 99 },
          overallStyle: "clean", prohibitedPatterns: ["clutter"],
          roleGuidance: Object.fromEntries([
            "MAIN", "SELLING_POINT", "DETAIL", "SCENE", "SPECIFICATION", "INFOGRAPHIC",
          ].map((role) => [role, {
            composition: `${role} composition`, background: `${role} background`,
            textDensity: role === "MAIN" ? "NONE" : "LIGHT", layout: `${role} layout`,
          }])),
          sampleSetHash: "a".repeat(64), analysisAttemptId: "category-attempt-a",
          analysisResultId: "category-result-a",
        }],
      };
    },
    async archiveCategoryStrategyDraft(input) {
      calls.push(["archiveCategoryStrategyDraft", input]);
      return {
        draftId: input.draftId,
        accountId: input.accountId,
        removed: true,
        draftVersion: input.expectedDraftVersion + 1,
        activeStrategyChanged: true,
        strategyVersionId: "strategy-category-v9",
        strategyVersion: 9,
        duplicate: false,
      };
    },
    async rollbackCategoryStrategyVersion(input) {
      calls.push(["rollbackCategoryStrategyVersion", input]);
      return { id: "strategy-category-rollback", accountId: input.accountId, strategyKey: "default",
        version: 9, status: "PUBLISHED", content: { schemaVersion: "V2" }, rules: [], duplicate: false };
    },
  };
  const capabilityService = {
    async testGatewayCapabilities(input) {
      calls.push(["testGatewayCapabilities", input]);
      if (capabilityError) throw capabilityError;
      return capabilityResult || {
        profileId: "profile-a", configVersion: 1, outcome: "PASSED",
        features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"],
        latencyMs: 80, models: { text: "text-model-a", image: "image-model-a" },
        checkedAt: "2026-08-04T10:01:00.000Z", errorCode: null, enabled: true,
        requestIds: { image: "must-not-leak" },
      };
    },
  };
  return {
    calls,
    repository,
    service: createAutoListingAiAdminService({
      repository, capabilityService, allowLocalGateway, resolveGatewayHostname,
      allowedSecretEnvNames, allowedGatewayBaseUrls,
      gatewayDnsTimeoutMs,
    }),
  };
}

const validRule = Object.freeze({
  ruleId: "rule-a",
  ruleOrder: 1,
  matchType: "EXACT_CATEGORY",
  categoryId: "category-a",
  style: "VISUAL_FIRST",
  textDensityByRole: { MAIN: "NONE", SELLING_POINT: "LIGHT" },
});

test("profile creation fails closed unless both the secret reference and exact gateway are deployment-approved", async () => {
  for (const options of [
    { allowedSecretEnvNames: [] },
    { allowedGatewayBaseUrls: [] },
    { allowedSecretEnvNames: ["SUB2API_OTHER_KEY"] },
    { allowedGatewayBaseUrls: ["https://other.example/v1"] },
  ]) {
    const { service, calls } = fixture(options);
    await assert.rejects(service.createGatewayProfile({
      actor: admin, idempotencyKey: "idem-policy", correlationId: "corr-policy", profile: profileInput,
    }), (error) => error?.code === "AUTO_LISTING_AI_ADMIN_PROFILE_INVALID");
    assert.deepEqual(calls, []);
  }
});

test("every admin operation rejects ordinary users before repository or capability work", async () => {
  const { service, calls } = fixture();
  const invocations = [
    () => service.createGatewayProfile({ actor: ordinary, idempotencyKey: "idem-a", correlationId: "corr-a", profile: profileInput }),
    () => service.listGatewayProfiles({ actor: ordinary }),
    () => service.testGatewayCapabilities({ costConfirmed: true, actor: ordinary, profileId: "profile-a", configVersion: 1, correlationId: "corr-a" }),
    () => service.publishGatewayProfile({ actor: ordinary, profileId: "profile-a", configVersion: 1,
      idempotencyKey: "idem-a", correlationId: "corr-a" }),
    () => service.createStrategyVersion({ actor: ordinary, strategyKey: "default", version: 1,
      idempotencyKey: "idem-a", correlationId: "corr-a", content: { schemaVersion: "V1" }, rules: [validRule] }),
    () => service.listStrategyVersions({ actor: ordinary, strategyKey: "default" }),
    () => service.publishStrategyVersion({ actor: ordinary, strategyKey: "default", strategyVersionId: "strategy-version-a",
      version: 1, idempotencyKey: "idem-a", correlationId: "corr-a" }),
    () => service.publishCategoryStrategyDraft({ actor: ordinary, draftId: "category-draft-a",
      expectedDraftVersion: 4, expectedPublishedStrategyVersionId: "strategy-version-a",
      idempotencyKey: "idem-a", correlationId: "corr-a" }),
    () => service.archiveCategoryStrategyDraft({ actor: ordinary, draftId: "category-draft-a",
      expectedDraftVersion: 4, idempotencyKey: "idem-a", correlationId: "corr-a" }),
    () => service.rollbackCategoryStrategyVersion({ actor: ordinary,
      targetStrategyVersionId: "strategy-version-old", expectedPublishedStrategyVersionId: "strategy-version-a",
      idempotencyKey: "idem-a", correlationId: "corr-a" }),
  ];
  for (const invoke of invocations) {
    await assert.rejects(invoke(), (error) => error?.code === "PERMISSION_FORBIDDEN");
  }
  assert.deepEqual(calls, []);
});

test("profile creation accepts only a closed secret reference and returns a minimally exposed DTO", async () => {
  const { service, calls } = fixture();
  const result = await service.createGatewayProfile({
    actor: admin, idempotencyKey: "idem-profile-a", correlationId: "corr-profile-a", profile: profileInput,
  });
  assert.deepEqual(calls[0], ["createProfile", {
    accountId: "account-admin", actorId: "account-admin", idempotencyKey: "idem-profile-a",
    correlationId: "corr-profile-a", profile: { ...profileInput, configVersion: 1 },
  }]);
  assert.equal(result.apiKeyEnvNameMasked, "SUB2…_KEY");
  assert.equal(result.enabled, false);
  assert.equal(Object.hasOwn(result, "apiKeyEnvName"), false);
  assert.doesNotMatch(JSON.stringify(result), /SUB2API_PRIMARY_KEY|raw.?key|secret/i);

  for (const invalidProfile of [
    { ...profileInput, apiKey: "raw-secret" },
    { ...profileInput, apiKeyEnvName: "OPENAI_API_KEY" },
    { ...profileInput, baseUrl: "http://127.0.0.1:8080" },
    { ...profileInput, baseUrl: "https://[::1]/v1" },
    { ...profileInput, baseUrl: "https://[fc00::1]/v1" },
    { ...profileInput, baseUrl: "https://user:pass@gateway.example/v1" },
    { ...profileInput, baseUrl: "https://gateway.example/v1?redirect=https://evil.example" },
    { ...profileInput, textProtocol: "OPENAI_CHAT" },
    { ...profileInput, imageProtocol: "UNKNOWN" },
    { ...profileInput, textModel: "" },
  ]) {
    await assert.rejects(
      service.createGatewayProfile({ actor: admin, idempotencyKey: "idem-invalid", correlationId: "corr-invalid", profile: invalidProfile }),
      (error) => error?.code === "AUTO_LISTING_AI_ADMIN_PROFILE_INVALID",
    );
  }
  assert.equal(calls.filter(([name]) => name === "createProfile").length, 1);
});

test("profile creation rejects DNS answers that cross into private networks before persistence", async () => {
  const { service, calls } = fixture({
    resolveGatewayHostname: async () => [
      { address: "203.0.113.10", family: 4 },
      { address: "fd00::5", family: 6 },
    ],
  });
  await assert.rejects(service.createGatewayProfile({
    actor: admin, idempotencyKey: "idem-private-dns", correlationId: "corr-private-dns", profile: profileInput,
  }), (error) => error?.code === "AUTO_LISTING_AI_ADMIN_PROFILE_INVALID"
    && !/fd00|203\.0\.113/iu.test(error.message));
  assert.equal(calls.length, 0);
});

test("profile creation reports DNS lookup failure as safe retryable infrastructure unavailability", async () => {
  const { service, calls } = fixture({
    resolveGatewayHostname: async () => { throw new Error("resolver leaked internal.gateway 10.0.0.4"); },
  });
  await assert.rejects(service.createGatewayProfile({
    actor: admin, idempotencyKey: "idem-dns-failed", correlationId: "corr-dns-failed", profile: profileInput,
  }), (error) => error?.code === "AUTO_LISTING_AI_ADMIN_GATEWAY_DNS_FAILED"
    && error?.status === 503 && error?.retryable === true
    && !/internal|10\.0\.0\.4|resolver leaked/iu.test(error.message));
  assert.equal(calls.length, 0);
});

test("profile creation DNS verification has a bounded timeout", async () => {
  const { service, calls } = fixture({
    gatewayDnsTimeoutMs: 10,
    resolveGatewayHostname: () => new Promise(() => {}),
  });
  await assert.rejects(service.createGatewayProfile({
    actor: admin, idempotencyKey: "idem-dns-timeout", correlationId: "corr-dns-timeout", profile: profileInput,
  }), (error) => error?.code === "AUTO_LISTING_AI_ADMIN_GATEWAY_DNS_FAILED"
    && error?.retryable === true);
  assert.deepEqual(calls, []);
});

test("an explicit development switch permits a loopback gateway without weakening production defaults", async () => {
  const { service, calls } = fixture({
    allowLocalGateway: true,
    allowedGatewayBaseUrls: ["http://[::1]:8080/v1"],
    resolveGatewayHostname: async () => [{ address: "::1", family: 6 }],
  });
  await service.createGatewayProfile({
    actor: admin, idempotencyKey: "idem-local", correlationId: "corr-local",
    profile: { ...profileInput, baseUrl: "http://[::1]:8080/v1" },
  });
  assert.equal(calls[0][0], "createProfile");
  assert.equal(calls[0][1].profile.baseUrl, "http://[::1]:8080/v1");
});

test("profile reads redact environment names and never expose repository-only account scope", async () => {
  const { service } = fixture();
  const rows = await service.listGatewayProfiles({ actor: admin });
  assert.deepEqual(rows, [{
    id: "profile-a", displayName: "Primary Sub2API", configVersion: 1,
    baseUrl: "https://gateway.example/v1", apiKeyEnvNameMasked: "SUB2…_KEY",
    textProtocol: "SUB2API_RESPONSES", imageProtocol: "SUB2API_OPENAI_IMAGES",
    textModel: "text-model-a", imageModel: "image-model-a", enabled: false,
    connectionId: null, connectionVersion: null,
    capabilityOutcome: null, capabilityCheckedAt: null, createdAt: "2026-08-04T10:00:00.000Z",
  }]);
});

test("capability testing reuses the service whose repository transaction owns result and audit persistence", async () => {
  const { service, calls } = fixture();
  const result = await service.testGatewayCapabilities({ costConfirmed: true,
    actor: admin, profileId: "profile-a", configVersion: 1, correlationId: "corr-capability-a",
  });
  assert.deepEqual(calls[0], ["testGatewayCapabilities", {
    actor: admin, profileId: "profile-a", configVersion: 1, correlationId: "corr-capability-a",
    costConfirmed: true,
  }]);
  assert.equal(calls.length, 1);
  assert.deepEqual(result, {
    profileId: "profile-a", configVersion: 1, outcome: "PASSED",
    features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"], latencyMs: 80,
    models: { text: "text-model-a", image: "image-model-a" }, checkedAt: "2026-08-04T10:01:00.000Z",
    errorCode: null, publishReady: true,
  });
  assert.doesNotMatch(JSON.stringify(result), /requestIds|enabled|secret|api.?key/i);
});

test("legacy admin capability service rejects missing cost confirmation before paid work", async () => {
  const { service, calls } = fixture();
  await assert.rejects(service.testGatewayCapabilities({
    actor: admin, profileId: "profile-a", configVersion: 1,
    correlationId: "corr-unconfirmed", costConfirmed: false,
  }), { code: "AI_GATEWAY_COST_CONFIRMATION_REQUIRED", status: 409 });
  assert.deepEqual(calls, []);
});

test("known capability service failures are re-created with only their stable code", async () => {
  const failure = Object.assign(new Error("raw database details"), { code: "AI_GATEWAY_PROFILE_VERSION_CONFLICT" });
  const { service, calls } = fixture({ capabilityError: failure });
  await assert.rejects(
    service.testGatewayCapabilities({ costConfirmed: true, actor: admin, profileId: "profile-a", configVersion: 1, correlationId: "corr-failed" }),
    (error) => error !== failure && error?.code === "AI_GATEWAY_PROFILE_VERSION_CONFLICT"
      && !/raw database details/iu.test(error?.message || ""),
  );
  assert.deepEqual(calls, [["testGatewayCapabilities", {
    actor: admin, profileId: "profile-a", configVersion: 1, correlationId: "corr-failed",
    costConfirmed: true,
  }]]);
});

test("unknown capability failures are mapped to a closed safe admin error", async () => {
  const failure = Object.assign(new Error("password=prod-secret host=internal"), {
    code: "PASSWORD_PROD_SECRET",
  });
  const { service } = fixture({ capabilityError: failure });
  await assert.rejects(
    service.testGatewayCapabilities({ costConfirmed: true, actor: admin, profileId: "profile-a", configVersion: 1, correlationId: "corr-unsafe" }),
    (error) => error !== failure
      && error?.code === "AUTO_LISTING_AI_CAPABILITY_FAILED"
      && !/password|prod-secret|internal/iu.test(error?.message || ""),
  );
});

test("profile publish passes only exact account profile and version authority to the repository", async () => {
  const { service, calls } = fixture();
  const result = await service.publishGatewayProfile({
    actor: admin, profileId: "profile-a", configVersion: 1,
    idempotencyKey: "idem-publish-profile", correlationId: "corr-publish-profile",
  });
  assert.deepEqual(calls[0], ["publishProfile", {
    accountId: "account-admin", actorId: "account-admin", profileId: "profile-a", configVersion: 1,
    idempotencyKey: "idem-publish-profile", correlationId: "corr-publish-profile",
  }]);
  assert.equal(result.enabled, true);
  assert.equal(Object.hasOwn(result, "apiKeyEnvName"), false);
});

test("strategy creation requires an explicit version and closed validated rules", async () => {
  const { service, calls } = fixture();
  const result = await service.createStrategyVersion({
    actor: admin, strategyKey: "default", version: 7, idempotencyKey: "idem-strategy-7",
    correlationId: "corr-strategy-7", content: { schemaVersion: "V1" }, rules: [validRule],
  });
  assert.equal(result.version, 7);
  assert.deepEqual(calls[0], ["createStrategyVersion", {
    accountId: "account-admin", actorId: "account-admin", strategyKey: "default", version: 7,
    idempotencyKey: "idem-strategy-7", correlationId: "corr-strategy-7",
    content: { schemaVersion: "V1" }, rules: [{ ...validRule }],
  }]);

  for (const input of [
    { strategyKey: "default", version: undefined, content: { schemaVersion: "V1" }, rules: [validRule] },
    { strategyKey: "default", version: 8, content: { schemaVersion: "V2" }, rules: [validRule] },
    { strategyKey: "default", version: 8, content: { schemaVersion: "V1", prompt: "hidden" }, rules: [validRule] },
    { strategyKey: "default", version: 8, content: { schemaVersion: "V1" }, rules: [{ ...validRule, matchType: "ANY" }] },
    { strategyKey: "default", version: 8, content: { schemaVersion: "V1" }, rules: [{ ...validRule, apiKey: "raw" }] },
    { strategyKey: "default", version: 8, content: { schemaVersion: "V1" }, rules: [{ ...validRule,
      textDensityByRole: { NOT_A_ROLE: "LIGHT" } }] },
    { strategyKey: "default", version: 8, content: { schemaVersion: "V1" }, rules: [{ ...validRule,
      textDensityByRole: { MAIN: "SECRET_DENSITY" } }] },
    { strategyKey: "default", version: 8, content: { schemaVersion: "V1" }, rules: [{ ...validRule,
      textDensityByRole: { MAIN: "NONE", main: "LIGHT" } }] },
  ]) {
    await assert.rejects(
      service.createStrategyVersion({ actor: admin, idempotencyKey: "idem-invalid-strategy",
        correlationId: "corr-invalid-strategy", ...input }),
      (error) => error?.code === "AUTO_LISTING_AI_ADMIN_STRATEGY_INVALID",
    );
  }
  assert.equal(calls.filter(([name]) => name === "createStrategyVersion").length, 1);
});

test("strategy reads and publish remain account scoped and never infer a latest version", async () => {
  const { service, calls } = fixture();
  await service.listStrategyVersions({ actor: admin, strategyKey: "default" });
  const published = await service.publishStrategyVersion({
    actor: admin, strategyKey: "default", strategyVersionId: "strategy-version-a", version: 7,
    idempotencyKey: "idem-publish-strategy-7", correlationId: "corr-publish-strategy-7",
  });
  assert.deepEqual(calls, [
    ["listStrategyVersions", { accountId: "account-admin", strategyKey: "default" }],
    ["publishStrategyVersion", {
      accountId: "account-admin", actorId: "account-admin", strategyKey: "default",
      strategyVersionId: "strategy-version-a", version: 7,
      idempotencyKey: "idem-publish-strategy-7", correlationId: "corr-publish-strategy-7",
    }],
  ]);
  assert.equal(published.id, "strategy-version-a");
  assert.equal(published.version, 7);
});

test("strategy reads return the complete closed rule contract", async () => {
  const { service } = fixture({ strategyRows: [{
    id: "strategy-version-a", accountId: "account-admin", strategyKey: "default", version: 7,
    status: "PUBLISHED", content: { schemaVersion: "V1" }, rules: [{ ...validRule }],
  }] });
  const rows = await service.listStrategyVersions({ actor: admin, strategyKey: "default" });
  assert.deepEqual(rows[0].rules, [{ ...validRule }]);
  assert.doesNotMatch(JSON.stringify(rows), /secret|api.?key|credential/iu);
});

test("category draft publication passes exact account, draft, and current bundle CAS authority", async () => {
  const { service, calls } = fixture();
  const published = await service.publishCategoryStrategyDraft({
    actor: admin,
    draftId: "category-draft-a",
    expectedDraftVersion: 4,
    expectedPublishedStrategyVersionId: "strategy-version-a",
    idempotencyKey: "publish-category-a",
    correlationId: "publish-category-a-corr",
  });
  assert.deepEqual(calls[0], ["publishCategoryStrategyDraft", {
    accountId: "account-admin",
    actorId: "account-admin",
    draftId: "category-draft-a",
    expectedDraftVersion: 4,
    expectedPublishedStrategyVersionId: "strategy-version-a",
    idempotencyKey: "publish-category-a",
    correlationId: "publish-category-a-corr",
  }]);
  assert.deepEqual({ id: published.id, version: published.version, status: published.status }, {
    id: "strategy-category-v2", version: 8, status: "PUBLISHED",
  });
  await assert.rejects(service.publishCategoryStrategyDraft({
    actor: admin,
    draftId: "category-draft-a",
    expectedDraftVersion: 4,
    expectedPublishedStrategyVersionId: "strategy-version-a",
    idempotencyKey: "publish-category-extra",
    correlationId: "publish-category-extra-corr",
    accountId: "account-other",
  }), (error) => error?.code === "AUTO_LISTING_AI_ADMIN_REQUEST_INVALID");
  assert.equal(calls.filter(([name]) => name === "publishCategoryStrategyDraft").length, 1);
});

test("category rollback is a closed copy-on-write account version command", async () => {
  const { service, calls } = fixture();
  const rolledBack = await service.rollbackCategoryStrategyVersion({
    actor: admin,
    targetStrategyVersionId: "strategy-version-old",
    expectedPublishedStrategyVersionId: "strategy-version-current",
    idempotencyKey: "rollback-category",
    correlationId: "rollback-category-corr",
  });
  assert.deepEqual(calls[0], ["rollbackCategoryStrategyVersion", {
    accountId: "account-admin",
    actorId: "account-admin",
    targetStrategyVersionId: "strategy-version-old",
    expectedPublishedStrategyVersionId: "strategy-version-current",
    idempotencyKey: "rollback-category",
    correlationId: "rollback-category-corr",
  }]);
  assert.deepEqual({ id: rolledBack.id, version: rolledBack.version }, {
    id: "strategy-category-rollback", version: 9,
  });
});

test("category archive is account scoped and exposes only the auditable removal result", async () => {
  const { service, calls } = fixture();
  assert.deepEqual(await service.archiveCategoryStrategyDraft({
    actor: admin,
    draftId: "category-draft-a",
    expectedDraftVersion: 4,
    idempotencyKey: "archive-category",
    correlationId: "archive-category-corr",
  }), {
    draftId: "category-draft-a",
    removed: true,
    draftVersion: 5,
    activeStrategyChanged: true,
    strategyVersionId: "strategy-category-v9",
    strategyVersion: 9,
    duplicate: false,
  });
  assert.deepEqual(calls[0], ["archiveCategoryStrategyDraft", {
    accountId: "account-admin",
    actorId: "account-admin",
    draftId: "category-draft-a",
    expectedDraftVersion: 4,
    idempotencyKey: "archive-category",
    correlationId: "archive-category-corr",
  }]);
});
