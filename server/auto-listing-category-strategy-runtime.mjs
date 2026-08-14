import crypto from "node:crypto";

import { createAutoListingAiAdminPostgres } from "./auto-listing-ai-admin-postgres.mjs";
import { createAutoListingAiAdminService } from "./auto-listing-ai-admin-service.mjs";
import { createAutoListingCategoryStrategyPostgres } from "./auto-listing-category-strategy-postgres.mjs";
import { createCategoryStrategySampleStore } from "./auto-listing-category-strategy-sample-store.mjs";
import { createAutoListingCategoryStrategyService } from "./auto-listing-category-strategy-service.mjs";
import { downloadSourceImage } from "./auto-listing-source-downloader.mjs";
import { getPostgresPool } from "./db/connection.mjs";
import { createExpectedHashObjectStorage } from "./object-storage.mjs";
import { autoListingEnabled } from "./runtime-config.mjs";

const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;

function runtimeError(code, status = 503, retryable = true) {
  return Object.assign(new Error(code), { code, status, retryable });
}

function createReadModel({ pool }) {
  const select = `SELECT draft.id AS draft_id,draft.account_id,draft.taxonomy_scope,
      draft.description_category_id,draft.type_id,draft.draft_version,draft.status,
      draft.source_collect_item_id,draft.expected_source_version,item.source_url AS browser_url,
      COALESCE(sample_set.sample_count,0)::INTEGER AS sample_count
    FROM auto_listing_category_strategy_drafts draft
    JOIN collect_items item ON item.account_id=draft.account_id AND item.id=draft.source_collect_item_id
    LEFT JOIN LATERAL (
      SELECT sealed.sample_count
      FROM auto_listing_category_strategy_sample_sets sealed
      WHERE sealed.account_id=draft.account_id AND sealed.draft_id=draft.id AND sealed.status='SEALED'
      ORDER BY sealed.created_at DESC,sealed.id DESC LIMIT 1
    ) sample_set ON TRUE`;
  const row = (value) => value ? {
    draftId: value.draft_id,
    accountId: value.account_id,
    scope: {
      accountId: value.account_id,
      taxonomyScope: value.taxonomy_scope,
      descriptionCategoryId: Number(value.description_category_id),
      typeId: Number(value.type_id),
    },
    draftVersion: Number(value.draft_version),
    status: value.status,
    sampleCount: Number(value.sample_count),
    sourceCollectItemId: value.source_collect_item_id,
    expectedSourceVersion: value.expected_source_version,
    browserUrl: value.browser_url,
  } : null;
  return Object.freeze({
    async listStrategies({ accountId }) {
      const result = await pool.query(`${select}
        WHERE draft.account_id=$1
        ORDER BY draft.updated_at DESC,draft.id DESC LIMIT 1000`, [accountId]);
      return result.rows.map(row);
    },
    async getDraft({ accountId, draftId }) {
      const result = await pool.query(`${select}
        WHERE draft.account_id=$1 AND draft.id=$2`, [accountId, draftId]);
      return row(result.rows[0]);
    },
  });
}

function createMemoryExtensionSessionChannel() {
  const records = new Map();
  return Object.freeze({
    async putSession(value) {
      records.set(`${value.accountId}\0${value.sessionId}`, Object.freeze({ ...value }));
    },
  });
}

function absentExactProductFacts() {
  return Object.freeze({
    async verify() {
      throw runtimeError("AUTO_LISTING_CATEGORY_STRATEGY_EXACT_FACTS_NOT_READY", 409, false);
    },
  });
}

function createSessionIdentityDeriver(env) {
  return async function deriveSessionIdentity(input) {
    const key = typeof env.APP_ENCRYPTION_KEY === "string" ? env.APP_ENCRYPTION_KEY.trim() : "";
    if (key.length < 32) {
      throw runtimeError("AUTO_LISTING_CATEGORY_STRATEGY_SESSION_IDENTITY_NOT_READY", 409, false);
    }
    const material = JSON.stringify({ accountId: input.accountId, draftId: input.draftId,
      expectedDraftVersion: input.expectedDraftVersion, idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId });
    const derive = (purpose) => crypto.createHmac("sha256", key)
      .update(`auto-listing-category-strategy:${purpose}\0${material}`, "utf8").digest("hex");
    return Object.freeze({ sessionId: `session-${derive("session-id").slice(0, 40)}`,
      sessionSecret: derive("session-secret") });
  };
}

function sampleImageFetcher(downloadImage) {
  return async function fetchImage(input) {
    if (input.signal?.aborted) throw Object.assign(new Error("aborted"), { code: "ABORT_ERR" });
    const downloaded = await downloadImage({
      sourceUrl: input.sourceUrl,
      timeoutMs: input.timeoutMs,
      maxBytes: input.maxBytes,
      maxRedirects: input.maxRedirects,
      forbidHttpsDowngrade: input.forbidHttpsDowngrade,
    });
    if (input.signal?.aborted) throw Object.assign(new Error("aborted"), { code: "ABORT_ERR" });
    return Object.freeze({ buffer: downloaded.bytes, contentType: downloaded.contentType });
  };
}

function createPublicationService({ pool, createRepository, createService }) {
  return createService({
    repository: createRepository({ pool }),
    capabilityService: Object.freeze({
      async testGatewayCapabilities() {
        throw runtimeError("AUTO_LISTING_CATEGORY_STRATEGY_ANALYSIS_NOT_READY", 409, false);
      },
    }),
    allowLocalGateway: false,
    allowedSecretEnvNames: [],
    allowedGatewayBaseUrls: [],
    allowedGatewayOrigins: [],
  });
}

export function createAutoListingCategoryStrategyRuntime({
  env = process.env,
  getPostgresPool: resolvePool = getPostgresPool,
  createRepository = createAutoListingCategoryStrategyPostgres,
  createStrategyReadModel = createReadModel,
  createSampleStore = createCategoryStrategySampleStore,
  createObjectStorage = createExpectedHashObjectStorage,
  createService = createAutoListingCategoryStrategyService,
  createPublicationRepository = createAutoListingAiAdminPostgres,
  createAdminService = createAutoListingAiAdminService,
  exactProductFacts = null,
  extensionSessionChannel = null,
  deriveSessionIdentity = null,
  downloadImage = downloadSourceImage,
  now = () => new Date(),
  maxDownloadBytes = MAX_DOWNLOAD_BYTES,
} = {}) {
  if (!env || typeof env !== "object" || Array.isArray(env) || typeof resolvePool !== "function"
    || typeof createRepository !== "function" || typeof createStrategyReadModel !== "function"
    || typeof createSampleStore !== "function" || typeof createObjectStorage !== "function"
    || typeof createService !== "function" || typeof createPublicationRepository !== "function"
    || typeof createAdminService !== "function"
    || !(exactProductFacts === null || typeof exactProductFacts?.verify === "function")
    || !(extensionSessionChannel === null || typeof extensionSessionChannel?.putSession === "function")
    || !(deriveSessionIdentity === null || typeof deriveSessionIdentity === "function")
    || typeof downloadImage !== "function" || typeof now !== "function"
    || !Number.isInteger(maxDownloadBytes) || maxDownloadBytes < 1 || maxDownloadBytes > MAX_DOWNLOAD_BYTES) {
    throw new TypeError("Auto-listing category strategy runtime dependencies are required");
  }
  const sessionChannel = extensionSessionChannel ?? createMemoryExtensionSessionChannel();
  let servicePromise = null;
  function getService() {
    if (!autoListingEnabled(env)) {
      return Promise.reject(runtimeError("AUTO_LISTING_CATEGORY_STRATEGY_DISABLED", 404, false));
    }
    if (!servicePromise) {
      const initialization = Promise.resolve().then(async () => {
        let pool;
        try { pool = await resolvePool(); } catch {
          throw runtimeError("AUTO_LISTING_CATEGORY_STRATEGY_INITIALIZATION_FAILED");
        }
        if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
          throw runtimeError("AUTO_LISTING_CATEGORY_STRATEGY_INITIALIZATION_FAILED");
        }
        try {
          const repository = createRepository({ pool });
          const readModel = createStrategyReadModel({ pool });
          const objectStorage = createObjectStorage();
          const sampleStore = createSampleStore({
            fetchImage: sampleImageFetcher(downloadImage), objectStorage, now, maxDownloadBytes,
          });
          const publicationService = createPublicationService({ pool,
            createRepository: createPublicationRepository, createService: createAdminService });
          return createService({ repository, readModel, sampleStore,
            exactProductFacts: exactProductFacts ?? absentExactProductFacts(),
            extensionSessionChannel: sessionChannel, publicationService, now,
            deriveSessionIdentity: deriveSessionIdentity ?? createSessionIdentityDeriver(env) });
        } catch (error) {
          if (typeof error?.code === "string" && error.code.startsWith("AUTO_LISTING_CATEGORY_STRATEGY_")) throw error;
          throw runtimeError("AUTO_LISTING_CATEGORY_STRATEGY_INITIALIZATION_FAILED");
        }
      });
      servicePromise = initialization;
      initialization.catch(() => { if (servicePromise === initialization) servicePromise = null; });
    }
    return servicePromise;
  }
  return Object.freeze({ getService });
}
