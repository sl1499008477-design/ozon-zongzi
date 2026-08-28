import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import test from "node:test";

import { createAiGatewayProfileService } from "../ai-gateway-profile-service.mjs";
import { normalizeAndHashAutoListingConfig } from "../auto-listing-contract.mjs";
import {
  createAutoListingAiCapabilityCredentialResolver,
  createAutoListingAiCatalogSyncCredentialResolver,
} from "../auto-listing-ai-credential-resolver.mjs";
import { createAutoListingCredentialCipher } from "../auto-listing-ai-credential-crypto.mjs";
import { deriveEffectiveAutoListingImageConfig } from "../auto-listing-item-image-config.mjs";
import { createAutoListingAiModelSyncService } from "../auto-listing-ai-model-sync-service.mjs";
import { createAutoListingAiSettingsService } from "../auto-listing-ai-settings-service.mjs";
import { createAutoListingRepository } from "../auto-listing-repository.mjs";
import { buildAutoListingSourceSnapshot } from "../auto-listing-source-snapshot.mjs";
import { createSub2ApiAdapter } from "../sub2api-ai-adapter.mjs";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const ADMIN = Object.freeze({ id: "account-e2e", role: "admin" });
const MODEL_IDS = Object.freeze({ text: "text-model-a", image: "image-model-a" });
const FIXED_NOW = "2026-08-08T08:00:00.000Z";

const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value;
const hash = (value) => crypto.createHash("sha256")
  .update(typeof value === "string" ? value : JSON.stringify(canonical(value)), "utf8").digest("hex");

function json(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", connection: "close", ...headers });
  response.end(JSON.stringify(body));
}

async function startFakeSub2Api({ acceptedKeys }) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const authorization = request.headers.authorization || "";
      const gatewayKey = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      requests.push({ method: request.method, path: request.url, authorization, bodyBytes: Buffer.concat(chunks).length });
      if (!acceptedKeys.has(gatewayKey)) {
        json(response, 401, { error: { type: "authentication_error" } });
        return;
      }
      if (request.method === "GET" && request.url === "/v1/models") {
        json(response, 200, {
          object: "list",
          data: [
            { object: "model", id: MODEL_IDS.text, owned_by: "controlled-fake" },
            { object: "model", id: MODEL_IDS.image, owned_by: "controlled-fake" },
          ],
        }, { "x-request-id": `fake-models-${requests.length}` });
        return;
      }
      if (request.method === "POST" && request.url === "/v1/responses") {
        json(response, 200, {
          id: `fake-text-${requests.length}`,
          model: MODEL_IDS.text,
          output: [{ type: "message", content: [{ type: "output_text", text: "{\"ok\":true}" }] }],
        });
        return;
      }
      if (request.method === "POST" && request.url === "/v1/images/edits") {
        json(response, 200, {
          id: `fake-image-${requests.length}`,
          model: MODEL_IDS.image,
          data: [{ model: MODEL_IDS.image, b64_json: PNG_1X1 }],
        });
        return;
      }
      json(response, 404, { error: { type: "not_found" } });
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    async close() {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    },
  };
}

function safeConnection(connection) {
  const { encryptedSecret: _encryptedSecret, ...safe } = connection;
  return structuredClone(safe);
}

function safeProfile(profile) {
  const { apiKeyEnvName: _apiKeyEnvName, ...safe } = profile;
  return structuredClone(safe);
}

function providerIdentity(execution) {
  const providerRequestKey = crypto.createHash("sha256").update(JSON.stringify({
    schemaVersion: "AI_GATEWAY_CAPABILITY_SUBCALL_V1",
    accountId: execution.accountId,
    attemptId: execution.attemptId,
    fence: execution.fence,
    requestKey: execution.requestKey,
    stage: execution.probe,
  }), "utf8").digest("hex");
  return Object.freeze({
    providerRequestKey,
    providerCorrelationId: `cap_${providerRequestKey.slice(0, 40)}`,
  });
}

function createControlledPersistence() {
  const state = {
    connections: [], catalogs: [], syncTasks: [], profiles: [], audits: [], domainEvents: [],
    capabilityAttempts: new Map(), capabilitySubcalls: new Map(), publications: new Map(),
  };
  let catalogSequence = 0;
  let profileSequence = 0;

  function overview(accountId) {
    const connections = state.connections.filter((row) => row.accountId === accountId).map(safeConnection);
    const profiles = state.profiles.filter((row) => row.accountId === accountId).map(safeProfile);
    return {
      accountId,
      activeConnection: connections.find((row) => row.status === "ACTIVE") || null,
      connections,
      catalogs: state.catalogs.filter((row) => row.accountId === accountId).map((row) => structuredClone(row)),
      syncTasks: state.syncTasks.filter((row) => row.accountId === accountId).map((row) => structuredClone(row)),
      profiles,
    };
  }

  function audit(action, accountId, metadata = {}) {
    state.audits.push(Object.freeze({ action, accountId, occurredAt: FIXED_NOW, metadata: structuredClone(metadata) }));
  }

  function connection(accountId, connectionId, connectionVersion) {
    return state.connections.find((row) => row.accountId === accountId && row.id === connectionId
      && row.version === connectionVersion) || null;
  }

  function profile(accountId, profileId, configVersion) {
    return state.profiles.find((row) => row.accountId === accountId && row.id === profileId
      && row.configVersion === configVersion) || null;
  }

  const repository = {
    connectionIdForIntent({ accountId, idempotencyKey }) {
      return `connection-${hash(`${accountId}\0${idempotencyKey}`).slice(0, 20)}`;
    },

    async loadSettingsOverview({ accountId }) {
      return overview(accountId);
    },

    async loadSettingsOverviewPage({ accountId, connectionCursor, profileCursor, pageSize }) {
      assert.equal(connectionCursor, null);
      assert.equal(profileCursor, null);
      assert.equal(pageSize, 10);
      const loaded = overview(accountId);
      return { ...loaded,
        activeProfile: loaded.profiles.find((row) => row.enabled) || null,
        connections: loaded.connections.slice(0, pageSize),
        profiles: loaded.profiles.slice(0, pageSize),
        pageInfo: {
          connections: { pageSize, next: null },
          profiles: { pageSize, next: null },
        } };
    },

    async loadSettingsCatalog({ accountId, catalogId }) {
      const row = state.catalogs.find((candidate) => candidate.accountId === accountId
        && candidate.id === catalogId) || null;
      if (!row) throw Object.assign(new Error("catalog not found"), {
        code: "AUTO_LISTING_AI_SETTINGS_CATALOG_NOT_FOUND", status: 404,
      });
      const owner = connection(accountId, row.connectionId, row.connectionVersion);
      return { catalog: structuredClone(row),
        canCreateProfile: ["VALIDATED", "ACTIVE"].includes(owner?.status) };
    },

    async loadSettingsConnection({ accountId, connectionId, connectionVersion }) {
      const row = connection(accountId, connectionId, connectionVersion);
      return row ? safeConnection(row) : null;
    },

    async createPendingConnection(input) {
      const existing = connection(input.accountId, input.connectionId, 1);
      if (existing) return { ...safeConnection(existing), duplicate: true };
      const row = {
        id: input.connectionId,
        accountId: input.accountId,
        version: 1,
        displayName: input.displayName,
        baseUrl: input.baseUrl,
        encryptedSecret: structuredClone(input.encryptedSecret),
        fingerprint: input.encryptedSecret.fingerprint,
        keyVersion: input.encryptedSecret.keyVersion,
        status: "PENDING",
        statusVersion: 1,
        validationResult: null,
        validatedAt: null,
        activatedAt: null,
        retiredAt: null,
        createdAt: FIXED_NOW,
      };
      state.connections.push(row);
      state.domainEvents.push({ type: "CONNECTION_CREATED", accountId: input.accountId, connectionId: row.id });
      audit("AUTO_LISTING_AI_CONNECTION_CREATE", input.accountId, {
        connectionId: row.id, version: row.version, fingerprint: row.fingerprint,
      });
      return { ...safeConnection(row), duplicate: false };
    },

    async enqueueModelSync(input) {
      const row = {
        id: `sync-${hash(`${input.accountId}\0${input.idempotencyKey}`).slice(0, 20)}`,
        accountId: input.accountId,
        connectionId: input.connectionId,
        connectionVersion: input.connectionVersion,
        syncPurpose: input.syncPurpose,
        targetConnectionStatusVersion: input.expectedConnectionStatusVersion,
        status: "PENDING",
        statusVersion: 1,
        attemptCount: 0,
        maxAttempts: input.maxAttempts,
        leaseVersion: 0,
        leaseToken: null,
        leaseExpiresAt: null,
        availableAt: FIXED_NOW,
        completedAt: null,
        lastErrorCode: null,
        lastErrorSafe: null,
        correlationId: input.correlationId,
        createdAt: FIXED_NOW,
      };
      state.syncTasks.push(row);
      audit("AUTO_LISTING_AI_MODEL_SYNC_ENQUEUE", input.accountId, { taskId: row.id, connectionId: row.connectionId });
      return { ...structuredClone(row), duplicate: false };
    },

    async loadCatalogSyncConnectionForSecretResolution(lease) {
      const task = state.syncTasks.find((row) => row.accountId === lease.accountId && row.id === lease.taskId
        && row.status === "LEASED" && row.leaseVersion === lease.leaseVersion && row.leaseToken === lease.leaseToken);
      if (!task) throw Object.assign(new Error("lease conflict"), { code: "AUTO_LISTING_AI_SETTINGS_CATALOG_LEASE_CONFLICT" });
      const row = connection(task.accountId, task.connectionId, task.connectionVersion);
      if (!row || row.statusVersion !== task.targetConnectionStatusVersion) {
        throw Object.assign(new Error("connection conflict"), { code: "AUTO_LISTING_AI_SETTINGS_CONNECTION_VERSION_CONFLICT" });
      }
      return { ...row, encryptedSecret: structuredClone(row.encryptedSecret) };
    },

    async completeModelSync(input) {
      const task = state.syncTasks.find((row) => row.accountId === input.accountId && row.id === input.taskId
        && row.status === "LEASED" && row.leaseVersion === input.leaseVersion && row.leaseToken === input.leaseToken);
      assert.ok(task, "controlled persistence requires the exact live sync lease");
      const row = connection(task.accountId, task.connectionId, task.connectionVersion);
      assert.equal(row.statusVersion, task.targetConnectionStatusVersion);
      task.status = "SUCCEEDED";
      task.statusVersion += 1;
      task.completedAt = FIXED_NOW;
      const catalog = {
        id: `catalog-${++catalogSequence}`,
        accountId: input.accountId,
        syncTaskId: input.taskId,
        connectionId: task.connectionId,
        connectionVersion: task.connectionVersion,
        catalog: structuredClone(input.catalog),
        capabilityResult: structuredClone(input.capabilityResult),
        createdAt: FIXED_NOW,
      };
      state.catalogs.unshift(catalog);
      if (row.status === "PENDING") {
        row.status = "VALIDATED";
        row.statusVersion += 1;
        row.validatedAt = FIXED_NOW;
      }
      state.domainEvents.push({ type: "CATALOG_SYNC_SUCCEEDED", accountId: input.accountId, catalogId: catalog.id });
      audit("AUTO_LISTING_AI_MODEL_SYNC_COMPLETE", input.accountId, {
        taskId: task.id, catalogId: catalog.id, modelCount: catalog.catalog.models.length,
      });
      return { status: "SUCCEEDED", task: structuredClone(task), catalog: structuredClone(catalog), duplicate: false };
    },

    async failModelSync(input) {
      const task = state.syncTasks.find((row) => row.id === input.taskId && row.accountId === input.accountId);
      if (task) {
        task.status = "FAILED";
        task.lastErrorCode = input.errorCode;
      }
      return { status: "FAILED", taskId: input.taskId, errorCode: input.errorCode };
    },

    async createProfileFromSelection(input) {
      const row = connection(input.accountId, input.connectionId, input.connectionVersion);
      assert.equal(row?.status, "VALIDATED");
      const catalog = state.catalogs.find((candidate) => candidate.accountId === input.accountId
        && candidate.id === input.catalogId && candidate.connectionId === input.connectionId
        && candidate.connectionVersion === input.connectionVersion);
      assert.ok(catalog);
      const modelIds = new Set(catalog.catalog.models.map((model) => model.id));
      assert.ok(modelIds.has(input.textModel) && modelIds.has(input.imageModel));
      const created = {
        id: `profile-${++profileSequence}`,
        accountId: input.accountId,
        displayName: input.displayName,
        configVersion: 1,
        baseUrl: row.baseUrl,
        apiKeyEnvName: "SUB2API_ENCRYPTED_KEY",
        textProtocol: input.textProtocol,
        imageProtocol: input.imageProtocol,
        textModel: input.textModel,
        imageModel: input.imageModel,
        enabled: false,
        capabilityResult: {},
        capabilityCheckedAt: null,
        connectionId: input.connectionId,
        connectionVersion: input.connectionVersion,
        createdAt: FIXED_NOW,
      };
      state.profiles.push(created);
      audit("AUTO_LISTING_AI_PROFILE_CREATE", input.accountId, {
        profileId: created.id, connectionId: created.connectionId, catalogId: catalog.id,
      });
      return { ...safeProfile(created), duplicate: false };
    },

    async listProfileChannels() { return { channels: [], channelCandidates: [] }; },
    async addProfileChannel() { throw new Error("channel commands are outside this existing journey"); },
    async setProfileChannelEnabled() { throw new Error("channel commands are outside this existing journey"); },

    async loadConnectionForSecretResolution({ accountId, connectionId, connectionVersion }) {
      const row = connection(accountId, connectionId, connectionVersion);
      return row ? { ...row, encryptedSecret: structuredClone(row.encryptedSecret) } : null;
    },

    async beginCapabilityTest(input) {
      const selected = profile(input.accountId, input.profileId, input.configVersion);
      if (!selected) return null;
      const selectedConnection = connection(input.accountId, selected.connectionId, selected.connectionVersion);
      assert.equal(selectedConnection.status, "VALIDATED");
      const execution = Object.freeze({
        accountId: input.accountId,
        profileId: input.profileId,
        configVersion: input.configVersion,
        attemptId: input.attemptId,
        correlationId: input.correlationId,
        fence: 1,
        leaseVersion: 1,
        leaseToken: `caplease_${hash(input.attemptId).slice(0, 24)}`,
        purpose: input.purpose,
        authorizationHash: hash({ attemptId: input.attemptId, requestKey: input.requestKey }),
        requestKey: input.requestKey,
        connectionId: selected.connectionId,
        connectionVersion: selected.connectionVersion,
        expectedConnectionStatus: "VALIDATED",
        expectedConnectionStatusVersion: selectedConnection.statusVersion,
      });
      state.capabilityAttempts.set(input.attemptId, { execution, profile: selected, status: "RUNNING" });
      audit("AUTO_LISTING_AI_PROFILE_CAPABILITY_AUTHORIZED", input.accountId, {
        profileId: selected.id, attemptId: input.attemptId, purpose: input.purpose, costConfirmed: true,
        authorizationHash: execution.authorizationHash,
      });
      return {
        profile: structuredClone(selected),
        attemptId: input.attemptId,
        fence: 1,
        status: "RUNNING",
        response: null,
        duplicate: false,
        reclaimed: false,
        leaseVersion: 1,
        leaseToken: execution.leaseToken,
        leaseExpiresAt: "2099-01-01T00:00:00.000Z",
        capabilityExecution: execution,
      };
    },

    async loadCapabilityExecutionForSecretResolution(execution) {
      const attempt = state.capabilityAttempts.get(execution.attemptId);
      assert.ok(attempt && attempt.status === "RUNNING");
      const selected = attempt.profile;
      const selectedConnection = connection(execution.accountId, execution.connectionId, execution.connectionVersion);
      assert.equal(selectedConnection.status, execution.expectedConnectionStatus);
      const identity = providerIdentity(execution);
      const key = `${execution.attemptId}:${execution.probe}`;
      if (!state.capabilitySubcalls.has(key)) {
        state.capabilitySubcalls.set(key, { status: "PREPARED", ...identity });
        audit("AUTO_LISTING_AI_PROFILE_CAPABILITY_SUBCALL_RESERVED", execution.accountId, {
          attemptId: execution.attemptId, stage: execution.probe, ...identity,
        });
      }
      return {
        accountId: execution.accountId,
        profileId: execution.profileId,
        configVersion: execution.configVersion,
        apiKeyEnvName: selected.apiKeyEnvName,
        ...identity,
        connection: { ...selectedConnection, encryptedSecret: structuredClone(selectedConnection.encryptedSecret) },
      };
    },

    async markCapabilitySubcallSending(execution) {
      const key = `${execution.attemptId}:${execution.probe}`;
      const reservation = state.capabilitySubcalls.get(key);
      assert.equal(reservation?.status, "PREPARED");
      reservation.status = "SENDING";
      return providerIdentity(execution);
    },

    async completeCapabilitySubcall(input) {
      const key = `${input.attemptId}:${input.probe}`;
      const reservation = state.capabilitySubcalls.get(key);
      assert.ok(reservation?.status === "SENDING"
        || (reservation?.status === "PREPARED" && ["PRE_SEND_ABORTED", "PRE_SEND_FAILED"].includes(input.reason)));
      reservation.status = input.outcome;
      reservation.reason = input.reason;
      audit("AUTO_LISTING_AI_PROFILE_CAPABILITY_SUBCALL_COMPLETED", input.accountId, {
        attemptId: input.attemptId, stage: input.probe, outcome: input.outcome, reason: input.reason,
        providerRequestKey: reservation.providerRequestKey,
      });
      return { terminal: true };
    },

    async completeCapabilityTest(input) {
      const attempt = state.capabilityAttempts.get(input.attemptId);
      assert.ok(attempt && attempt.status === "RUNNING");
      for (const probe of ["REACHABILITY", "TEXT", "IMAGE"]) {
        assert.equal(state.capabilitySubcalls.get(`${input.attemptId}:${probe}`)?.status, "SUCCEEDED");
      }
      attempt.status = input.capabilityResult.outcome;
      attempt.profile.capabilityResult = structuredClone(input.capabilityResult);
      attempt.profile.capabilityCheckedAt = input.capabilityResult.checkedAt;
      const response = {
        profileId: input.profileId,
        configVersion: input.configVersion,
        ...structuredClone(input.capabilityResult),
        enabled: attempt.profile.enabled,
      };
      audit("AUTO_LISTING_AI_PROFILE_CAPABILITY_TEST", input.accountId, {
        profileId: input.profileId, attemptId: input.attemptId, outcome: input.capabilityResult.outcome,
        costConfirmed: true,
      });
      return { applied: true, stale: false, duplicate: false, response };
    },

    async publishProfile(input) {
      const replay = state.publications.get(input.idempotencyKey);
      if (replay) return { ...safeProfile(replay), duplicate: true };
      const selected = profile(input.accountId, input.profileId, input.configVersion);
      assert.equal(selected?.capabilityResult?.outcome, "PASSED");
      const selectedConnection = connection(input.accountId, selected.connectionId, selected.connectionVersion);
      assert.equal(selectedConnection?.status, "VALIDATED");
      for (const currentProfile of state.profiles.filter((row) => row.accountId === input.accountId)) {
        currentProfile.enabled = false;
      }
      for (const currentConnection of state.connections.filter((row) => row.accountId === input.accountId
        && row.status === "ACTIVE")) {
        currentConnection.status = "RETIRED";
        currentConnection.statusVersion += 1;
        currentConnection.retiredAt = FIXED_NOW;
      }
      selected.enabled = true;
      selectedConnection.status = "ACTIVE";
      selectedConnection.statusVersion += 1;
      selectedConnection.activatedAt = FIXED_NOW;
      state.publications.set(input.idempotencyKey, selected);
      audit("AUTO_LISTING_AI_PROFILE_PUBLISH", input.accountId, {
        profileId: selected.id, configVersion: selected.configVersion,
        connectionId: selected.connectionId, connectionVersion: selected.connectionVersion,
      });
      return { ...safeProfile(selected), duplicate: false };
    },

    async prepareProfileRollback() {
      throw new Error("rollback is outside this controlled acceptance journey");
    },

    async rollbackProfile() {
      throw new Error("rollback is outside this controlled acceptance journey");
    },
  };

  function leaseTask(taskId) {
    const task = state.syncTasks.find((row) => row.id === taskId);
    assert.equal(task?.status, "PENDING");
    task.status = "LEASED";
    task.statusVersion += 1;
    task.attemptCount = 1;
    task.leaseVersion = 1;
    task.leaseToken = `lease_${hash(task.id).slice(0, 24)}`;
    task.leaseExpiresAt = "2099-01-01T00:00:00.000Z";
    return {
      accountId: task.accountId,
      attemptCount: task.attemptCount,
      connectionId: task.connectionId,
      connectionVersion: task.connectionVersion,
      correlationId: task.correlationId,
      leaseExpiresAt: task.leaseExpiresAt,
      leaseToken: task.leaseToken,
      leaseVersion: task.leaseVersion,
      maxAttempts: task.maxAttempts,
      syncPurpose: task.syncPurpose,
      targetConnectionStatusVersion: task.targetConnectionStatusVersion,
      taskId: task.id,
    };
  }

  return { state, repository, leaseTask, overview, profile, connection };
}

function listingBaseTemplate(sourceRecordId) {
  const price = {
    currency: "RUB", currencySource: "SOURCE",
    blackKopecks: "10000", greenKopecks: "8000",
  };
  const image = "https://source.example.test/product.jpg";
  return {
    productDraft: { id: `draft-${sourceRecordId}`, version: 1, dataHash: "1".repeat(64) },
    pricingEvidence: { ...price, evidenceHash: hash(price) },
    richContentAttributeSupported: true,
    variants: [{
      sourceVariantId: "variant-1",
      sourceSku: "sku-lock-1",
      item: {
        offer_id: "offer-lock-1", name: "Locked evidence product", price: "100.00",
        currency_code: "RUB", description_category_id: 123, type_id: 456,
        primary_image: image, images: [image], weight: 100, weight_unit: "g",
        depth: 100, width: 100, height: 100, dimension_unit: "mm",
        attributes: [{ id: 85, complex_id: 0, values: [{ value: "No brand" }] }],
      },
    }],
    versions: {
      normalizerVersion: "normalizer-v3", categoryRuleVersion: "category-v5", dictionaryVersion: "dictionary-live",
    },
  };
}

function jobGraph(idempotencyKey) {
  const { config, configHash } = normalizeAndHashAutoListingConfig({
    targetStoreId: "store-e2e",
    targetWarehouseId: "warehouse-e2e",
    stock: 1,
    priceAdjustmentKopecks: "0",
  });
  const sourceRecordId = `collect-${idempotencyKey}`;
  const categoryEvidence = {
    id: `category-evidence-${idempotencyKey}`, accountId: ADMIN.id,
    sourceDescriptionCategoryId: 123, sourceTypeId: 456,
    taxonomyScope: "OZON:DEFAULT",
  };
  const captured = buildAutoListingSourceSnapshot({
    accountId: ADMIN.id,
    sourceType: "COLLECT_BOX",
    sourceRecordId,
    sourceVersion: "1",
    targetStoreId: "store-e2e",
    targetStoreCurrency: "RUB",
    categoryEvidence,
    sharedCategory: {
      id: `shared-category-${idempotencyKey}`, accountId: ADMIN.id, version: 1,
      evidenceId: categoryEvidence.id, status: "ACTIVE", source: "SOURCE_DIRECT",
      sourceDescriptionCategoryId: 123, sourceTypeId: 456,
      currentDescriptionCategoryId: 123, currentTypeId: 456,
      taxonomyScope: "OZON:DEFAULT", taxonomyFingerprint: null,
    },
    rawResponseRef: `raw-${idempotencyKey}`,
    rawResponseHash: hash(`raw-${idempotencyKey}`),
    productDraft: { id: `draft-${sourceRecordId}`, version: 1 },
    collectItem: {
      id: sourceRecordId,
      accountId: ADMIN.id,
      sku: "sku-lock-1",
      listingDraft: {
        sku: "sku-lock-1",
        offerId: "offer-lock-1",
        title: "Locked evidence product",
        currency: "RUB",
        blackKopecks: "10000",
        greenKopecks: "8000",
        productMeasurements: {
          reliable: true, length: 28, unit: "cm", source: "manufacturer",
        },
        images: [],
        variants: [{ sku: "sku-lock-1", offerId: "offer-lock-1" }],
        categoryResolution: {
          status: "MATCHED", method: "test",
          target: { storeId: "store-e2e", descriptionCategoryId: "123", typeId: "456" },
          source: { path: [] },
        },
      },
    },
  });
  return {
    accountId: ADMIN.id,
    actorAccountId: ADMIN.id,
    categoryPreparationLeaseId: `category-lease-${idempotencyKey}`,
    sourceType: "COLLECT_BOX",
    idempotencyKey,
    correlationId: `corr-${idempotencyKey}`,
    configSnapshot: config,
    configHash,
    strategyVersionId: "strategy-version-e2e",
    uploadPolicyVersionId: "upload-policy-review-e2e",
    items: [{
      sourceType: "COLLECT_BOX",
      sourceRecordId,
      sourceVersion: "1",
      snapshot: captured.snapshot,
      snapshotHash: captured.snapshotHash,
      rawResponseRef: captured.rawResponseRef,
      targetStoreId: config.targetStoreId,
      targetWarehouseId: config.targetWarehouseId,
      sourceOrder: 1,
      status: "SOURCE_READY",
      planningContract: "LEGACY_FULL_PLAN_V3",
      strategyId: "strategy-e2e",
      strategyVersionId: "strategy-version-e2e",
      ruleId: null,
      style: "BALANCED_DEFAULT",
      matchedBy: "DEFAULT",
      price: {
        currency: "RUB", branch: "BLACK_GTE_80", blackKopecks: "10000", greenKopecks: "8000",
        realPriceKopecks: "14500", adjustmentKopecks: "0", finalPriceKopecks: "14500",
      },
      effectiveImageConfig: deriveEffectiveAutoListingImageConfig({
        configSnapshot: config, configHash, sourceCapture: captured,
      }),
      listingBaseTemplate: listingBaseTemplate(sourceRecordId),
    }],
  };
}

function createJobPersistence(settingsState) {
  const snapshots = new Map();
  const items = [];
  const events = [];
  const jobs = new Map();
  const counters = new Map();
  const client = {
    async query(sql, params = []) {
      if (/^(BEGIN|COMMIT|ROLLBACK)$/u.test(sql)) return { rows: [] };
      if (/FROM auto_listing_jobs WHERE account_id=\$1 AND idempotency_key=\$2 FOR UPDATE/u.test(sql)) {
        const row = [...jobs.values()].find((job) => job.account_id === params[0] && job.idempotency_key === params[1]);
        return { rows: row ? [{ id: row.id }] : [] };
      }
      if (/FROM accounts WHERE id=\$1 FOR UPDATE/iu.test(sql)) return { rows: [{ id: ADMIN.id }] };
      if (/auto-listing-category-graph-lock-keys/u.test(sql)) {
        return { rows: params[1].map((sharedCategoryId, index) => ({
          shared_category_id: sharedCategoryId,
          lock_key: String(index + 1),
        })) };
      }
      if (/pg_try_advisory_xact_lock_shared/iu.test(sql)) return { rows: [{ locked: true }] };
      if (/auto-listing-category-graph-lease-active/u.test(sql)) {
        return { rows: [{ id: params[1] }] };
      }
      if (/auto-listing-shared-category-fence/u.test(sql)) return { rows: [{ id: params[3] }] };
      if (/FROM stores s/iu.test(sql) && /owner_account_id/iu.test(sql)) return { rows: [{
        id: "store-e2e", owner_account_id: ADMIN.id, label: "Store", company_name: "Store",
        client_id: "client-e2e", currency_code: "RUB", currency_source: "OZON_SELLER_INFO",
        currency_synced_at: "2026-08-08T08:00:00.000Z", status: "active",
      }] };
      if (/FROM store_credentials/iu.test(sql)) return { rows: [{ store_id: "store-e2e" }] };
      if (/FROM warehouses w/iu.test(sql)) return { rows: [{
        id: "warehouse-e2e", store_id: "store-e2e", warehouse_id: "platform-e2e", name: "Warehouse",
        warehouse_type: "FBS", status: "active", is_active: true, is_archived: false,
      }] };
      if (/FROM product_stocks ps/iu.test(sql)) return { rows: [{
        product_id: "product-e2e", product_store_id: "store-e2e", product_status: "active",
        product_is_archived: false, product_raw_is_archived: false, warehouse_id: "warehouse-e2e", source: "fbs",
      }] };
      if (/FROM ai_content_strategy_versions/iu.test(sql)) return { rows: [{ strategy_key: "strategy-e2e" }] };
      if (/FROM auto_listing_upload_policy_versions/iu.test(sql)) return { rows: [{ id: "upload-policy-review-e2e" }] };
      if (/FROM ai_gateway_profiles/iu.test(sql)) {
        return { rows: settingsState.profiles.filter((row) => row.accountId === ADMIN.id && row.enabled).map((row) => ({
          id: row.id,
          config_version: row.configVersion,
          connection_id: row.connectionId,
          connection_version: row.connectionVersion,
          text_model: row.textModel,
          image_model: row.imageModel,
        })) };
      }
      if (/FROM ai_gateway_model_catalogs/iu.test(sql)) {
        const catalog = settingsState.catalogs.find((row) => row.accountId === params[0]
          && row.connectionId === params[1] && row.connectionVersion === params[2]);
        return { rows: catalog ? [{ catalog: structuredClone(catalog.catalog) }] : [] };
      }
      if (/FROM ai_content_strategy_rules/iu.test(sql)) return { rows: [] };
      if (/FROM collect_items c/iu.test(sql)) return { rows: [{
        draft_id: `draft-${params[0]}`, draft_version: 1, draft_data_hash: "1".repeat(64),
      }] };
      if (/INSERT INTO auto_listing_jobs/iu.test(sql)) {
        const row = {
          id: params[0], account_id: params[1], source_type: params[2], status: "CREATED",
          idempotency_key: params[3], strategy_version_id: params[6], ai_profile_id: params[8],
          ai_profile_version: params[9], correlation_id: params[11], created_at: new Date(0), updated_at: new Date(0),
        };
        jobs.set(row.id, row);
        return { rows: [] };
      }
      if (/INSERT INTO auto_listing_source_snapshots/iu.test(sql)) {
        const row = {
          id: params[0], source_record_id: params[3], source_version: params[4],
          snapshot: JSON.parse(params[5]), snapshot_hash: params[6], raw_response_ref: params[7],
        };
        snapshots.set(row.id, row);
        return { rows: [row] };
      }
      if (/INSERT INTO auto_listing_job_items/iu.test(sql)) {
        items.push({
          id: params[0], job_id: params[1], account_id: params[2], snapshot_id: params[3],
          target_store_id: params[4], target_warehouse_id: params[5], status: params[6],
          status_version: 1, failure_code: params[7], created_at: new Date(0), updated_at: new Date(0),
        });
        return { rows: [] };
      }
      if (/INSERT INTO auto_listing_listing_bases/iu.test(sql)) return { rows: [] };
      if (/INSERT INTO auto_listing_events/iu.test(sql)) {
        const created = /NULL,'CREATED','CREATED'/u.test(sql);
        events.push(created ? {
          id: params[0], item_id: params[3], from_status: null, to_status: "CREATED",
          event_type: "CREATED", correlation_id: params[5], details: JSON.parse(params[6]), created_at: new Date(0),
        } : {
          id: params[0], item_id: params[3], from_status: "CREATED", to_status: params[5],
          event_type: params[6], correlation_id: params[7], details: JSON.parse(params[8]), created_at: new Date(0),
        });
        return { rows: [] };
      }
      if (/SELECT id,account_id,source_type,status,strategy_version_id,warehouse_validation_evidence_id,/iu.test(sql)) {
        const job = jobs.get(params[0]);
        return { rows: job ? [job] : [] };
      }
      if (/FROM auto_listing_job_items i/iu.test(sql)) return { rows: items.filter((item) => item.job_id === params[0]).map((item) => ({
        ...item,
        source_record_id: snapshots.get(item.snapshot_id).source_record_id,
        source_version: snapshots.get(item.snapshot_id).source_version,
        snapshot_hash: snapshots.get(item.snapshot_id).snapshot_hash,
      })) };
      if (/FROM auto_listing_events/iu.test(sql)) return { rows: events.filter((event) => {
        const item = items.find((candidate) => candidate.id === event.item_id);
        return item?.job_id === params[0];
      }) };
      throw new Error(`unexpected controlled job query: ${sql}`);
    },
    release() {},
  };
  const repository = createAutoListingRepository({
    pool: { connect: async () => client, query: async () => ({ rows: [] }) },
    idFactory(prefix) {
      const count = (counters.get(prefix) || 0) + 1;
      counters.set(prefix, count);
      return `${prefix}-e2e-${count}`;
    },
    async stageInitialPlanWork({ itemId }) {
      const item = items.find((candidate) => candidate.id === itemId);
      assert.ok(item);
      item.status = "PLANNING";
      item.status_version = 2;
      return { status: "PLANNING", statusVersion: 2 };
    },
  });
  return { repository, jobs };
}

test("controlled loopback sub2API closes encrypted settings, no-cost sync, paid capability, publication, and frozen-job rotation", {
  timeout: 30_000,
}, async () => {
  const gatewayKeyA = "controlled-gateway-key-a";
  const gatewayKeyB = "controlled-gateway-key-b";
  const fake = await startFakeSub2Api({ acceptedKeys: new Set([gatewayKeyA, gatewayKeyB]) });
  const logs = [];
  const persistence = createControlledPersistence();
  const cipher = createAutoListingCredentialCipher({ key: Buffer.alloc(32, 17), keyVersion: "test-v1" });
  const catalogResolver = createAutoListingAiCatalogSyncCredentialResolver({
    repository: persistence.repository,
    cipher,
  });
  const capabilityResolver = createAutoListingAiCapabilityCredentialResolver({
    repository: persistence.repository,
    cipher,
    readSecret: () => { throw new Error("legacy secret path is forbidden in the encrypted journey"); },
  });
  const gateway = createSub2ApiAdapter({
    allowLocalGateway: true,
    allowedGatewayBaseUrls: [fake.baseUrl],
    allowedGatewayOrigins: [new URL(fake.baseUrl).origin],
    allowedSecretEnvNames: [],
    resolveHostname: async () => [{ address: "127.0.0.1", family: 4 }],
    resolveSecret: async () => { throw new Error("generic resolver must not authorize leased or paid calls"); },
    resolveCatalogSyncCredential: catalogResolver.resolveCredential,
    prepareCapabilitySubcall: capabilityResolver.prepareSubcall,
    resolveCapabilityCredential: capabilityResolver.resolveCredential,
    markCapabilitySubcallSending: capabilityResolver.markSending,
    completeCapabilitySubcall: capabilityResolver.completeSubcall,
    logger: {
      info(event, fields) { logs.push(["info", event, structuredClone(fields)]); },
      warn(event, fields) { logs.push(["warn", event, structuredClone(fields)]); },
    },
  });
  const capabilityService = createAiGatewayProfileService({
    repository: persistence.repository,
    gateway,
    now: () => new Date(FIXED_NOW),
    logger: { info(event, fields) { logs.push(["info", event, structuredClone(fields)]); } },
  });
  const settings = createAutoListingAiSettingsService({
    repository: persistence.repository,
    profileRepository: persistence.repository,
    cipher,
    capabilityService,
    allowLocalGateway: true,
  });
  const synchronizer = createAutoListingAiModelSyncService({
    repository: persistence.repository,
    gateway,
    workerId: "controlled-sync-worker",
    timeoutMs: 5_000,
    clock: () => new Date(FIXED_NOW),
  });
  const dtos = [];

  async function publishConnection({ suffix, gatewayKey }) {
    const created = await settings.createConnection({
      actor: ADMIN,
      idempotencyKey: `connection-${suffix}`,
      correlationId: `corr-connection-${suffix}`,
      displayName: `Controlled gateway ${suffix}`,
      baseUrl: fake.baseUrl,
      gatewayKey,
    });
    dtos.push(created);
    assert.equal(Object.hasOwn(created, "encryptedSecret"), false);
    assert.equal(Object.hasOwn(created, "ciphertext"), false);

    const queued = await settings.requestModelSync({
      actor: ADMIN,
      connectionId: created.id,
      connectionVersion: created.version,
      idempotencyKey: `sync-${suffix}`,
      correlationId: `corr-sync-${suffix}`,
    });
    dtos.push(queued);
    const paidCallsBeforeSync = fake.requests.filter((request) => request.method === "POST").length;
    const synced = await synchronizer.syncModelCatalog(persistence.leaseTask(queued.id));
    dtos.push(synced);
    assert.equal(synced.status, "SUCCEEDED", JSON.stringify(synced));
    assert.equal(fake.requests.filter((request) => request.method === "POST").length, paidCallsBeforeSync,
      "catalog synchronization must not call paid text or image endpoints");
    const catalog = persistence.state.catalogs.find((row) => row.id === synced.catalogId);
    assert.equal(catalog.catalog.recommendation.verified, false);
    assert.equal(catalog.catalog.recommendation.textCandidates[0].modelId, MODEL_IDS.text);
    assert.equal(catalog.catalog.recommendation.imageCandidates[0].modelId, MODEL_IDS.image);

    const selected = await settings.createProfileSelection({
      actor: ADMIN,
      connectionId: created.id,
      connectionVersion: created.version,
      catalogId: synced.catalogId,
      displayName: `Controlled profile ${suffix}`,
      textModel: MODEL_IDS.text,
      imageModel: MODEL_IDS.image,
      textProtocol: "SUB2API_RESPONSES",
      imageProtocol: "SUB2API_OPENAI_IMAGES",
      idempotencyKey: `profile-${suffix}`,
      correlationId: `corr-profile-${suffix}`,
    });
    dtos.push(selected);

    const tested = await settings.testProfile({
      actor: ADMIN,
      profileId: selected.id,
      configVersion: selected.configVersion,
      correlationId: `capability-${suffix}`,
      costConfirmed: true,
    });
    dtos.push(tested);
    assert.deepEqual(tested.features, ["STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG"]);

    const published = await settings.publishProfile({
      actor: ADMIN,
      profileId: selected.id,
      configVersion: selected.configVersion,
      idempotencyKey: `publish-${suffix}`,
      correlationId: `corr-publish-${suffix}`,
    });
    dtos.push(published, await settings.getOverview({ actor: ADMIN }));
    assert.equal(published.enabled, true);
    assert.equal(persistence.connection(ADMIN.id, created.id, created.version).status, "ACTIVE");
    return { connection: created, profile: selected, catalog };
  }

  try {
    const first = await publishConnection({ suffix: "a", gatewayKey: gatewayKeyA });
    const jobPersistence = createJobPersistence(persistence.state);
    const firstJob = await jobPersistence.repository.createJobGraph(jobGraph("job-before-rotation"));
    const persistedFirstJob = jobPersistence.jobs.get(firstJob.id);
    assert.deepEqual({
      profileId: persistedFirstJob.ai_profile_id,
      profileVersion: persistedFirstJob.ai_profile_version,
      connectionId: persistence.profile(ADMIN.id, persistedFirstJob.ai_profile_id,
        persistedFirstJob.ai_profile_version).connectionId,
      connectionVersion: persistence.profile(ADMIN.id, persistedFirstJob.ai_profile_id,
        persistedFirstJob.ai_profile_version).connectionVersion,
    }, {
      profileId: first.profile.id,
      profileVersion: first.profile.configVersion,
      connectionId: first.connection.id,
      connectionVersion: first.connection.version,
    });

    const second = await publishConnection({ suffix: "b", gatewayKey: gatewayKeyB });
    assert.equal(persistence.connection(ADMIN.id, first.connection.id, first.connection.version).status, "RETIRED");
    const secondJob = await jobPersistence.repository.createJobGraph(jobGraph("job-after-rotation"));
    const persistedSecondJob = jobPersistence.jobs.get(secondJob.id);
    assert.deepEqual({ profileId: persistedSecondJob.ai_profile_id, profileVersion: persistedSecondJob.ai_profile_version }, {
      profileId: second.profile.id, profileVersion: second.profile.configVersion,
    });
    assert.deepEqual({
      profileId: persistedFirstJob.ai_profile_id,
      profileVersion: persistedFirstJob.ai_profile_version,
      connectionId: persistence.profile(ADMIN.id, persistedFirstJob.ai_profile_id,
        persistedFirstJob.ai_profile_version).connectionId,
      connectionVersion: persistence.profile(ADMIN.id, persistedFirstJob.ai_profile_id,
        persistedFirstJob.ai_profile_version).connectionVersion,
    }, {
      profileId: first.profile.id,
      profileVersion: first.profile.configVersion,
      connectionId: first.connection.id,
      connectionVersion: first.connection.version,
    }, "rotating and publishing a new connection must not rewrite an existing job's profile or connection evidence");

    assert.equal(fake.requests.filter((request) => request.path === "/v1/responses").length, 2);
    assert.equal(fake.requests.filter((request) => request.path === "/v1/images/edits").length, 2);
    assert.equal(fake.requests.filter((request) => request.path === "/v1/models").length, 4);
    assert.ok(persistence.state.audits.some((entry) => entry.action === "AUTO_LISTING_AI_CONNECTION_CREATE"));
    assert.ok(persistence.state.audits.some((entry) => entry.action === "AUTO_LISTING_AI_MODEL_SYNC_COMPLETE"));
    assert.ok(persistence.state.audits.some((entry) => entry.action === "AUTO_LISTING_AI_PROFILE_CAPABILITY_TEST"));
    assert.ok(persistence.state.audits.some((entry) => entry.action === "AUTO_LISTING_AI_PROFILE_PUBLISH"));

    const disclosureSurface = JSON.stringify({ logs, audits: persistence.state.audits,
      domainEvents: persistence.state.domainEvents, dtos });
    for (const rawKey of [gatewayKeyA, gatewayKeyB]) {
      assert.doesNotMatch(disclosureSurface, new RegExp(rawKey, "u"));
    }
    assert.doesNotMatch(JSON.stringify(dtos), /ciphertext|authTag|leaseToken|apiKeyEnvName/iu);
    assert.doesNotMatch(JSON.stringify(logs), /Authorization|Bearer /u);
  } finally {
    await fake.close();
  }
});
