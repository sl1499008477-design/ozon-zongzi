import crypto from "node:crypto";
import { types } from "node:util";

import { createAutoListingAiAdminPostgres } from "./auto-listing-ai-admin-postgres.mjs";
import { createAutoListingAiAdminService } from "./auto-listing-ai-admin-service.mjs";
import { createDefaultAutoListingGatewayProductionPorts } from "./auto-listing-ai-runtime-composition.mjs";
import { createCategoryStrategyAnalysisAiAdapter } from "./auto-listing-category-strategy-ai-adapter.mjs";
import { createCategoryStrategyAnalyzer } from "./auto-listing-category-strategy-analyzer.mjs";
import { createCategoryStrategyObservability } from "./auto-listing-category-strategy-observability.mjs";
import { createAutoListingCategoryStrategyPostgres } from "./auto-listing-category-strategy-postgres.mjs";
import { createCategoryStrategySampleStore } from "./auto-listing-category-strategy-sample-store.mjs";
import { createAutoListingCategoryStrategyService } from "./auto-listing-category-strategy-service.mjs";
import { downloadSourceImage } from "./auto-listing-source-downloader.mjs";
import { getPostgresPool } from "./db/connection.mjs";
import { createExpectedHashObjectStorage } from "./object-storage.mjs";
import { autoListingEnabled } from "./runtime-config.mjs";

const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;
const EXTENSION_READY_TTL_MS = 5 * 60 * 1000;
const EXTENSION_MODE = "CATEGORY_STRATEGY_SAMPLING";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function runtimeError(code, status = 503, retryable = true) {
  return Object.assign(new Error(code), { code, status, retryable });
}

function extensionClosed(raw, keys, code = "AUTO_LISTING_CATEGORY_STRATEGY_EXTENSION_INPUT_INVALID") {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || types.isProxy(raw)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw new Error(code);
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const own = Reflect.ownKeys(descriptors);
    if (own.length !== keys.size || own.some((key) => typeof key !== "string" || !keys.has(key)
      || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) {
      throw new Error(code);
    }
    return Object.fromEntries(own.map((key) => [key, descriptors[key].value]));
  } catch (error) {
    if (error?.code === code) throw error;
    throw runtimeError(code, 400, false);
  }
}

function extensionArray(raw, minimum, maximum) {
  try {
    if (!Array.isArray(raw) || types.isProxy(raw) || Object.getPrototypeOf(raw) !== Array.prototype
      || raw.length < minimum || raw.length > maximum) throw new Error("invalid");
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    if (Reflect.ownKeys(descriptors).length !== raw.length + 1
      || descriptors.length?.value !== raw.length) throw new Error("invalid");
    return Array.from({ length: raw.length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) {
        throw new Error("invalid");
      }
      return descriptor.value;
    });
  } catch {
    throw runtimeError("AUTO_LISTING_CATEGORY_STRATEGY_EXTENSION_INPUT_INVALID", 400, false);
  }
}

function extensionId(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(text) || text !== value) {
    throw runtimeError("AUTO_LISTING_CATEGORY_STRATEGY_EXTENSION_INPUT_INVALID", 400, false);
  }
  return text;
}

function extensionScope(raw) {
  const value = extensionClosed(raw,
    new Set(["taxonomyScope", "descriptionCategoryId", "typeId"]));
  if (value.taxonomyScope !== "OZON:DEFAULT"
    || !Number.isSafeInteger(value.descriptionCategoryId) || value.descriptionCategoryId < 1
    || !Number.isSafeInteger(value.typeId) || value.typeId < 1) {
    throw runtimeError("AUTO_LISTING_CATEGORY_STRATEGY_EXTENSION_INPUT_INVALID", 400, false);
  }
  return Object.freeze({ taxonomyScope: value.taxonomyScope,
    descriptionCategoryId: value.descriptionCategoryId, typeId: value.typeId });
}

function sameExtensionScope(left, right) {
  return left.taxonomyScope === right.taxonomyScope
    && left.descriptionCategoryId === right.descriptionCategoryId && left.typeId === right.typeId;
}

function extensionVersionParts(value) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:\.\d+)?$/u.test(value)) return null;
  const parts = value.split(".").map(Number);
  return parts.length === 3 ? [...parts, 0] : parts;
}

function extensionVersionAtLeast(value, minimum) {
  const left = extensionVersionParts(value);
  const right = extensionVersionParts(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < 4; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return true;
}

function extensionSourceUrl(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 2048) {
    throw runtimeError("AUTO_LISTING_CATEGORY_STRATEGY_EXTENSION_INPUT_INVALID", 400, false);
  }
  let url;
  try { url = new URL(value); } catch {
    throw runtimeError("AUTO_LISTING_CATEGORY_STRATEGY_EXTENSION_INPUT_INVALID", 400, false);
  }
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  const allowed = host === "ozone.ru" || host.endsWith(".ozone.ru")
    || host === "ozonusercontent.com" || host.endsWith(".ozonusercontent.com")
    || host === "ozonru.cn" || host.endsWith(".ozonru.cn");
  if (url.protocol !== "https:" || url.username || url.password || !allowed) {
    throw runtimeError("AUTO_LISTING_CATEGORY_STRATEGY_EXTENSION_INPUT_INVALID", 400, false);
  }
  return url.href;
}

function projectExtensionReference(raw, index) {
  const value = extensionClosed(raw,
    new Set(["imageId", "role", "ordinal", "sourceUrl", "sourceResponseHash"]));
  const role = index === 0 ? "MAIN" : "DETAIL";
  if (value.role !== role || value.ordinal !== index || typeof value.sourceResponseHash !== "string"
    || !SHA256.test(value.sourceResponseHash)) {
    throw runtimeError("AUTO_LISTING_CATEGORY_STRATEGY_EXTENSION_INPUT_INVALID", 400, false);
  }
  return Object.freeze({ imageId: extensionId(value.imageId), role, ordinal: index,
    sourceUrl: extensionSourceUrl(value.sourceUrl), sourceResponseHash: value.sourceResponseHash });
}

function projectExtensionPageFact(raw) {
  const value = extensionClosed(raw, new Set(["pageScope", "sourceResponseHash"]));
  if (typeof value.sourceResponseHash !== "string" || !SHA256.test(value.sourceResponseHash)) {
    throw runtimeError("AUTO_LISTING_CATEGORY_STRATEGY_EXTENSION_INPUT_INVALID", 400, false);
  }
  return Object.freeze({ pageScope: extensionScope(value.pageScope),
    sourceResponseHash: value.sourceResponseHash });
}

function projectExtensionProductFact(raw) {
  const value = extensionClosed(raw, new Set([
    "sku", "sourceProductId", "sourceProductRef", "sourceProductResponseHash",
    "pageScope", "productScope", "sourceReferences",
  ]));
  const sku = extensionId(value.sku);
  if (!/^\d{5,20}$/u.test(sku) || !Number.isSafeInteger(value.sourceProductId)
    || value.sourceProductId < 1 || Number(sku) !== value.sourceProductId
    || typeof value.sourceProductResponseHash !== "string" || !SHA256.test(value.sourceProductResponseHash)) {
    throw runtimeError("AUTO_LISTING_CATEGORY_STRATEGY_EXTENSION_INPUT_INVALID", 400, false);
  }
  const references = extensionArray(value.sourceReferences, 1, 6)
    .map((reference, index) => projectExtensionReference(reference, index));
  if (new Set(references.map((reference) => reference.imageId)).size !== references.length) {
    throw runtimeError("AUTO_LISTING_CATEGORY_STRATEGY_EXTENSION_INPUT_INVALID", 400, false);
  }
  return Object.freeze({ sku, sourceProductId: value.sourceProductId,
    sourceProductRef: extensionId(value.sourceProductRef),
    sourceProductResponseHash: value.sourceProductResponseHash,
    pageScope: extensionScope(value.pageScope), productScope: extensionScope(value.productScope),
    sourceReferences: Object.freeze(references) });
}

export function createCategoryStrategyExtensionChannel({
  now = () => Date.now(), minimumExtensionVersion = "0.13.46.14",
  readyTtlMs = EXTENSION_READY_TTL_MS,
} = {}) {
  if (typeof now !== "function" || !extensionVersionParts(minimumExtensionVersion)
    || !Number.isInteger(readyTtlMs) || readyTtlMs < 1 || readyTtlMs > 60 * 60 * 1000) {
    throw new TypeError("Category strategy extension channel dependencies are required");
  }
  const readiness = new Map();
  const sessions = new Map();
  const sessionKey = (accountId, sessionId) => `${accountId}\0${sessionId}`;
  const timestamp = () => {
    const value = Number(now());
    if (!Number.isFinite(value)) throw runtimeError("AUTO_LISTING_CATEGORY_STRATEGY_EXTENSION_CLOCK_INVALID");
    return value;
  };
  const assertVersion = (version) => {
    if (!extensionVersionAtLeast(version, minimumExtensionVersion)) {
      throw runtimeError("AUTO_LISTING_CATEGORY_STRATEGY_EXTENSION_VERSION_UNSUPPORTED", 426, false);
    }
    return version;
  };
  const sessionRecord = (accountId, sessionId = null) => {
    if (sessionId === null) return null;
    const key = sessionKey(accountId, sessionId);
    const record = sessions.get(key) || null;
    if (!record) return null;
    if (Date.parse(record.expiresAt) <= timestamp()) {
      sessions.delete(key);
      return null;
    }
    return record;
  };
  const activeRecord = (accountId, sessionId = null) => {
    const record = sessionRecord(accountId, sessionId);
    return record?.state === "ACTIVE" ? record : null;
  };
  const channel = {
    async markReady(raw) {
      const input = extensionClosed(raw, new Set(["accountId", "extensionVersion"]));
      const accountId = extensionId(input.accountId);
      assertVersion(input.extensionVersion);
      readiness.set(accountId, { version: input.extensionVersion, observedAt: timestamp() });
      return Object.freeze({ ready: true, minimumExtensionVersion });
    },
    async assertReady(raw) {
      const input = extensionClosed(raw, new Set(["accountId"]));
      const accountId = extensionId(input.accountId);
      const record = readiness.get(accountId);
      if (!record || record.observedAt + readyTtlMs <= timestamp()
        || !extensionVersionAtLeast(record.version, minimumExtensionVersion)) {
        readiness.delete(accountId);
        throw runtimeError("AUTO_LISTING_CATEGORY_STRATEGY_SESSION_HANDOFF_NOT_READY", 409, false);
      }
      return true;
    },
    async putSession(raw) {
      const input = extensionClosed(raw, new Set([
        "accountId", "actorId", "draftId", "expectedDraftVersion", "sessionId", "sessionSecret",
        "expiresAt", "extensionMode", "scope",
      ]));
      const accountId = extensionId(input.accountId);
      await channel.assertReady({ accountId });
      const expiry = new Date(input.expiresAt);
      if (extensionId(input.actorId) !== accountId || !Number.isSafeInteger(input.expectedDraftVersion)
        || input.expectedDraftVersion < 1 || input.extensionMode !== EXTENSION_MODE
        || typeof input.sessionSecret !== "string" || input.sessionSecret.length < 32
        || input.sessionSecret.length > 512 || Number.isNaN(expiry.getTime())
        || expiry.toISOString() !== input.expiresAt || expiry.getTime() <= timestamp()) {
        throw runtimeError("AUTO_LISTING_CATEGORY_STRATEGY_EXTENSION_INPUT_INVALID", 400, false);
      }
      const record = { accountId, actorId: accountId, draftId: extensionId(input.draftId),
        expectedDraftVersion: input.expectedDraftVersion, sessionId: extensionId(input.sessionId),
        sessionSecret: input.sessionSecret, expiresAt: input.expiresAt, extensionMode: EXTENSION_MODE,
        scope: extensionScope(input.scope), state: "ACTIVE", pageFact: null, samples: new Map() };
      sessions.set(sessionKey(accountId, record.sessionId), record);
      return true;
    },
    async getSession(raw) {
      const input = extensionClosed(raw, new Set(["accountId", "sessionId", "extensionVersion"]));
      const accountId = extensionId(input.accountId);
      assertVersion(input.extensionVersion);
      const record = activeRecord(accountId, extensionId(input.sessionId));
      if (!record) return null;
      return Object.freeze({ sessionId: record.sessionId, draftId: record.draftId,
        extensionMode: record.extensionMode, scope: record.scope, expiresAt: record.expiresAt,
        sessionSecret: record.sessionSecret });
    },
    async putFacts(raw) {
      const input = extensionClosed(raw,
        new Set(["accountId", "sessionId", "extensionVersion", "pageFact", "samples"]));
      const accountId = extensionId(input.accountId);
      assertVersion(input.extensionVersion);
      const record = sessionRecord(accountId, extensionId(input.sessionId));
      if (!record) throw runtimeError("AUTO_LISTING_CATEGORY_STRATEGY_EXTENSION_SESSION_NOT_FOUND", 404, false);
      const pageFact = projectExtensionPageFact(input.pageFact);
      const samples = extensionArray(input.samples, 5, 20).map(projectExtensionProductFact);
      if (!sameExtensionScope(pageFact.pageScope, record.scope)
        || samples.some((sample) => !sameExtensionScope(sample.pageScope, record.scope)
          || !sameExtensionScope(sample.productScope, record.scope))
        || new Set(samples.map((sample) => sample.sku)).size !== samples.length
        || new Set(samples.map((sample) => sample.sourceProductId)).size !== samples.length) {
        throw runtimeError("AUTO_LISTING_CATEGORY_STRATEGY_SAMPLE_SCOPE_CONFLICT", 409, false);
      }
      if (record.state === "COMPLETED") {
        const previous = JSON.stringify({ pageFact: record.pageFact,
          samples: [...record.samples.values()] });
        if (previous !== JSON.stringify({ pageFact, samples })) {
          throw runtimeError("AUTO_LISTING_CATEGORY_STRATEGY_IDEMPOTENCY_CONFLICT", 409, false);
        }
      } else if (record.state === "ACTIVE") {
        record.pageFact = pageFact;
        record.samples = new Map(samples.map((sample) => [sample.sku, sample]));
      } else {
        throw runtimeError("AUTO_LISTING_CATEGORY_STRATEGY_EXTENSION_SESSION_NOT_FOUND", 404, false);
      }
      return Object.freeze({ accountId, actorId: record.actorId, draftId: record.draftId,
        expectedDraftVersion: record.expectedDraftVersion, sessionId: record.sessionId,
        sessionSecret: record.sessionSecret,
        selections: Object.freeze(samples.map(({ sku, sourceProductId, sourceProductRef }) =>
          Object.freeze({ sku, sourceProductId, sourceProductRef }))) });
    },
    async verify(raw) {
      const input = extensionClosed(raw, new Set([
        "accountId", "draftId", "sessionId", "sessionSecretHash", "scope", "sku",
        "sourceProductId", "sourceProductRef", "correlationId",
      ]));
      const accountId = extensionId(input.accountId);
      const record = sessionRecord(accountId, extensionId(input.sessionId));
      const suppliedHash = typeof input.sessionSecretHash === "string" ? input.sessionSecretHash : "";
      const expectedHash = record
        ? crypto.createHash("sha256").update(record.sessionSecret, "utf8").digest("hex") : "0".repeat(64);
      let secretMatches = false;
      if (SHA256.test(suppliedHash)) {
        secretMatches = crypto.timingSafeEqual(Buffer.from(suppliedHash, "hex"), Buffer.from(expectedHash, "hex"));
      }
      if (!record || record.draftId !== extensionId(input.draftId) || !secretMatches
        || !sameExtensionScope(extensionScope(input.scope), record.scope)) {
        throw runtimeError("AUTO_LISTING_CATEGORY_STRATEGY_EXACT_FACTS_NOT_READY", 409, false);
      }
      extensionId(input.correlationId);
      const fact = record.samples.get(extensionId(input.sku));
      if (!fact || fact.sourceProductId !== input.sourceProductId
        || fact.sourceProductRef !== input.sourceProductRef) {
        throw runtimeError("AUTO_LISTING_CATEGORY_STRATEGY_EXACT_FACTS_NOT_READY", 409, false);
      }
      return fact;
    },
    async cancelSession(raw) {
      const input = extensionClosed(raw,
        new Set(["accountId", "sessionId", "extensionVersion"]));
      const accountId = extensionId(input.accountId);
      assertVersion(input.extensionVersion);
      const record = activeRecord(accountId, extensionId(input.sessionId));
      if (!record) return false;
      record.state = "CANCELLED";
      record.pageFact = null;
      record.samples.clear();
      sessions.delete(sessionKey(accountId, record.sessionId));
      return true;
    },
    async completeSession(raw) {
      const input = extensionClosed(raw, new Set(["accountId", "sessionId"]));
      const accountId = extensionId(input.accountId);
      const record = sessionRecord(accountId, extensionId(input.sessionId));
      if (!record) return false;
      record.state = "COMPLETED";
      return true;
    },
  };
  return Object.freeze(channel);
}

export function createCategoryStrategyReadModel({ pool }) {
  const select = `SELECT draft.id AS draft_id,draft.account_id,draft.taxonomy_scope,
      draft.description_category_id,draft.type_id,draft.draft_version,draft.status,
      draft.source_collect_item_id,draft.expected_source_version,
      COALESCE(NULLIF(current_draft.data->>'buyerCategoryUrl',''),item.source_url) AS browser_url,
      sample_set.id AS sample_set_id,
      COALESCE(sample_set.sample_count,0)::INTEGER AS sample_count
    FROM auto_listing_category_strategy_drafts draft
    JOIN collect_items item ON item.account_id=draft.account_id AND item.id=draft.source_collect_item_id
    LEFT JOIN product_drafts current_draft
      ON current_draft.id=item.current_draft_id AND current_draft.collect_item_id=item.id
    LEFT JOIN LATERAL (
      SELECT sealed.id,sealed.sample_count
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
    async getDraftDetail({ accountId, draftId }) {
      const result = await pool.query(`WITH target AS (
        ${select}
        WHERE draft.account_id=$1 AND draft.id=$2
      )
      SELECT target.*,
        CASE WHEN session.id IS NULL THEN NULL ELSE jsonb_build_object(
          'sessionId',session.id,'state',session.state,
          'expiresAt',TO_CHAR(session.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ) END AS session,
        COALESCE(sample_cards.samples,'[]'::JSONB) AS samples,
        CASE WHEN analysis.id IS NULL THEN NULL ELSE jsonb_build_object(
          'attemptId',analysis.attempt_id,'resultId',analysis.id,
          'status',CASE WHEN analysis.source_kind='MANUAL'
            OR analysis.raw_response->>'validationStatus'='ACCEPTED' THEN 'DRAFT_READY' ELSE 'NEEDS_REVIEW' END,
          'draftVersion',target.draft_version,'duplicate',FALSE,
          'safeCode',analysis.raw_response->>'safeCode','guidance',analysis.guidance,
          'evidenceSummary',analysis.evidence_summary,
          'provenance',analysis.source_kind,
          'editedAt',CASE WHEN analysis.edited_at IS NULL THEN NULL ELSE
            TO_CHAR(analysis.edited_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
          'baseAnalysisAttemptId',analysis.base_analysis_attempt_id
        ) END AS analysis,
        versions.published,
        COALESCE(category_publications.items,'[]'::JSONB) AS category_publications,
        COALESCE(versions.items,'[]'::JSONB) AS versions
      FROM target
      LEFT JOIN LATERAL (
        SELECT id,state,expires_at
        FROM auto_listing_category_strategy_sampling_sessions
        WHERE account_id=target.account_id AND draft_id=target.draft_id AND state='ACTIVE'
        ORDER BY created_at DESC,id DESC LIMIT 1
      ) session ON TRUE
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
          'sampleId',sample.id,'sku',sample.sku,'title',NULL,'imageCount',image.count,
          'status','READY','excludedReasons','[]'::JSONB,'thumbnailImageId',image.thumbnail_image_id,
          'previewRole',image.preview_role,'previewWidth',image.preview_width,'previewHeight',image.preview_height,
          'mainImageWidth',image.main_image_width,'mainImageHeight',image.main_image_height
        ) ORDER BY sample.ordinal,sample.id) AS samples
        FROM auto_listing_category_strategy_samples sample
        JOIN LATERAL (
          SELECT COUNT(*)::INTEGER AS count,
                 (ARRAY_AGG(sample_image.image_id ORDER BY
                   sample_image.width::BIGINT*sample_image.height DESC,sample_image.ordinal,sample_image.id))[1]
                   AS thumbnail_image_id,
                 (ARRAY_AGG(sample_image.role ORDER BY
                   sample_image.width::BIGINT*sample_image.height DESC,sample_image.ordinal,sample_image.id))[1]
                   AS preview_role,
                 (ARRAY_AGG(sample_image.width ORDER BY
                   sample_image.width::BIGINT*sample_image.height DESC,sample_image.ordinal,sample_image.id))[1]
                   AS preview_width,
                 (ARRAY_AGG(sample_image.height ORDER BY
                   sample_image.width::BIGINT*sample_image.height DESC,sample_image.ordinal,sample_image.id))[1]
                   AS preview_height,
                 MAX(sample_image.width) FILTER (WHERE sample_image.role='MAIN') AS main_image_width,
                 MAX(sample_image.height) FILTER (WHERE sample_image.role='MAIN') AS main_image_height
          FROM auto_listing_category_strategy_sample_images sample_image
          WHERE sample_image.account_id=sample.account_id AND sample_image.draft_id=sample.draft_id
            AND sample_image.sample_set_id=sample.sample_set_id AND sample_image.sample_id=sample.id
        ) image ON image.count BETWEEN 1 AND 6
        WHERE sample.account_id=target.account_id AND sample.draft_id=target.draft_id
          AND sample.sample_set_id=(
            SELECT sealed.id FROM auto_listing_category_strategy_sample_sets sealed
            WHERE sealed.account_id=target.account_id AND sealed.draft_id=target.draft_id
              AND sealed.status='SEALED' ORDER BY sealed.created_at DESC,sealed.id DESC LIMIT 1
          )
      ) sample_cards ON TRUE
      LEFT JOIN LATERAL (
        SELECT result.*,COALESCE(result.raw_response->'evidenceSummary',
          base.raw_response->'evidenceSummary') AS evidence_summary
        FROM auto_listing_category_strategy_analysis_results result
        LEFT JOIN auto_listing_category_strategy_analysis_results base
          ON base.account_id=result.account_id AND base.draft_id=result.draft_id
         AND base.attempt_id=result.base_analysis_attempt_id AND base.source_kind='AI'
        WHERE result.account_id=target.account_id AND result.draft_id=target.draft_id
          AND result.sample_set_id=target.sample_set_id
        ORDER BY result.created_at DESC,result.id DESC LIMIT 1
      ) analysis ON TRUE
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
          'eventId',publication.id,
          'strategyVersionId',publication.published_strategy_version_id,
          'strategyVersion',version.version,
          'publishedAt',TO_CHAR(publication.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ) ORDER BY publication.created_at DESC,publication.id DESC) AS items
        FROM auto_listing_category_strategy_events publication
        JOIN ai_content_strategy_versions version
          ON version.account_id=publication.account_id AND version.id=publication.published_strategy_version_id
        WHERE publication.account_id=target.account_id AND publication.event_type='PUBLISHED'
          AND publication.taxonomy_scope=target.taxonomy_scope
          AND publication.description_category_id=target.description_category_id
          AND publication.type_id=target.type_id
      ) category_publications ON TRUE
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
          'id',version.id,'strategyKey',version.strategy_key,'version',version.version,'status',version.status
        ) ORDER BY version.version DESC,version.id DESC) AS items,
        (jsonb_agg(jsonb_build_object(
          'id',version.id,'strategyKey',version.strategy_key,'version',version.version,'status',version.status
        ) ORDER BY version.version DESC,version.id DESC) FILTER (WHERE version.status='PUBLISHED'))->0 AS published
        FROM ai_content_strategy_versions version
        WHERE version.account_id=target.account_id AND version.strategy_key='default'
      ) versions ON TRUE`, [accountId, draftId]);
      const value = result.rows[0];
      return value ? { draft: row(value), session: value.session, samples: value.samples,
        analysis: value.analysis, published: value.published,
        categoryPublications: value.category_publications, versions: value.versions } : null;
    },
    async getThumbnailEvidence({ accountId, draftId, sampleId, imageId }) {
      const result = await pool.query(
        `SELECT image.account_id,image.draft_id,image.sample_id,image.image_id,
                image.thumbnail_object_key,image.thumbnail_content_hash
           FROM auto_listing_category_strategy_sample_images image
           JOIN auto_listing_category_strategy_sample_sets sample_set
             ON sample_set.account_id=image.account_id AND sample_set.id=image.sample_set_id
            AND sample_set.draft_id=image.draft_id AND sample_set.status='SEALED'
          WHERE image.account_id=$1 AND image.draft_id=$2 AND image.sample_id=$3 AND image.image_id=$4`,
        [accountId, draftId, sampleId, imageId],
      );
      const value = result.rows[0];
      return value ? { accountId: value.account_id, draftId: value.draft_id,
        sampleId: value.sample_id, imageId: value.image_id, objectKey: value.thumbnail_object_key,
        contentHash: value.thumbnail_content_hash } : null;
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

export function createCategoryStrategyAnalysisConfigurationResolver({ pool } = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("Category strategy analysis configuration resolver requires PostgreSQL");
  }
  return Object.freeze({
    async resolve({ accountId } = {}) {
      if (typeof accountId !== "string" || !SAFE_ID.test(accountId) || accountId !== accountId.trim()) {
        throw runtimeError("AUTO_LISTING_CATEGORY_STRATEGY_ANALYSIS_CONFIGURATION_INVALID", 400, false);
      }
      const result = await pool.query(
        `SELECT id,config_version,text_model
           FROM ai_gateway_profiles
          WHERE account_id=$1 AND enabled IS TRUE
          ORDER BY id,config_version
          LIMIT 2`,
        [accountId],
      );
      if (result.rows.length !== 1) {
        throw runtimeError(result.rows.length === 0
          ? "AUTO_LISTING_CATEGORY_STRATEGY_ANALYSIS_PROFILE_NOT_CONFIGURED"
          : "AUTO_LISTING_CATEGORY_STRATEGY_ANALYSIS_PROFILE_AMBIGUOUS", 409, false);
      }
      const row = result.rows[0];
      return Object.freeze({
        analyzerVersion: "category-strategy-v1",
        promptVersion: "category-strategy-prompt-v2",
        profileId: row.id,
        profileVersion: Number(row.config_version),
        model: row.text_model,
      });
    },
  });
}

export function createAutoListingCategoryStrategyRuntime({
  env = process.env,
  getPostgresPool: resolvePool = getPostgresPool,
  createRepository = createAutoListingCategoryStrategyPostgres,
  createStrategyReadModel = createCategoryStrategyReadModel,
  createSampleStore = createCategoryStrategySampleStore,
  createObjectStorage = createExpectedHashObjectStorage,
  createAnalyzer = createCategoryStrategyAnalyzer,
  analysisAiAdapter = null,
  createAnalysisAiAdapter = createCategoryStrategyAnalysisAiAdapter,
  createAnalysisGatewayPorts = createDefaultAutoListingGatewayProductionPorts,
  createService = createAutoListingCategoryStrategyService,
  createPublicationRepository = createAutoListingAiAdminPostgres,
  createAdminService = createAutoListingAiAdminService,
  exactProductFacts = null,
  extensionSessionChannel = null,
  deriveSessionIdentity = null,
  downloadImage = downloadSourceImage,
  now = () => new Date(),
  maxDownloadBytes = MAX_DOWNLOAD_BYTES,
  metrics = null,
  logger = console,
  createObservability = createCategoryStrategyObservability,
} = {}) {
  if (!env || typeof env !== "object" || Array.isArray(env) || typeof resolvePool !== "function"
    || typeof createRepository !== "function" || typeof createStrategyReadModel !== "function"
    || typeof createSampleStore !== "function" || typeof createObjectStorage !== "function"
    || typeof createAnalyzer !== "function"
    || typeof createAnalysisAiAdapter !== "function" || typeof createAnalysisGatewayPorts !== "function"
    || !(analysisAiAdapter === null || (typeof analysisAiAdapter?.analyze === "function"
      && typeof analysisAiAdapter?.recover === "function"))
    || typeof createService !== "function" || typeof createPublicationRepository !== "function"
    || typeof createAdminService !== "function"
    || !(exactProductFacts === null || typeof exactProductFacts?.verify === "function")
    || !(extensionSessionChannel === null || (typeof extensionSessionChannel?.assertReady === "function"
      && typeof extensionSessionChannel?.putSession === "function"))
    || !(deriveSessionIdentity === null || typeof deriveSessionIdentity === "function")
    || !(metrics === null || typeof metrics?.increment === "function")
    || !(logger === null || typeof logger?.info === "function")
    || typeof createObservability !== "function"
    || typeof downloadImage !== "function" || typeof now !== "function"
    || !Number.isInteger(maxDownloadBytes) || maxDownloadBytes < 1 || maxDownloadBytes > MAX_DOWNLOAD_BYTES) {
    throw new TypeError("Auto-listing category strategy runtime dependencies are required");
  }
  const sessionChannel = extensionSessionChannel ?? createCategoryStrategyExtensionChannel({
    now: () => new Date(now()).getTime(),
    minimumExtensionVersion: String(
      env.AUTO_LISTING_CATEGORY_STRATEGY_MIN_EXTENSION_VERSION || "0.13.46.14",
    ),
  });
  const factsPort = exactProductFacts
    ?? (extensionSessionChannel === null ? sessionChannel : absentExactProductFacts());
  const observabilitySecret = String(
    env.AUTO_LISTING_CATEGORY_STRATEGY_OBSERVABILITY_HASH_SECRET || "",
  );
  const observability = observabilitySecret ? createObservability({ metrics, logger,
    now: () => new Date(now()).getTime(), accountHashSecret: observabilitySecret }) : null;
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
          let analysisGatewayPromise = null;
          const getAnalysisGateway = () => {
            if (!analysisGatewayPromise) {
              const initialization = Promise.resolve(createAnalysisGatewayPorts({
                env, resolvePool: async () => pool,
              })).then((ports) => {
                if (!ports || typeof ports.gateway?.createTextResponse !== "function") {
                  throw runtimeError("AUTO_LISTING_CATEGORY_STRATEGY_ANALYSIS_NOT_READY");
                }
                return ports.gateway;
              });
              analysisGatewayPromise = initialization;
              initialization.catch(() => {
                if (analysisGatewayPromise === initialization) analysisGatewayPromise = null;
              });
            }
            return analysisGatewayPromise;
          };
          const aiAdapter = analysisAiAdapter ?? createAnalysisAiAdapter({
            pool, getGateway: getAnalysisGateway,
          });
          const analyzer = createAnalyzer({ repository, objectStorage,
            aiAdapter,
            configurationResolver: createCategoryStrategyAnalysisConfigurationResolver({ pool }) });
          const publicationService = createPublicationService({ pool,
            createRepository: createPublicationRepository, createService: createAdminService });
          return createService({ repository, readModel, sampleStore, analyzer, objectStorage,
            exactProductFacts: factsPort,
            extensionSessionChannel: sessionChannel, publicationService, now,
            deriveSessionIdentity: deriveSessionIdentity ?? createSessionIdentityDeriver(env),
            ...(observability ? { observability } : {}) });
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
  return Object.freeze({ getService, extensionChannel: sessionChannel });
}
