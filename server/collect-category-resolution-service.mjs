import {
  TAXONOMY_SCOPE_OZON_DEFAULT,
  resolveExactType,
} from "./collect-category-resolution-policy.mjs";

const LEASE_MS = 2 * 60 * 1000;
const RETRY_BASE_MS = 30 * 1000;
const RETRY_MAX_MS = 30 * 60 * 1000;
const RETRYABLE_TRANSPORT_CODES = new Set([
  "NETWORK_ERROR",
  "FETCH_FAILED",
  "TIMEOUT",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "OZON_TIMEOUT",
  "OZON_RATE_LIMITED",
  "OZON_CATEGORY_TREE_UNAVAILABLE",
  "OZON_CATEGORY_ATTRIBUTES_UNAVAILABLE",
]);
const VALIDATION_RETRY_PENDING = "VALIDATION_RETRY_PENDING";
const NON_RETRYABLE_CATEGORY_CODES = new Set([
  "OZON_CATEGORY_DATA_INVALID",
  "OZON_CATEGORY_TAXONOMY_STALE",
  "TAXONOMY_SCOPE_MISMATCH",
]);
const TRANSIENT_VALIDATION_REASONS = new Set([
  "TAXONOMY_UNAVAILABLE",
  "TAXONOMY_STALE",
  "ATTRIBUTES_UNAVAILABLE",
]);
const VERIFIED_TARGET_INVALID_REASONS = new Set([
  "TARGET_INVALID",
  "DESCRIPTION_CATEGORY_NOT_FOUND",
  "DESCRIPTION_CATEGORY_DISABLED",
  "TYPE_NOT_FOUND",
  "TYPE_DISABLED",
  "TYPE_NOT_IN_DESCRIPTION_CATEGORY",
  "ATTRIBUTES_INVALID",
]);

function serviceError(message, code, status) {
  return Object.assign(new Error(message), { code, status });
}

function requiredText(value, field) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw serviceError(
      `Collect category resolution ${field} is required`,
      "COLLECT_CATEGORY_RESOLUTION_INPUT_INVALID",
      400,
    );
  }
  return normalized;
}

function positiveId(value) {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : null;
}

function instant(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw serviceError(
      "Collect category resolution clock returned an invalid instant",
      "COLLECT_CATEGORY_RESOLUTION_CLOCK_INVALID",
      500,
    );
  }
  return date;
}

function sourceCategoryOf(item = {}) {
  const draft = item?.listingDraft && typeof item.listingDraft === "object"
    ? item.listingDraft
    : {};
  const direct = item?.sourceCategory && typeof item.sourceCategory === "object"
    ? item.sourceCategory
    : {};
  const nested = draft?.sourceCategory && typeof draft.sourceCategory === "object"
    ? draft.sourceCategory
    : {};
  return Object.keys(direct).length ? direct : nested;
}

function sourceTypeIdOf(item) {
  const source = sourceCategoryOf(item);
  return positiveId(source.typeIdCandidate ?? source.typeId ?? source.type_id_candidate ?? source.type_id);
}

function enrichmentComplete(item) {
  if (typeof item?.enrichmentComplete === "boolean") return item.enrichmentComplete;
  const status = String(item?.enrichment?.status ?? item?.enrichmentStatus ?? "").toUpperCase();
  return status === "COMPLETE";
}

function credentialStoreUsable(store, accountId, requestedStoreId) {
  if (!store || String(store.id ?? "") !== requestedStoreId) return false;
  const ownerAccountId = String(store.ownerAccountId ?? store.accountId ?? "");
  if (ownerAccountId !== accountId) return false;
  const status = String(store.status ?? "").toUpperCase();
  const explicitlyDisabled = ["DISABLED", "INACTIVE", "ARCHIVED"].includes(status)
    || store.active === false
    || store.enabled === false
    || store.isActive === false
    || store.is_active === false
    || store.archived === true
    || store.isArchived === true
    || store.is_archived === true;
  if (explicitlyDisabled) {
    return false;
  }
  const explicitCredentialState = store.credentialed === true
    || store.hasCredentials === true
    || store.credentialsSaved === true;
  return explicitCredentialState
    || (Boolean(String(store.clientId ?? store.client_id ?? "").trim())
      && Boolean(String(store.apiKey ?? store.api_key ?? "").trim()));
}

function stableErrorCode(error) {
  const code = String(error?.code ?? "").trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,119}$/.test(code) ? code : "CATEGORY_RESOLUTION_FAILED";
}

function failurePolicy(error) {
  const status = Number(error?.status);
  const numericStatus = Number.isInteger(status) ? status : 0;
  const code = stableErrorCode(error);
  const retryable = !NON_RETRYABLE_CATEGORY_CODES.has(code) && (
    RETRYABLE_TRANSPORT_CODES.has(code)
      || /^HTTP_(408|429|5\d\d)$/.test(code)
      || numericStatus === 408
      || numericStatus === 429
      || (numericStatus >= 500 && numericStatus < 600)
  );
  return {
    retryable,
    failureCode: code === "CATEGORY_RESOLUTION_FAILED" && numericStatus
      ? `HTTP_${numericStatus}`
      : code,
  };
}

function retryDelayMs(attemptCount) {
  const exponent = Math.max(0, Math.min(Number(attemptCount || 1) - 1, 30));
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** exponent));
}

function displayPathFor(tree, target) {
  function visit(node, inheritedDescriptionCategoryId = 0, labels = []) {
    if (!node || typeof node !== "object") return null;
    const descriptionCategoryId = positiveId(node.description_category_id ?? node.descriptionCategoryId)
      ?? inheritedDescriptionCategoryId;
    const typeId = positiveId(node.type_id ?? node.typeId);
    const label = String(
      node.category_name ?? node.categoryName ?? node.type_name ?? node.typeName ?? node.name ?? "",
    ).trim();
    const path = label ? [...labels, label] : labels;
    if (descriptionCategoryId === target.descriptionCategoryId && typeId === target.typeId) return path;
    for (const child of Array.isArray(node.children) ? node.children : []) {
      const found = visit(child, descriptionCategoryId, path);
      if (found) return found;
    }
    return null;
  }
  for (const root of Array.isArray(tree) ? tree : []) {
    const found = visit(root);
    if (found) return { zh: found };
  }
  return {};
}

function auditEvent(action, record = {}, overrides = {}) {
  const values = {
    action,
    accountId: record.accountId,
    collectItemId: record.collectItemId,
    taxonomyScope: record.taxonomyScope,
    sourceTypeId: record.sourceTypeId,
    targetDescriptionCategoryId: record.targetDescriptionCategoryId,
    targetTypeId: record.targetTypeId,
    credentialStoreId: record.credentialStoreId,
    taxonomyFingerprint: record.taxonomyFingerprint,
    attempt: record.attemptCount,
    failureCode: record.failureCode,
    ...overrides,
  };
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null && value !== undefined && value !== ""));
}

function resolutionIdentity(record = {}) {
  return {
    method: record.method ?? null,
    targetDescriptionCategoryId: record.targetDescriptionCategoryId ?? null,
    targetTypeId: record.targetTypeId ?? null,
    taxonomyFingerprint: record.taxonomyFingerprint ?? null,
    matchedAt: record.matchedAt ?? null,
  };
}

export function createCollectCategoryResolutionService({
  repository,
  categoryPort,
  collectItemPort,
  storePort,
  auditPort,
  now,
  randomUUID,
} = {}) {
  const repositoryMethods = [
    "enqueue",
    "readForItem",
    "claimNext",
    "completeMatched",
    "completeNeedsReview",
    "deferRetry",
    "invalidate",
    "saveManual",
    "requeueClaim",
    "validateMatched",
    "deferValidation",
  ];
  if (!repository || repositoryMethods.some((method) => typeof repository[method] !== "function")) {
    throw new TypeError("Collect category resolution repository contract required");
  }
  if (!categoryPort
    || typeof categoryPort.getCategorySnapshot !== "function"
    || typeof categoryPort.validateTarget !== "function") {
    throw new TypeError("Collect category resolution category port required");
  }
  if (!collectItemPort || typeof collectItemPort.read !== "function") {
    throw new TypeError("Collect category resolution collect item port required");
  }
  if (!storePort || typeof storePort.readCredentialStore !== "function") {
    throw new TypeError("Collect category resolution store port required");
  }
  if (!auditPort || typeof auditPort.prepare !== "function") {
    throw new TypeError("Collect category resolution audit port required");
  }
  if (typeof now !== "function" || typeof randomUUID !== "function") {
    throw new TypeError("Collect category resolution clock and UUID ports required");
  }

  function preparedAudit(action, record, overrides) {
    return auditPort.prepare(auditEvent(action, record, overrides));
  }

  async function readCollectItem(accountId, collectItemId) {
    const item = await collectItemPort.read({ accountId, collectItemId });
    if (!item || String(item.accountId ?? "") !== accountId || String(item.id ?? "") !== collectItemId) {
      throw serviceError(
        "Collect item is unavailable in this account",
        "COLLECT_CATEGORY_RESOLUTION_SCOPE",
        404,
      );
    }
    return item;
  }

  async function readStore(accountId, credentialStoreId) {
    const storeId = String(credentialStoreId ?? "").trim();
    if (!storeId) return { kind: "UNAVAILABLE", store: null };
    try {
      const store = await storePort.readCredentialStore({ accountId, storeId });
      return credentialStoreUsable(store, accountId, storeId)
        ? { kind: "AVAILABLE", store }
        : { kind: "UNAVAILABLE", store: null };
    } catch (error) {
      return { kind: "ERROR", error };
    }
  }

  async function enqueueForState({
    accountId,
    collectItemId,
    item,
    credentialStoreId,
    taxonomyScope = TAXONOMY_SCOPE_OZON_DEFAULT,
    taxonomyFingerprint = null,
    requestedStatus = null,
  }) {
    const at = instant(now());
    const sourceTypeId = sourceTypeIdOf(item);
    const storeResult = await readStore(accountId, credentialStoreId);
    const storeFailure = storeResult.kind === "ERROR" ? failurePolicy(storeResult.error) : null;
    const status = requestedStatus ?? (
      !enrichmentComplete(item)
        ? "WAITING_ENRICHMENT"
        : storeResult.kind === "AVAILABLE" || storeFailure?.retryable
          ? "QUEUED"
          : "WAITING_STORE"
    );
    const safeCredentialStoreId = storeResult.kind === "AVAILABLE"
      ? storeResult.store.id
      : storeFailure?.retryable
        ? String(credentialStoreId ?? "").trim() || null
        : null;
    const eventRecord = {
      accountId,
      collectItemId,
      taxonomyScope,
      sourceTypeId,
      taxonomyFingerprint,
      credentialStoreId: safeCredentialStoreId,
      attemptCount: 0,
      failureCode: storeFailure?.failureCode ?? null,
    };
    const audit = status === "QUEUED"
      ? preparedAudit("COLLECT_CATEGORY_RESOLUTION_QUEUED", eventRecord)
      : storeFailure
        ? preparedAudit("COLLECT_CATEGORY_RESOLUTION_NEEDS_REVIEW", eventRecord, {
          failureCode: storeFailure.failureCode,
        })
        : null;
    try {
      return await repository.enqueue({
        ...eventRecord,
        status,
        credentialStoreId: safeCredentialStoreId,
        nextAttemptAt: at,
        now: at,
        auditEvent: audit,
      });
    } catch (error) {
      if (error?.code !== "COLLECT_CATEGORY_RESOLUTION_CREDENTIAL_STORE_SCOPE") throw error;
      return repository.enqueue({
        ...eventRecord,
        status: enrichmentComplete(item) ? "WAITING_STORE" : "WAITING_ENRICHMENT",
        credentialStoreId: null,
        nextAttemptAt: at,
        now: at,
        auditEvent: preparedAudit("COLLECT_CATEGORY_RESOLUTION_NEEDS_REVIEW", eventRecord, {
          credentialStoreId: null,
          failureCode: "STORE_UNAVAILABLE",
        }),
      });
    }
  }

  async function scheduleForCollect(input = {}) {
    const accountId = requiredText(input.accountId, "accountId");
    const collectItemId = requiredText(input.collectItemId, "collectItemId");
    const taxonomyScope = String(input.taxonomyScope ?? TAXONOMY_SCOPE_OZON_DEFAULT).trim()
      || TAXONOMY_SCOPE_OZON_DEFAULT;
    const item = await readCollectItem(accountId, collectItemId);
    return enqueueForState({
      accountId,
      collectItemId,
      item,
      credentialStoreId: input.credentialStoreId,
      taxonomyScope,
      taxonomyFingerprint: input.taxonomyFingerprint ?? null,
    });
  }

  async function onEnrichmentComplete(input = {}) {
    const accountId = requiredText(input.accountId, "accountId");
    const collectItemId = requiredText(input.collectItemId, "collectItemId");
    const taxonomyScope = String(input.taxonomyScope ?? TAXONOMY_SCOPE_OZON_DEFAULT).trim()
      || TAXONOMY_SCOPE_OZON_DEFAULT;
    const current = await repository.readForItem({ accountId, collectItemId, taxonomyScope });
    const item = await readCollectItem(accountId, collectItemId);
    return enqueueForState({
      accountId,
      collectItemId,
      item,
      credentialStoreId: current?.credentialStoreId ?? input.credentialStoreId,
      taxonomyScope,
      taxonomyFingerprint: current?.taxonomyFingerprint ?? null,
    });
  }

  async function operatingStoreContext(input = {}) {
    const accountId = requiredText(input.accountId, "accountId");
    const storeId = requiredText(input.storeId, "storeId");
    const storeResult = await readStore(accountId, storeId);
    if (storeResult.kind === "ERROR") {
      const classified = failurePolicy(storeResult.error);
      throw serviceError(
        "Credential store availability check failed",
        classified.failureCode,
        classified.retryable ? 503 : 409,
      );
    }
    if (storeResult.kind !== "AVAILABLE") return null;
    return {
      id: storeResult.store.id,
      updatedAt: storeResult.store.updatedAt ?? storeResult.store.updated_at
        ?? storeResult.store.savedAt ?? storeResult.store.saved_at ?? null,
    };
  }

  async function onOperatingStoreAvailable(input = {}) {
    const accountId = requiredText(input.accountId, "accountId");
    const storeId = requiredText(input.storeId, "storeId");
    const store = await operatingStoreContext({ accountId, storeId });
    if (!store) return [];
    const candidates = typeof collectItemPort.listForCategoryResolution === "function"
      ? await collectItemPort.listForCategoryResolution({ accountId })
      : [];
    const results = [];
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      const collectItemId = String(candidate?.collectItemId ?? candidate?.id ?? "").trim();
      if (!collectItemId) continue;
      const taxonomyScope = String(candidate?.taxonomyScope ?? TAXONOMY_SCOPE_OZON_DEFAULT).trim()
        || TAXONOMY_SCOPE_OZON_DEFAULT;
      const current = await repository.readForItem({
        accountId,
        collectItemId,
        taxonomyScope,
      });
      if (current?.status === "WAITING_STORE") {
        results.push(await scheduleForCollect({ accountId, collectItemId, credentialStoreId: store.id, taxonomyScope }));
      } else if (current?.status === "MATCHED") {
        results.push(await validateForStore({ accountId, collectItemId, storeId: store.id, taxonomyScope }));
      }
    }
    return results;
  }

  async function requeueClaimed(claimed, {
    item,
    status,
    credentialStoreId,
    taxonomyFingerprint,
    failureCode = null,
  }) {
    const at = instant(now());
    const eventRecord = {
      ...claimed,
      sourceTypeId: sourceTypeIdOf(item),
      credentialStoreId,
      taxonomyFingerprint,
      failureCode,
    };
    return repository.requeueClaim({
      accountId: claimed.accountId,
      id: claimed.id,
      leaseToken: claimed.leaseToken,
      sourceTypeId: sourceTypeIdOf(item),
      credentialStoreId,
      taxonomyFingerprint,
      status,
      nextAttemptAt: at,
      now: at,
      auditEvent: preparedAudit(
        status === "QUEUED"
          ? "COLLECT_CATEGORY_RESOLUTION_QUEUED"
          : "COLLECT_CATEGORY_RESOLUTION_WAITING",
        eventRecord,
        { failureCode: failureCode ?? status },
      ),
    });
  }

  async function finishReview(claimed, failureCode) {
    const at = instant(now());
    const record = await repository.completeNeedsReview({
      accountId: claimed.accountId,
      id: claimed.id,
      leaseToken: claimed.leaseToken,
      failureCode,
      now: at,
      auditEvent: preparedAudit("COLLECT_CATEGORY_RESOLUTION_NEEDS_REVIEW", claimed, { failureCode }),
    });
    return record;
  }

  async function finishCategoryFailure(claimed, error) {
    const at = instant(now());
    const { retryable, failureCode } = failurePolicy(error);
    if (!retryable) return finishReview(claimed, failureCode);
    const nextAttemptAt = new Date(at.getTime() + retryDelayMs(claimed.attemptCount));
    const record = await repository.deferRetry({
      accountId: claimed.accountId,
      id: claimed.id,
      leaseToken: claimed.leaseToken,
      failureCode,
      nextAttemptAt,
      now: at,
      auditEvent: preparedAudit("COLLECT_CATEGORY_RESOLUTION_RETRY_DEFERRED", claimed, { failureCode }),
    });
    return record;
  }

  async function claimWithFingerprint(claimed, item, store, snapshot) {
    const fingerprint = String(snapshot.taxonomyFingerprint ?? "").trim();
    if (!fingerprint) {
      return { record: await finishCategoryFailure(
        claimed,
        { code: "OZON_CATEGORY_DATA_INVALID" },
      ) };
    }
    if (claimed.taxonomyFingerprint === fingerprint) return { claimed };

    if (claimed.taxonomyFingerprint) {
      const at = instant(now());
      const invalidated = await repository.invalidate({
        accountId: claimed.accountId,
        id: claimed.id,
        leaseToken: claimed.leaseToken,
        expectedResolution: resolutionIdentity(claimed),
        failureCode: "TAXONOMY_CHANGED",
        nextAttemptAt: at,
        now: at,
        auditEvent: preparedAudit("COLLECT_CATEGORY_RESOLUTION_INVALIDATED", claimed, {
          failureCode: "TAXONOMY_CHANGED",
          taxonomyFingerprint: fingerprint,
        }),
      });
      if (!invalidated) return { record: null };
      const queued = await repository.enqueue({
        accountId: claimed.accountId,
        collectItemId: claimed.collectItemId,
        taxonomyScope: claimed.taxonomyScope,
        sourceTypeId: sourceTypeIdOf(item),
        status: "QUEUED",
        taxonomyFingerprint: fingerprint,
        credentialStoreId: store.id,
        nextAttemptAt: at,
        now: at,
        auditEvent: preparedAudit("COLLECT_CATEGORY_RESOLUTION_QUEUED", invalidated, {
          taxonomyFingerprint: fingerprint,
          failureCode: null,
        }),
      });
      return { record: queued };
    }
    return { record: await requeueClaimed(claimed, {
      item,
      credentialStoreId: store.id,
      taxonomyFingerprint: fingerprint,
      status: "QUEUED",
    }) };
  }

  async function resolveNext(input = {}) {
    const accountId = requiredText(input.accountId, "accountId");
    const taxonomyScope = String(input.taxonomyScope ?? TAXONOMY_SCOPE_OZON_DEFAULT).trim()
      || TAXONOMY_SCOPE_OZON_DEFAULT;
    const claimAt = instant(now());
    let claimed = await repository.claimNext({
      accountId,
      taxonomyScope,
      leaseToken: randomUUID(),
      leaseExpiresAt: new Date(claimAt.getTime() + LEASE_MS),
      now: claimAt,
    });
    if (!claimed) return null;

    if (claimed.failureDetailSafe === VALIDATION_RETRY_PENDING
      && claimed.method
      && claimed.targetDescriptionCategoryId
      && claimed.targetTypeId) {
      const continuation = await validateResolutionForStore({
        accountId,
        collectItemId: claimed.collectItemId,
        storeId: claimed.credentialStoreId,
        taxonomyScope: claimed.taxonomyScope,
        resolution: claimed,
        leaseToken: claimed.leaseToken,
      });
      return continuation.resolution;
    }

    let item;
    try {
      item = await readCollectItem(accountId, claimed.collectItemId);
    } catch (error) {
      return finishCategoryFailure(claimed, error);
    }
    if (!enrichmentComplete(item)) {
      return requeueClaimed(claimed, {
        item,
        status: "WAITING_ENRICHMENT",
        credentialStoreId: claimed.credentialStoreId,
        taxonomyFingerprint: claimed.taxonomyFingerprint,
        failureCode: "WAITING_ENRICHMENT",
      });
    }
    const storeResult = await readStore(accountId, claimed.credentialStoreId);
    if (storeResult.kind === "ERROR") return finishCategoryFailure(claimed, storeResult.error);
    if (storeResult.kind !== "AVAILABLE") {
      return requeueClaimed(claimed, {
        item,
        status: "WAITING_STORE",
        credentialStoreId: null,
        taxonomyFingerprint: claimed.taxonomyFingerprint,
        failureCode: "STORE_UNAVAILABLE",
      });
    }
    const store = storeResult.store;
    if (claimed.sourceTypeId !== sourceTypeIdOf(item)) {
      return requeueClaimed(claimed, {
        item,
        status: "QUEUED",
        credentialStoreId: store.id,
        taxonomyFingerprint: claimed.taxonomyFingerprint,
      });
    }

    let snapshot;
    try {
      snapshot = await categoryPort.getCategorySnapshot({ accountId, store, language: "ZH_HANS" });
      if (!Array.isArray(snapshot?.items) || snapshot.items.length === 0) {
        throw { code: "OZON_CATEGORY_DATA_INVALID" };
      }
      if (snapshot.stale) throw { code: "OZON_CATEGORY_TAXONOMY_STALE" };
      if (String(snapshot.taxonomyScope ?? "") !== claimed.taxonomyScope) {
        throw { code: "TAXONOMY_SCOPE_MISMATCH" };
      }
    } catch (error) {
      return finishCategoryFailure(claimed, error);
    }

    const fingerprintClaim = await claimWithFingerprint(claimed, item, store, snapshot);
    if (Object.hasOwn(fingerprintClaim, "record")) return fingerprintClaim.record;
    claimed = fingerprintClaim.claimed;
    if (!claimed) return null;

    const match = resolveExactType({ tree: snapshot.items, sourceTypeId: sourceTypeIdOf(item) });
    if (match.kind !== "MATCHED") return finishReview(claimed, match.reasonCode);
    const at = instant(now());
    const record = await repository.completeMatched({
      accountId,
      id: claimed.id,
      leaseToken: claimed.leaseToken,
      targetDescriptionCategoryId: match.descriptionCategoryId,
      targetTypeId: match.typeId,
      method: "TYPE_ID_EXACT",
      taxonomyFingerprint: snapshot.taxonomyFingerprint,
      credentialStoreId: store.id,
      displayPath: displayPathFor(snapshot.items, match),
      matchedAt: at,
      validatedAt: at,
      now: at,
      auditEvent: preparedAudit("COLLECT_CATEGORY_RESOLUTION_MATCHED", claimed, {
        targetDescriptionCategoryId: match.descriptionCategoryId,
        targetTypeId: match.typeId,
        credentialStoreId: store.id,
        taxonomyFingerprint: snapshot.taxonomyFingerprint,
      }),
    });
    return record;
  }

  async function validateResolutionForStore({
    accountId,
    collectItemId,
    storeId,
    taxonomyScope,
    resolution,
    leaseToken = null,
  }) {
    async function persistValidationFailure(error, {
      transient = null,
      credentialStoreId = resolution.credentialStoreId,
    } = {}) {
      const classified = failurePolicy(error);
      const retryable = transient ?? classified.retryable;
      const failureCode = classified.failureCode;
      const at = instant(now());
      const attempt = leaseToken
        ? Number(resolution.attemptCount || 1)
        : Number(resolution.attemptCount || 0) + 1;
      const delay = retryable ? retryDelayMs(attempt) : RETRY_MAX_MS;
      const deferred = await repository.deferValidation({
        accountId,
        id: resolution.id,
        leaseToken,
        expectedResolution: resolutionIdentity(resolution),
        retryable,
        credentialStoreId,
        failureCode,
        nextAttemptAt: new Date(at.getTime() + delay),
        now: at,
        auditEvent: preparedAudit(
          retryable
            ? "COLLECT_CATEGORY_RESOLUTION_RETRY_DEFERRED"
            : "COLLECT_CATEGORY_RESOLUTION_NEEDS_REVIEW",
          resolution,
          { failureCode, credentialStoreId, attempt },
        ),
      });
      return { reused: false, deferred: retryable, resolution: deferred, failureCode };
    }

    const storeResult = await readStore(accountId, storeId);
    if (storeResult.kind === "ERROR") return persistValidationFailure(storeResult.error);
    if (storeResult.kind !== "AVAILABLE") {
      return persistValidationFailure({ code: "STORE_UNAVAILABLE" }, { transient: false });
    }
    const store = storeResult.store;

    let validation;
    try {
      validation = await categoryPort.validateTarget(
        { accountId, store, language: "ZH_HANS" },
        {
          descriptionCategoryId: resolution.targetDescriptionCategoryId,
          typeId: resolution.targetTypeId,
        },
      );
    } catch (error) {
      return persistValidationFailure(error, { credentialStoreId: store.id });
    }
    const nextFingerprint = String(validation?.taxonomyFingerprint ?? "").trim() || null;
    const reasonCode = stableErrorCode({ code: validation?.reasonCode || "TARGET_VALIDATION_FAILED" });
    if (validation?.valid !== true && TRANSIENT_VALIDATION_REASONS.has(reasonCode)) {
      return persistValidationFailure(
        { code: reasonCode, status: 503 },
        { transient: true, credentialStoreId: store.id },
      );
    }
    if (validation?.valid === true && (resolution.method === "MANUAL"
      || nextFingerprint === resolution.taxonomyFingerprint)) {
      if (!nextFingerprint) {
        return persistValidationFailure(
          { code: "TAXONOMY_FINGERPRINT_MISSING" },
          { transient: false, credentialStoreId: store.id },
        );
      }
      const at = instant(now());
      const validated = await repository.validateMatched({
        accountId,
        id: resolution.id,
        leaseToken,
        expectedResolution: resolutionIdentity(resolution),
        taxonomyFingerprint: nextFingerprint,
        credentialStoreId: store.id,
        validatedAt: validation.validatedAt ?? at,
        now: at,
        auditEvent: preparedAudit("COLLECT_CATEGORY_RESOLUTION_VALIDATED", resolution, {
          credentialStoreId: store.id,
          taxonomyFingerprint: nextFingerprint,
        }),
      });
      return { reused: true, resolution: validated, validation };
    }

    const failureCode = validation?.valid === true
      ? "TAXONOMY_CHANGED"
      : reasonCode;
    if (resolution.method === "MANUAL" && !VERIFIED_TARGET_INVALID_REASONS.has(failureCode)) {
      return persistValidationFailure(
        { code: failureCode },
        { transient: false, credentialStoreId: store.id },
      );
    }
    const at = instant(now());
    const invalidated = await repository.invalidate({
      accountId,
      id: resolution.id,
      leaseToken,
      expectedResolution: resolutionIdentity(resolution),
      failureCode,
      nextAttemptAt: at,
      now: at,
      auditEvent: preparedAudit("COLLECT_CATEGORY_RESOLUTION_INVALIDATED", resolution, {
        credentialStoreId: store.id,
        taxonomyFingerprint: nextFingerprint ?? resolution.taxonomyFingerprint,
        failureCode,
      }),
    });
    if (!invalidated) return { reused: false, resolution: null, failureCode };
    if (resolution.method === "MANUAL") {
      return { reused: false, resolution: invalidated, validation, failureCode };
    }
    const item = await readCollectItem(accountId, collectItemId);
    const queued = await repository.enqueue({
      accountId,
      collectItemId,
      sourceTypeId: sourceTypeIdOf(item),
      status: "QUEUED",
      credentialStoreId: store.id,
      taxonomyScope,
      taxonomyFingerprint: nextFingerprint ?? resolution.taxonomyFingerprint,
      nextAttemptAt: at,
      now: at,
      auditEvent: preparedAudit("COLLECT_CATEGORY_RESOLUTION_QUEUED", invalidated, {
        credentialStoreId: store.id,
        taxonomyFingerprint: nextFingerprint ?? resolution.taxonomyFingerprint,
        failureCode: null,
      }),
    });
    return { reused: false, resolution: queued, validation, failureCode };
  }

  async function validateForStore(input = {}) {
    const accountId = requiredText(input.accountId, "accountId");
    const collectItemId = requiredText(input.collectItemId, "collectItemId");
    const storeId = requiredText(input.storeId, "storeId");
    const taxonomyScope = String(input.taxonomyScope ?? TAXONOMY_SCOPE_OZON_DEFAULT).trim()
      || TAXONOMY_SCOPE_OZON_DEFAULT;
    const resolution = await repository.readForItem({ accountId, collectItemId, taxonomyScope });
    if (!resolution || resolution.status !== "MATCHED") return { reused: false, resolution };
    return validateResolutionForStore({
      accountId,
      collectItemId,
      storeId,
      taxonomyScope,
      resolution,
    });
  }

  async function saveManual(input = {}) {
    const accountId = requiredText(input.accountId, "accountId");
    const collectItemId = requiredText(input.collectItemId, "collectItemId");
    const credentialStoreId = requiredText(input.credentialStoreId, "credentialStoreId");
    const item = await readCollectItem(accountId, collectItemId);
    const storeResult = await readStore(accountId, credentialStoreId);
    if (storeResult.kind !== "AVAILABLE") {
      throw serviceError(
        "Credential store is unavailable in this account",
        "COLLECT_CATEGORY_RESOLUTION_CREDENTIAL_STORE_UNAVAILABLE",
        409,
      );
    }
    const store = storeResult.store;
    const at = instant(now());
    return repository.saveManual({
      accountId,
      collectItemId,
      taxonomyScope: String(input.taxonomyScope ?? TAXONOMY_SCOPE_OZON_DEFAULT).trim()
        || TAXONOMY_SCOPE_OZON_DEFAULT,
      sourceTypeId: sourceTypeIdOf(item),
      targetDescriptionCategoryId: input.targetDescriptionCategoryId,
      targetTypeId: input.targetTypeId,
      taxonomyFingerprint: input.taxonomyFingerprint,
      credentialStoreId: store.id,
      displayPath: input.displayPath,
      matchedAt: at,
      validatedAt: input.validatedAt ?? at,
      now: at,
      auditEvent: preparedAudit("COLLECT_CATEGORY_RESOLUTION_MANUAL_SAVED", {
        accountId,
        collectItemId,
        taxonomyScope: String(input.taxonomyScope ?? TAXONOMY_SCOPE_OZON_DEFAULT).trim()
          || TAXONOMY_SCOPE_OZON_DEFAULT,
        sourceTypeId: sourceTypeIdOf(item),
        targetDescriptionCategoryId: input.targetDescriptionCategoryId,
        targetTypeId: input.targetTypeId,
        taxonomyFingerprint: input.taxonomyFingerprint,
        credentialStoreId: store.id,
        attemptCount: 0,
      }),
    });
  }

  return Object.freeze({
    scheduleForCollect,
    onEnrichmentComplete,
    onOperatingStoreAvailable,
    operatingStoreContext,
    resolveNext,
    validateForStore,
    saveManual,
  });
}
