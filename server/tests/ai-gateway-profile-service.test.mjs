import assert from "node:assert/strict";
import test from "node:test";
import { createAiGatewayProfileService } from "../ai-gateway-profile-service.mjs";
import {
  assertAutoListingAiRuntimeConfiguration,
  assertProductionConfiguration,
  autoListingAiEnabled,
} from "../runtime-config.mjs";

const admin = { id: "account-admin", role: "admin" };
const ordinary = { id: "account-user", role: "user" };
const profile = Object.freeze({
  id: "profile-a",
  accountId: "account-admin",
  configVersion: 4,
  baseUrl: "https://gateway.example/v1",
  apiKeyEnvName: "SUB2API_PROFILE_A_KEY",
  textProtocol: "SUB2API_RESPONSES",
  imageProtocol: "SUB2API_OPENAI_IMAGES",
  textModel: "text-model-a",
  imageModel: "image-model-a",
  enabled: false,
});

function fixture({
  gatewayResult,
  gatewayError,
  completion = null,
  begin = null,
  logger = null,
  loadedProfile = profile,
} = {}) {
  const calls = [];
  const repository = {
    async beginCapabilityTest(input) {
      calls.push(["begin", input]);
      if (typeof begin === "function") return begin(input);
      if (begin) return begin;
      if (input.accountId !== loadedProfile.accountId || input.profileId !== loadedProfile.id
        || input.configVersion !== loadedProfile.configVersion) return null;
      return {
        profile: { ...loadedProfile }, attemptId: input.attemptId, fence: 11,
        status: "RUNNING", duplicate: false, reclaimed: false,
        leaseVersion: 1, leaseToken: "caplease_fixture", leaseExpiresAt: "2026-08-04T10:10:00.000Z",
        capabilityExecution: {
          accountId: loadedProfile.accountId,
          profileId: loadedProfile.id,
          configVersion: loadedProfile.configVersion,
          attemptId: input.attemptId,
          fence: 11,
          leaseVersion: 1,
          leaseToken: "caplease_fixture",
          purpose: input.purpose,
          authorizationHash: "a".repeat(64),
          requestKey: input.requestKey,
          connectionId: loadedProfile.connectionId ?? null,
          connectionVersion: loadedProfile.connectionVersion ?? null,
          expectedConnectionStatus: loadedProfile.connectionId
            ? (input.purpose === "ROLLBACK_CAPABILITY" ? "RETIRED" : "VALIDATED")
            : "LEGACY",
          expectedConnectionStatusVersion: loadedProfile.connectionId ? 2 : 0,
        },
      };
    },
    async completeCapabilityTest(input) {
      calls.push(["complete", input]);
      if (completion) return completion;
      return { applied: true, stale: false, duplicate: false,
        response: { profileId: input.profileId, configVersion: input.configVersion,
          ...input.capabilityResult, enabled: input.capabilityResult.outcome === "FAILED" ? false : loadedProfile.enabled } };
    },
  };
  const gateway = {
    async testCapabilities(input) {
      calls.push(["gateway", input]);
      if (gatewayError) throw gatewayError;
      return gatewayResult || {
        features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"],
        latencyMs: 321,
        models: { text: "text-model-a", image: "image-model-a" },
        modelEvidence: {
          requestedImageModel: "image-model-a",
          gatewayReportedImageModel: "image-model-a",
          gatewayReportedImageModelPresent: true,
          orchestratorModel: "",
        },
        requestIds: { reachability: "r1", text: "r2", image: "r3" },
      };
    },
  };
  const service = createAiGatewayProfileService({
    repository,
    gateway,
    now: () => new Date("2026-08-04T10:00:00.000Z"),
    logger,
  });
  return { service, calls };
}

test("capability testing is administrator-only and rejects before repository or gateway work", async () => {
  const { service, calls } = fixture();
  await assert.rejects(
    service.testGatewayCapabilities({ costConfirmed: true, actor: ordinary, profileId: "profile-a", configVersion: 4, correlationId: "corr" }),
    (error) => error?.code === "PERMISSION_FORBIDDEN",
  );
  assert.deepEqual(calls, []);
});

test("successful explicit capability test records evidence without automatically publishing an unpublished profile", async () => {
  const { service, calls } = fixture();
  const result = await service.testGatewayCapabilities({ costConfirmed: true,
    actor: admin,
    profileId: "profile-a",
    configVersion: 4,
    correlationId: "corr-capability",
  });

  assert.deepEqual(result, {
    profileId: "profile-a",
    configVersion: 4,
    outcome: "PASSED",
    features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"],
    latencyMs: 321,
    models: { text: "text-model-a", image: "image-model-a" },
    checkedAt: "2026-08-04T10:00:00.000Z",
    errorCode: null,
    enabled: false,
  });
  assert.equal(calls[0][0], "begin");
  assert.equal(calls[0][1].purpose, "PROFILE_CAPABILITY");
  assert.match(calls[0][1].attemptId, /^ai_capability_[a-f0-9]{40}$/u);
  assert.match(calls[0][1].requestKey, /^[a-f0-9]{64}$/u);
  const gatewayInput = calls[1][1];
  assert.equal(gatewayInput.profile.accountId, "account-admin");
  assert.equal(gatewayInput.profile.configVersion, 4);
  assert.equal(gatewayInput.correlationId, "corr-capability");
  assert.match(gatewayInput.requestKey, /^[a-f0-9]{64}$/);
  assert.deepEqual(gatewayInput.capabilityExecution, {
    accountId: "account-admin",
    profileId: "profile-a",
    configVersion: 4,
    attemptId: calls[0][1].attemptId,
    fence: 11,
    leaseVersion: 1,
    leaseToken: "caplease_fixture",
    purpose: "PROFILE_CAPABILITY",
    authorizationHash: "a".repeat(64),
    requestKey: gatewayInput.requestKey,
    connectionId: null,
    connectionVersion: null,
    expectedConnectionStatus: "LEGACY",
    expectedConnectionStatusVersion: 0,
  });
  const saved = calls[2][1];
  assert.equal(saved.accountId, "account-admin");
  assert.equal(saved.actorId, "account-admin");
  assert.equal(saved.profileId, "profile-a");
  assert.equal(saved.configVersion, 4);
  assert.equal(saved.fence, 11);
  assert.equal(saved.leaseVersion, 1);
  assert.equal(saved.leaseToken, "caplease_fixture");
  assert.equal(saved.purpose, "PROFILE_CAPABILITY");
  assert.deepEqual(saved.capabilityResult, {
    outcome: "PASSED",
    features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"],
    latencyMs: 321,
    models: { text: "text-model-a", image: "image-model-a" },
    checkedAt: "2026-08-04T10:00:00.000Z",
    errorCode: null,
  });
  const serialized = JSON.stringify({ result, saved });
  assert.doesNotMatch(serialized, /apiKeyEnvName|SUB2API_PROFILE_A_KEY|requestIds|authorization|cookie|bytes|prompt/i);
});

test("rollback capability has a distinct attempt identity and persisted purpose", async () => {
  const normal = fixture();
  await normal.service.testGatewayCapabilities({ costConfirmed: true,
    actor: admin, profileId: "profile-a", configVersion: 4, correlationId: "corr-purpose",
  });
  const rollback = fixture();
  await rollback.service.testGatewayCapabilities({ costConfirmed: true,
    actor: admin, profileId: "profile-a", configVersion: 4, correlationId: "corr-purpose",
    purpose: "ROLLBACK_CAPABILITY",
  });
  assert.notEqual(normal.calls[0][1].attemptId, rollback.calls[0][1].attemptId);
  assert.equal(rollback.calls[0][1].purpose, "ROLLBACK_CAPABILITY");
  assert.equal(rollback.calls.at(-1)[1].purpose, "ROLLBACK_CAPABILITY");
});

test("encrypted profile capability calls preserve the immutable connection reference", async () => {
  const encryptedProfile = {
    ...profile,
    apiKeyEnvName: "SUB2API_ENCRYPTED_KEY",
    connectionId: "connection-a",
    connectionVersion: 3,
  };
  const { service, calls } = fixture({ loadedProfile: encryptedProfile });
  const result = await service.testGatewayCapabilities({ costConfirmed: true,
    actor: admin, profileId: "profile-a", configVersion: 4, correlationId: "corr-encrypted",
  });
  assert.equal(result.outcome, "PASSED");
  const gatewayProfile = calls.find(([name]) => name === "gateway")[1].profile;
  assert.equal(gatewayProfile.connectionId, "connection-a");
  assert.equal(gatewayProfile.connectionVersion, 3);
});

test("successful capability retest preserves an already published profile", async () => {
  const { service, calls } = fixture({ loadedProfile: { ...profile, enabled: true } });
  const result = await service.testGatewayCapabilities({ costConfirmed: true,
    actor: admin, profileId: "profile-a", configVersion: 4, correlationId: "corr-published-retest",
  });
  assert.equal(result.outcome, "PASSED");
  assert.equal(result.enabled, true);
});

test("capability request identity binds the correlation while remaining stable for the same attempt", async () => {
  const keys = [];
  for (const correlationId of ["corr-a", "corr-b", "corr-a"]) {
    const { service, calls } = fixture();
    await service.testGatewayCapabilities({ costConfirmed: true, actor: admin, profileId: "profile-a", configVersion: 4, correlationId });
    keys.push(calls.find(([name]) => name === "gateway")[1].requestKey);
  }
  assert.notEqual(keys[0], keys[1]);
  assert.equal(keys[0], keys[2]);
});

test("a completed duplicate returns its frozen response without another gateway call", async () => {
  const response = {
    profileId: "profile-a", configVersion: 4, outcome: "PASSED",
    features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"], latencyMs: 9,
    models: { text: "text-model-a", image: "image-model-a" },
    checkedAt: "2026-08-04T09:00:00.000Z", errorCode: null, enabled: false,
  };
  const { service, calls } = fixture({ begin: (input) => ({
    profile: { ...profile }, attemptId: input.attemptId, fence: 7,
    status: "PASSED", response, duplicate: true,
    leaseVersion: 1, leaseToken: "caplease_completed", leaseExpiresAt: "2026-08-04T10:10:00.000Z",
  }) });
  assert.deepEqual(await service.testGatewayCapabilities({ costConfirmed: true,
    actor: admin, profileId: "profile-a", configVersion: 4, correlationId: "corr-existing",
  }), response);
  assert.deepEqual(calls.map(([name]) => name), ["begin"]);
});

test("a duplicate running attempt does not perform the cost-bearing gateway test twice", async () => {
  const { service, calls } = fixture({ begin: (input) => ({
    profile: { ...profile }, attemptId: input.attemptId, fence: 7,
    status: "RUNNING", response: null, duplicate: true, reclaimed: false,
    leaseVersion: 1, leaseToken: "caplease_running", leaseExpiresAt: "2026-08-04T10:10:00.000Z",
  }) });
  await assert.rejects(service.testGatewayCapabilities({ costConfirmed: true,
    actor: admin, profileId: "profile-a", configVersion: 4, correlationId: "corr-running",
  }), { code: "AI_GATEWAY_CAPABILITY_IN_PROGRESS" });
  assert.deepEqual(calls.map(([name]) => name), ["begin"]);
});

test("an expired running attempt is reclaimed with a new lease and keeps the same upstream idempotency key", async () => {
  const requestKeys = [];
  for (const lease of [
    { leaseVersion: 1, leaseToken: "caplease_initial", reclaimed: false },
    { leaseVersion: 2, leaseToken: "caplease_reclaimed", reclaimed: true },
  ]) {
    const { service, calls } = fixture({ begin: (input) => ({
      profile: { ...profile }, attemptId: input.attemptId, fence: 13,
      status: "RUNNING", response: null, duplicate: false,
      leaseVersion: lease.leaseVersion, leaseToken: lease.leaseToken,
      leaseExpiresAt: "2026-08-04T10:10:00.000Z", reclaimed: lease.reclaimed,
    }) });
    const result = await service.testGatewayCapabilities({ costConfirmed: true,
      actor: admin, profileId: "profile-a", configVersion: 4, correlationId: "corr-recover",
    });
    assert.equal(result.outcome, "PASSED");
    requestKeys.push(calls.find(([name]) => name === "gateway")[1].requestKey);
    const completed = calls.find(([name]) => name === "complete")[1];
    assert.equal(completed.leaseVersion, lease.leaseVersion);
    assert.equal(completed.leaseToken, lease.leaseToken);
  }
  assert.equal(requestKeys[0], requestKeys[1]);
});

test("a malformed lease response cannot reach the cost-bearing gateway", async () => {
  const { service, calls } = fixture({ begin: (input) => ({
    profile: { ...profile }, attemptId: input.attemptId, fence: 7,
    status: "RUNNING", response: null, duplicate: false, reclaimed: false,
    leaseVersion: 0, leaseToken: "", leaseExpiresAt: null,
  }) });
  await assert.rejects(service.testGatewayCapabilities({ costConfirmed: true,
    actor: admin, profileId: "profile-a", configVersion: 4, correlationId: "corr-bad-lease",
  }), { code: "AI_GATEWAY_CAPABILITY_IN_PROGRESS" });
  assert.deepEqual(calls.map(([name]) => name), ["begin"]);
});

test("failed capability test disables the exact profile version and returns a stable safe outcome", async () => {
  const upstream = Object.assign(new Error("secret upstream body"), {
    code: "NON_RETRYABLE_AUTH",
    retryable: false,
  });
  const { service, calls } = fixture({ gatewayError: upstream });
  const result = await service.testGatewayCapabilities({ costConfirmed: true,
    actor: admin,
    profileId: "profile-a",
    configVersion: 4,
    correlationId: "corr-failed",
  });
  assert.deepEqual(result, {
    profileId: "profile-a",
    configVersion: 4,
    outcome: "FAILED",
    features: [],
    latencyMs: null,
    models: { text: "text-model-a", image: "image-model-a" },
    checkedAt: "2026-08-04T10:00:00.000Z",
    errorCode: "NON_RETRYABLE_AUTH",
    enabled: false,
  });
  const saved = calls.at(-1)[1];
  assert.equal(saved.capabilityResult.outcome, "FAILED");
  assert.equal(saved.configVersion, 4);
  assert.doesNotMatch(JSON.stringify(saved), /secret upstream body/);
});

test("attempt fence prevents a slow old capability test from mutating newer evidence", async () => {
  const { service, calls } = fixture({ completion: { applied: false, stale: true, duplicate: false } });
  await assert.rejects(
    service.testGatewayCapabilities({ costConfirmed: true, actor: admin, profileId: "profile-a", configVersion: 4, correlationId: "corr-stale" }),
    (error) => error?.code === "AI_GATEWAY_PROFILE_VERSION_CONFLICT" && error?.retryable === false,
  );
  assert.equal(calls.at(-1)[0], "complete");
  assert.equal(calls.at(-1)[1].fence, 11);
});

test("capability completion stays successful after persistence even when the logger fails", async () => {
  for (const logger of [
    { info() { throw new Error("logger sync failure"); } },
    { info() { return Promise.reject(new Error("logger async failure")); } },
  ]) {
    const { service, calls } = fixture({ logger });
    const result = await service.testGatewayCapabilities({ costConfirmed: true,
      actor: admin,
      profileId: "profile-a",
      configVersion: 4,
      correlationId: "corr-logger",
    });
    assert.equal(result.outcome, "PASSED");
    assert.equal(result.enabled, false);
    assert.equal(calls.filter(([name]) => name === "gateway").length, 1);
    assert.equal(calls.filter(([name]) => name === "complete").length, 1);
    await new Promise((resolve) => setImmediate(resolve));
  }
});

test("foreign, missing, or malformed profile identity never reaches the gateway", async () => {
  for (const input of [
    { actor: admin, profileId: "foreign", configVersion: 4, correlationId: "corr", costConfirmed: true },
    { actor: admin, profileId: "profile-a", configVersion: 0, correlationId: "corr", costConfirmed: true },
    { actor: admin, profileId: "profile-a", configVersion: 4, correlationId: "", costConfirmed: true },
  ]) {
    const { service, calls } = fixture();
    await assert.rejects(service.testGatewayCapabilities(input), (error) => [
      "AI_GATEWAY_PROFILE_NOT_FOUND",
      "AI_GATEWAY_CAPABILITY_REQUEST_INVALID",
    ].includes(error?.code));
    assert.equal(calls.some(([name]) => name === "gateway"), false);
  }
});

test("capability result validation rejects unsafe or incomplete adapter output and disables the version", async () => {
  for (const gatewayResult of [
    { features: ["STRUCTURED_TEXT"], latencyMs: 10, models: { text: "text-model-a", image: "image-model-a" } },
    { features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG", "SECRET_TOKEN"], latencyMs: 10, models: { text: "text-model-a", image: "image-model-a" } },
    { features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"], latencyMs: -1, models: { text: "text-model-a", image: "image-model-a" } },
    {
      features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"],
      latencyMs: 10,
      models: { text: "text-model-a", image: "image-model-a" },
      modelEvidence: { requestedImageModel: "other-image", gatewayReportedImageModel: "", orchestratorModel: "" },
    },
    {
      features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"],
      latencyMs: 10,
      models: { text: "text-model-a", image: "image-model-a" },
      modelEvidence: { requestedImageModel: "image-model-a", gatewayReportedImageModel: "other-image", orchestratorModel: "" },
    },
    {
      features: ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"],
      latencyMs: 10,
      models: { text: "text-model-a", image: "image-model-a" },
      modelEvidence: {
        requestedImageModel: "image-model-a",
        gatewayReportedImageModel: "",
        gatewayReportedImageModelPresent: true,
        orchestratorModel: "",
      },
    },
  ]) {
    const { service, calls } = fixture({ gatewayResult });
    const result = await service.testGatewayCapabilities({ costConfirmed: true, actor: admin, profileId: "profile-a", configVersion: 4, correlationId: "corr" });
    assert.equal(result.outcome, "FAILED");
    assert.equal(result.errorCode, "INVALID_GATEWAY_RESPONSE");
    assert.equal(calls.at(-1)[1].capabilityResult.outcome, "FAILED");
  }
});

test("AUTO_LISTING_AI_ENABLED defaults off and performs no profile or secret read", () => {
  let reads = 0;
  assert.equal(autoListingAiEnabled({}), false);
  assert.equal(assertAutoListingAiRuntimeConfiguration({
    env: {},
    resolveProfile() { reads += 1; },
    readSecret() { reads += 1; },
  }), null);
  assert.equal(reads, 0);
});

test("enabled AI runtime validates the job-frozen profile and ignores the removed global profile selector", () => {
  const env = {
    AUTO_LISTING_AI_ENABLED: "1",
    AUTO_LISTING_AI_PROFILE_ID: "must-not-select-this-profile",
    AUTO_LISTING_AI_ALLOWED_SECRET_ENV_NAMES: "SUB2API_PROFILE_A_KEY",
    AUTO_LISTING_AI_ALLOWED_GATEWAY_BASE_URLS: "https://gateway.example/v1",
    SUB2API_PROFILE_A_KEY: "x",
  };
  const safe = assertAutoListingAiRuntimeConfiguration({ env, profile: { ...profile, enabled: true } });
  assert.deepEqual(safe, { profileId: "profile-a", configVersion: 4 });

  for (const [fixtureEnv, fixtureProfile, code] of [
    [{ AUTO_LISTING_AI_ENABLED: "1" }, null, "AUTO_LISTING_AI_PROFILE_REQUIRED"],
    [env, { ...profile, enabled: false }, "AUTO_LISTING_AI_PROFILE_NOT_ENABLED"],
    [{ ...env, SUB2API_PROFILE_A_KEY: "" }, { ...profile, enabled: true }, "AUTO_LISTING_AI_SECRET_REQUIRED"],
    [{ ...env, SUB2API_PROFILE_A_KEY: "   " }, { ...profile, enabled: true }, "AUTO_LISTING_AI_SECRET_REQUIRED"],
    [env, { ...profile, enabled: true, apiKeyEnvName: "__proto__" }, "AUTO_LISTING_AI_PROFILE_INVALID"],
  ]) {
    assert.throws(
      () => assertAutoListingAiRuntimeConfiguration({ env: fixtureEnv, profile: fixtureProfile }),
      (error) => error?.code === code,
    );
  }
});

test("production worker startup no longer requires a global AI profile selector", () => {
  const names = [
    "NODE_ENV", "DATABASE_URL", "POSTGRES_HOST", "APP_ENCRYPTION_KEY", "POSTGRES_PASSWORD",
    "LISTING_PIPELINE_V3", "AUTO_LISTING_AI_ENABLED", "AUTO_LISTING_AI_PROFILE_ID",
  ];
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    Object.assign(process.env, {
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://configured.invalid/database",
      APP_ENCRYPTION_KEY: "a".repeat(32),
      POSTGRES_PASSWORD: "b".repeat(16),
      LISTING_PIPELINE_V3: "1",
      AUTO_LISTING_AI_ENABLED: "1",
    });
    delete process.env.AUTO_LISTING_AI_PROFILE_ID;
    assert.doesNotThrow(() => assertProductionConfiguration("worker"));
  } finally {
    for (const name of names) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
  }
});
