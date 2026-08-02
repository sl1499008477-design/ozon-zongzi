import {
  TAXONOMY_SCOPE_OZON_DEFAULT,
  resolveExactType,
} from "./collect-category-resolution-policy.mjs";

const LEASE_MS = 2 * 60 * 1000;
const RETRY_BASE_MS = 30 * 1000;
const RETRY_MAX_MS = 30 * 60 * 1000;
const RETRYABLE_CODES = new Set([
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
  "OZON_CATEGORY_TAXONOMY_STALE",
  "OZON_CATEGORY_DATA_INVALID",
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
  const status = String(store.status ?? "ACTIVE").toUpperCase();
  if (!["ACTIVE", "ENABLED"].includes(status) || store.active === false || store.enabled === false) {
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

function retryableCode(code) {
  return RETRYABLE_CODES.has(code) || code === "HTTP_429" || /^HTTP_5\d\d$/.test(code);
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
    "releaseLease",
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
  if (!auditPort || typeof auditPort.append !== "function") {
    throw new TypeError("Collect category resolution audit port required");
  }
  if (typeof now !== "function" || typeof randomUUID !== "function") {
    throw new TypeError("Collect category resolution clock and UUID ports required");
  }

  async function writeAudit(event) {
    try {
      await auditPort.append(event);
    } catch {
      // Observability failure must not corrupt an already-persisted business transition.
    }
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

  async function readUsableStore(accountId, credentialStoreId) {
    const storeId = String(credentialStoreId ?? "").trim();
    if (!storeId) return null;
    let store;
    try {
      store = await storePort.readCredentialStore({ accountId, storeId });
    } catch {
      return null;
    }
    return credentialStoreUsable(store, accountId, storeId) ? store : null;
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
    const store = await readUsableStore(accountId, credentialStoreId);
    const status = requestedStatus
      ?? (!enrichmentComplete(item) ? "WAITING_ENRICHMENT" : store ? "QUEUED" : "WAITING_STORE");
    const current = await repository.readForItem({ accountId, collectItemId, taxonomyScope });
    const record = await repository.enqueue({
      accountId,
      collectItemId,
      taxonomyScope,
      sourceTypeId,
      status,
      taxonomyFingerprint,
      credentialStoreId: store?.id ?? null,
      nextAttemptAt: at,
      now: at,
    });
    if (record?.status === "QUEUED" && (
      current?.status !== "QUEUED"
      || current?.sourceTypeId !== record.sourceTypeId
      || current?.taxonomyFingerprint !== record.taxonomyFingerprint
      || current?.credentialStoreId !== record.credentialStoreId
    )) {
      await writeAudit(auditEvent("COLLECT_CATEGORY_RESOLUTION_QUEUED", record));
    }
    return record;
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

  async function onOperatingStoreAvailable(input = {}) {
    const accountId = requiredText(input.accountId, "accountId");
    const storeId = requiredText(input.storeId, "storeId");
    const store = await readUsableStore(accountId, storeId);
    if (!store) return [];
    const candidates = typeof collectItemPort.listForCategoryResolution === "function"
      ? await collectItemPort.listForCategoryResolution({ accountId })
      : [];
    const results = [];
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      const collectItemId = String(candidate?.collectItemId ?? candidate?.id ?? "").trim();
      if (!collectItemId) continue;
      const current = await repository.readForItem({
        accountId,
        collectItemId,
        taxonomyScope: TAXONOMY_SCOPE_OZON_DEFAULT,
      });
      if (current?.status === "WAITING_STORE") {
        results.push(await scheduleForCollect({ accountId, collectItemId, credentialStoreId: store.id }));
      } else if (current?.status === "MATCHED") {
        results.push(await validateForStore({ accountId, collectItemId, storeId: store.id }));
      }
    }
    return results;
  }

  async function releaseAndEnqueue(claimed, { item, status, credentialStoreId, taxonomyFingerprint }) {
    const at = instant(now());
    const released = await repository.releaseLease({
      accountId: claimed.accountId,
      id: claimed.id,
      leaseToken: claimed.leaseToken,
      now: at,
    });
    if (!released) return null;
    return enqueueForState({
      accountId: claimed.accountId,
      collectItemId: claimed.collectItemId,
      item,
      credentialStoreId,
      taxonomyScope: claimed.taxonomyScope,
      taxonomyFingerprint,
      requestedStatus: status,
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
    });
    if (record) {
      await writeAudit(auditEvent("COLLECT_CATEGORY_RESOLUTION_NEEDS_REVIEW", record, { failureCode }));
    }
    return record;
  }

  async function finishCategoryFailure(claimed, error) {
    const at = instant(now());
    const failureCode = stableErrorCode(error);
    if (!retryableCode(failureCode)) return finishReview(claimed, failureCode);
    const nextAttemptAt = new Date(at.getTime() + retryDelayMs(claimed.attemptCount));
    const record = await repository.deferRetry({
      accountId: claimed.accountId,
      id: claimed.id,
      leaseToken: claimed.leaseToken,
      failureCode,
      nextAttemptAt,
      now: at,
    });
    if (record) {
      await writeAudit(auditEvent("COLLECT_CATEGORY_RESOLUTION_RETRY_DEFERRED", record, { failureCode }));
    }
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
        failureCode: "TAXONOMY_CHANGED",
        nextAttemptAt: at,
        now: at,
      });
      if (!invalidated) return { record: null };
      await writeAudit(auditEvent("COLLECT_CATEGORY_RESOLUTION_INVALIDATED", invalidated, {
        failureCode: "TAXONOMY_CHANGED",
        taxonomyFingerprint: fingerprint,
      }));
    } else {
      const released = await repository.releaseLease({
        accountId: claimed.accountId,
        id: claimed.id,
        leaseToken: claimed.leaseToken,
        now: instant(now()),
      });
      if (!released) return { record: null };
    }

    const queued = await enqueueForState({
      accountId: claimed.accountId,
      collectItemId: claimed.collectItemId,
      item,
      credentialStoreId: store.id,
      taxonomyScope: claimed.taxonomyScope,
      taxonomyFingerprint: fingerprint,
      requestedStatus: "QUEUED",
    });
    if (queued?.status !== "QUEUED") return { record: queued };
    const claimAt = instant(now());
    const refreshed = await repository.claimNext({
      accountId: claimed.accountId,
      taxonomyScope: claimed.taxonomyScope,
      leaseToken: randomUUID(),
      leaseExpiresAt: new Date(claimAt.getTime() + LEASE_MS),
      now: claimAt,
    });
    if (refreshed && refreshed.id !== claimed.id) {
      await repository.releaseLease({
        accountId: refreshed.accountId,
        id: refreshed.id,
        leaseToken: refreshed.leaseToken,
        now: instant(now()),
      });
      return { record: queued };
    }
    return { claimed: refreshed };
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

    const item = await readCollectItem(accountId, claimed.collectItemId);
    if (!enrichmentComplete(item)) {
      return releaseAndEnqueue(claimed, {
        item,
        status: "WAITING_ENRICHMENT",
        credentialStoreId: claimed.credentialStoreId,
        taxonomyFingerprint: claimed.taxonomyFingerprint,
      });
    }
    const store = await readUsableStore(accountId, claimed.credentialStoreId);
    if (!store) {
      return releaseAndEnqueue(claimed, {
        item,
        status: "WAITING_STORE",
        credentialStoreId: null,
        taxonomyFingerprint: claimed.taxonomyFingerprint,
      });
    }
    if (claimed.sourceTypeId !== sourceTypeIdOf(item)) {
      const refreshed = await releaseAndEnqueue(claimed, {
        item,
        status: "QUEUED",
        credentialStoreId: store.id,
        taxonomyFingerprint: claimed.taxonomyFingerprint,
      });
      if (refreshed?.status !== "QUEUED") return refreshed;
      return resolveNext({ accountId, taxonomyScope });
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
    });
    if (record) await writeAudit(auditEvent("COLLECT_CATEGORY_RESOLUTION_MATCHED", record));
    return record;
  }

  async function validateForStore(input = {}) {
    const accountId = requiredText(input.accountId, "accountId");
    const collectItemId = requiredText(input.collectItemId, "collectItemId");
    const storeId = requiredText(input.storeId, "storeId");
    const taxonomyScope = String(input.taxonomyScope ?? TAXONOMY_SCOPE_OZON_DEFAULT).trim()
      || TAXONOMY_SCOPE_OZON_DEFAULT;
    const resolution = await repository.readForItem({ accountId, collectItemId, taxonomyScope });
    if (!resolution || resolution.status !== "MATCHED") return { reused: false, resolution };
    const store = await readUsableStore(accountId, storeId);
    if (!store) return { reused: false, resolution, failureCode: "WAITING_STORE" };

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
      return {
        reused: false,
        deferred: retryableCode(stableErrorCode(error)),
        resolution,
        failureCode: stableErrorCode(error),
      };
    }
    const nextFingerprint = String(validation?.taxonomyFingerprint ?? "").trim() || null;
    if (validation?.valid === true && nextFingerprint === resolution.taxonomyFingerprint) {
      await writeAudit(auditEvent("COLLECT_CATEGORY_RESOLUTION_VALIDATED", resolution, {
        credentialStoreId: store.id,
        taxonomyFingerprint: nextFingerprint,
      }));
      return { reused: true, resolution, validation };
    }

    const failureCode = validation?.valid === true
      ? "TAXONOMY_CHANGED"
      : stableErrorCode({ code: validation?.reasonCode || "TARGET_VALIDATION_FAILED" });
    const at = instant(now());
    const invalidated = await repository.invalidate({
      accountId,
      id: resolution.id,
      leaseToken: null,
      failureCode,
      nextAttemptAt: at,
      now: at,
    });
    if (!invalidated) return { reused: false, resolution: null, failureCode };
    await writeAudit(auditEvent("COLLECT_CATEGORY_RESOLUTION_INVALIDATED", invalidated, {
      credentialStoreId: store.id,
      taxonomyFingerprint: nextFingerprint ?? resolution.taxonomyFingerprint,
      failureCode,
    }));
    if (resolution.method === "MANUAL") {
      return { reused: false, resolution: invalidated, validation, failureCode };
    }
    const item = await readCollectItem(accountId, collectItemId);
    const queued = await enqueueForState({
      accountId,
      collectItemId,
      item,
      credentialStoreId: store.id,
      taxonomyScope,
      taxonomyFingerprint: nextFingerprint ?? resolution.taxonomyFingerprint,
      requestedStatus: "QUEUED",
    });
    return { reused: false, resolution: queued, validation, failureCode };
  }

  async function saveManual(input = {}) {
    const accountId = requiredText(input.accountId, "accountId");
    const collectItemId = requiredText(input.collectItemId, "collectItemId");
    const credentialStoreId = requiredText(input.credentialStoreId, "credentialStoreId");
    const item = await readCollectItem(accountId, collectItemId);
    const store = await readUsableStore(accountId, credentialStoreId);
    if (!store) {
      throw serviceError(
        "Credential store is unavailable in this account",
        "COLLECT_CATEGORY_RESOLUTION_CREDENTIAL_STORE_UNAVAILABLE",
        409,
      );
    }
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
    });
  }

  return Object.freeze({
    scheduleForCollect,
    onEnrichmentComplete,
    onOperatingStoreAvailable,
    resolveNext,
    validateForStore,
    saveManual,
  });
}
