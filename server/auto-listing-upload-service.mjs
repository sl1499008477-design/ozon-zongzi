import crypto from "node:crypto";

import { buildAutoListingSubmissionDraft } from "./auto-listing-overlay.mjs";
import { isVerifiedAutoListingOzonRichContentVersion } from "./auto-listing-ozon-rich-content.mjs";
import { assertPermission, PERMISSIONS } from "./permissions.mjs";
import { assertListingStockSelectionEligible } from "./listing-warehouse-eligibility.mjs";

const REQUEST_KEYS = new Set(["actor", "itemId", "expectedStatusVersion", "correlationId"]);
const HASH = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const TERMINAL_LINK_STATUSES = new Set(["SUBMITTED", "RECONCILING", "SUCCEEDED"]);

function uploadError(code, status = 422, retryable = false) {
  const error = new Error("自动上架暂时无法提交");
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  return error;
}

function id(value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(result)) throw uploadError("AUTO_LISTING_UPLOAD_INVALID");
  return result;
}

function exactInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Reflect.ownKeys(value).length !== REQUEST_KEYS.size
    || !Reflect.ownKeys(value).every((key) => typeof key === "string" && REQUEST_KEYS.has(key))) {
    throw uploadError("AUTO_LISTING_UPLOAD_INVALID");
  }
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");

function actionFor(context, expectedStatusVersion) {
  const item = context?.item;
  const queued = item?.status === "UPLOAD_QUEUED" && item.statusVersion === expectedStatusVersion;
  const recovering = item?.status === "UPLOADING" && item.statusVersion === expectedStatusVersion + 1;
  if (!queued && !recovering) {
    if (!item || ![expectedStatusVersion, expectedStatusVersion + 1].includes(item.statusVersion)) {
      throw uploadError("AUTO_LISTING_UPLOAD_CONFLICT", 409);
    }
    throw uploadError("AUTO_LISTING_UPLOAD_STATE_INVALID", 409);
  }
  if (context?.uploadPolicy?.mode === "REVIEW") return "REVIEW_APPROVE";
  if (context?.uploadPolicy?.mode === "DIRECT") return "DIRECT_UPLOAD";
  throw uploadError("AUTO_LISTING_UPLOAD_POLICY_BLOCKED", 409);
}

function assertFrozenEvidence(context, accountId, itemId, action) {
  const { item, listingBase, frozenConfig, uploadPolicy, store, productDraft } = context || {};
  if (item?.accountId !== accountId || item?.id !== itemId || !SAFE_ID.test(item.jobId || "")
    || listingBase?.accountId !== accountId || listingBase?.jobId !== item.jobId || listingBase?.itemId !== itemId
    || listingBase?.targetStoreId !== item.targetStoreId || listingBase?.sourceSnapshotId !== item.sourceSnapshotId
    || frozenConfig?.config?.targetStoreId !== item.targetStoreId
    || frozenConfig?.config?.targetWarehouseId !== item.targetWarehouseId
    || !SAFE_ID.test(context.targetWarehousePlatformId || "")
    || context.visualGroups?.planId !== item.activePlanId
    || context.visualGroups?.accountId !== accountId || context.visualGroups?.itemId !== itemId
    || store?.id !== item.targetStoreId || store?.ownerAccountId !== accountId || store?.credentialsUsable !== true
    || productDraft?.id !== listingBase?.productDraft?.id
    || productDraft?.version !== listingBase?.productDraft?.version
    || productDraft?.dataHash !== listingBase?.productDraft?.dataHash
    || !SAFE_ID.test(context.listingBaseId || "")
    || !HASH.test(context.sourceHash || "") || !HASH.test(listingBase?.canonicalHash || "")) {
    throw uploadError("AUTO_LISTING_UPLOAD_EVIDENCE_CHANGED", 409);
  }
  if (!uploadPolicy?.id || uploadPolicy.accountId !== accountId
    || !Number.isSafeInteger(uploadPolicy.version) || uploadPolicy.version < 1
    || uploadPolicy.publishedBy !== accountId || !uploadPolicy.publishedAt
    || !Number.isFinite(Date.parse(uploadPolicy.publishedAt))
    || uploadPolicy.enabled !== true
    || !uploadPolicy.publicationPolicy || uploadPolicy.publicationPolicyHash !== digest(uploadPolicy.publicationPolicy)
    || (action === "REVIEW_APPROVE" && uploadPolicy.mode !== "REVIEW")
    || (action === "DIRECT_UPLOAD" && uploadPolicy.mode !== "DIRECT")) {
    throw uploadError("AUTO_LISTING_UPLOAD_POLICY_BLOCKED", 409);
  }
  if (!context.collectItem || context.collectItem.id !== listingBase.collectItemId
    || context.collectItem.accountId !== accountId) throw uploadError("AUTO_LISTING_UPLOAD_SOURCE_CHANGED", 409);
}

function publicationConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw uploadError("AUTO_LISTING_UPLOAD_PUBLICATION_POLICY_CHANGED", 409);
  const policy = {
    origin: String(value.origin || ""),
    baseUrl: String(value.baseUrl || ""),
    prefix: String(value.prefix || ""),
    publicationVersion: String(value.publicationVersion || ""),
  };
  let parsed;
  try { parsed = new URL(policy.baseUrl); } catch { throw uploadError("AUTO_LISTING_UPLOAD_PUBLICATION_POLICY_CHANGED", 409); }
  if (parsed.origin !== policy.origin || !policy.baseUrl.endsWith("/")
    || !/^[A-Za-z0-9][A-Za-z0-9/_-]{0,159}$/u.test(policy.prefix)
    || !/^[A-Z0-9][A-Z0-9_-]{0,63}$/u.test(policy.publicationVersion)) {
    throw uploadError("AUTO_LISTING_UPLOAD_PUBLICATION_POLICY_CHANGED", 409);
  }
  return policy;
}

function richPublicationOrigin(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Reflect.ownKeys(value).length !== 1 || !Object.hasOwn(value, "origin")) {
    throw uploadError("AUTO_LISTING_UPLOAD_PUBLICATION_POLICY_CHANGED", 409);
  }
  try { return new URL(String(value.origin || "")).origin; } catch {
    throw uploadError("AUTO_LISTING_UPLOAD_PUBLICATION_POLICY_CHANGED", 409);
  }
}

function mediaEvidenceHash({ visualGroups, assets, rich, publicationPolicy }) {
  return digest({
    visualGroups,
    assets: assets.map((asset) => ({ assetId: asset.assetId, accountId: asset.accountId, jobId: asset.jobId,
      itemId: asset.itemId, planId: asset.planId, visualGroupKey: asset.visualGroupKey, slotKey: asset.slotKey,
      role: asset.role, status: asset.status, contentHash: asset.contentHash, width: asset.width, height: asset.height,
      publishedUrl: asset.publishedUrl, publicationVersion: asset.publicationVersion })),
    rich: rich.map((entry) => ({ accountId: entry.accountId, jobId: entry.jobId, itemId: entry.itemId,
      planId: entry.planId, visualGroupKey: entry.visualGroupKey, status: entry.status, outputHash: entry.outputHash })),
    publicationPolicy,
  });
}

function submissionIds(value) {
  const job = value?.job;
  const submissionJobId = typeof job?.id === "string" ? job.id.trim() : "";
  const submissionSnapshotId = typeof job?.snapshotId === "string" ? job.snapshotId.trim() : "";
  if (!SAFE_ID.test(submissionJobId) || !SAFE_ID.test(submissionSnapshotId)) return null;
  return { submissionJobId, submissionSnapshotId, status: String(job.status || "") };
}

function safeResult(itemId, link, duplicate) {
  return Object.freeze({
    itemId,
    status: link.status,
    submissionJobId: link.submissionJobId,
    submissionSnapshotId: link.submissionSnapshotId,
    duplicate: Boolean(duplicate),
  });
}

function safeErrorCode(error) {
  const code = typeof error?.code === "string" ? error.code.trim().toUpperCase() : "";
  return /^[A-Z][A-Z0-9_]{0,119}$/u.test(code) ? code : "AUTO_LISTING_UPLOAD_FAILED";
}

/** Single boundary that may enqueue a durable listing, but can never call Ozon directly. */
export function createAutoListingUploadService({
  repository,
  publishListingAsset,
  createSubmission,
  findSubmission,
  assertDirectSystemReady,
  assertDirectReady,
  buildSubmissionDraft = buildAutoListingSubmissionDraft,
  assertWarehouseEligible = assertListingStockSelectionEligible,
  uploadEnabled = false,
  listingPipelineEnabled = false,
  directUploadAllowed = false,
  publicationPolicy,
  richContentPublicationPolicy,
} = {}) {
  if (![repository?.loadUploadEvidence, repository?.reserveSubmission, repository?.bindSubmission,
    repository?.recordAttempt, repository?.blockSubmission, repository?.releaseSubmissionForRetry,
    publishListingAsset, createSubmission, assertDirectSystemReady, assertDirectReady,
    findSubmission, buildSubmissionDraft, assertWarehouseEligible].every((value) => typeof value === "function")
    || !richContentPublicationPolicy) {
    throw new TypeError("Auto-listing upload dependencies are required");
  }

  return Object.freeze({
    async submitAutoListingItem(raw = {}) {
      const { actor, itemId: rawItemId, expectedStatusVersion, correlationId: rawCorrelationId } = exactInput(raw);
      assertPermission(actor, PERMISSIONS.TENANT_OPERATE);
      if (!uploadEnabled || !listingPipelineEnabled) throw uploadError("AUTO_LISTING_UPLOAD_DISABLED", 503);
      const accountId = id(actor.id);
      const itemId = id(rawItemId);
      const correlationId = id(rawCorrelationId);
      if (!Number.isSafeInteger(expectedStatusVersion) || expectedStatusVersion < 1) {
        throw uploadError("AUTO_LISTING_UPLOAD_INVALID");
      }

      const context = await repository.loadUploadEvidence({ accountId, itemId });
      if (!context) throw uploadError("AUTO_LISTING_UPLOAD_NOT_FOUND", 404);
      const action = actionFor(context, expectedStatusVersion);
      if (action === "DIRECT_UPLOAD" && directUploadAllowed !== true) {
        throw uploadError("AUTO_LISTING_DIRECT_UPLOAD_BLOCKED", 503);
      }
      assertFrozenEvidence(context, accountId, itemId, action);
      let directHealthEvidenceId = null;
      if (action === "DIRECT_UPLOAD") {
        let systemReadiness;
        try { systemReadiness = await assertDirectSystemReady({ accountId }); } catch {
          throw uploadError("AUTO_LISTING_DIRECT_UPLOAD_BLOCKED", 503, true);
        }
        if (systemReadiness?.ready !== true) {
          throw uploadError("AUTO_LISTING_DIRECT_UPLOAD_BLOCKED", 503, true);
        }
        let readiness;
        try { readiness = await assertDirectReady({ accountId }); } catch {
          throw uploadError("AUTO_LISTING_DIRECT_UPLOAD_BLOCKED", 503, true);
        }
        if (readiness?.ready !== true || !SAFE_ID.test(readiness.evidenceId || "")) {
          throw uploadError("AUTO_LISTING_DIRECT_UPLOAD_BLOCKED", 503, true);
        }
        directHealthEvidenceId = readiness.evidenceId;
      }
      const configuredPublication = publicationConfig(publicationPolicy);
      const frozenPublication = publicationConfig(context.uploadPolicy.publicationPolicy);
      if (digest(configuredPublication) !== context.uploadPolicy.publicationPolicyHash
        || digest(configuredPublication) !== digest(frozenPublication)
        || richPublicationOrigin(richContentPublicationPolicy) !== frozenPublication.origin) {
        throw uploadError("AUTO_LISTING_UPLOAD_PUBLICATION_POLICY_CHANGED", 409);
      }
      assertWarehouseEligible({
        warehouses: context.warehouses,
        products: context.products,
        stocks: [{ warehouse_id: context.targetWarehousePlatformId, stock: context.frozenConfig.config.stock }],
        targetStoreId: context.item.targetStoreId,
        accountId,
      });

      let publicationOrigin;
      try { publicationOrigin = new URL(frozenPublication.origin).origin; } catch {
        throw uploadError("AUTO_LISTING_UPLOAD_EVIDENCE_INVALID", 422);
      }
      let preflightDraft;
      try {
        preflightDraft = buildSubmissionDraft({
          listingBase: context.listingBase,
          visualGroups: context.visualGroups,
          acceptedAssets: (context.acceptedAssets || []).map((asset) => ({
            ...asset,
            publishedUrl: `${publicationOrigin}/auto-listing-preflight/${asset.assetId}.jpg`,
            publicationVersion: frozenPublication.publicationVersion,
          })),
          acceptedRichContent: context.acceptedRichContent,
          frozenConfig: context.frozenConfig,
          targetWarehousePlatformId: context.targetWarehousePlatformId,
          publicationPolicy: { origin: frozenPublication.origin },
        });
      } catch {
        throw uploadError("AUTO_LISTING_UPLOAD_EVIDENCE_INVALID", 422);
      }
      if (action === "DIRECT_UPLOAD"
        && !isVerifiedAutoListingOzonRichContentVersion(preflightDraft.versions.richContentRuleVersion)) {
        throw uploadError("AUTO_LISTING_DIRECT_RICH_CONTENT_UNVERIFIED", 503);
      }

      const publishedAssets = [];
      for (const asset of context.acceptedAssets || []) {
        const published = await publishListingAsset({ actor, itemId, assetId: asset.assetId });
        publishedAssets.push({
          assetId: published.assetId,
          status: published.status,
          accountId: published.accountId,
          jobId: published.jobId,
          itemId: published.itemId,
          planId: published.planId,
          visualGroupKey: published.visualGroupKey,
          slotKey: published.slotKey,
          role: published.role,
          publishedUrl: published.publishedUrl,
          contentHash: published.contentHash,
          width: published.width,
          height: published.height,
          publicationVersion: published.publicationVersion,
        });
      }
      let draft;
      try {
        draft = buildSubmissionDraft({
          listingBase: context.listingBase,
          visualGroups: context.visualGroups,
          acceptedAssets: publishedAssets,
          acceptedRichContent: context.acceptedRichContent,
          frozenConfig: context.frozenConfig,
          targetWarehousePlatformId: context.targetWarehousePlatformId,
          publicationPolicy: { origin: frozenPublication.origin },
        });
      } catch {
        throw uploadError("AUTO_LISTING_UPLOAD_EVIDENCE_INVALID", 422);
      }
      const requestHash = digest({ accountId, itemId, action,
        listingBaseHash: draft.listingBaseHash, planId: draft.planId, resultHash: draft.resultHash });
      const mediaHash = mediaEvidenceHash({ visualGroups: context.visualGroups, assets: publishedAssets,
        rich: context.acceptedRichContent, publicationPolicy: frozenPublication });
      const idempotencyKey = `auto-listing:${itemId}:${draft.resultHash}`;
      const reservation = await repository.reserveSubmission({
        accountId, itemId, expectedStatusVersion, action, correlationId,
        jobId: context.item.jobId, listingBaseId: context.listingBaseId,
        activePlanId: context.item.activePlanId, targetStoreId: context.item.targetStoreId,
        targetWarehouseId: context.item.targetWarehouseId,
        targetWarehousePlatformId: context.targetWarehousePlatformId,
        sourceHash: context.sourceHash, configHash: context.frozenConfig.configHash,
        requestHash, resultHash: draft.resultHash, uploadPolicyVersionId: context.uploadPolicy.id,
        publicationPolicy: frozenPublication,
        publicationPolicyHash: context.uploadPolicy.publicationPolicyHash,
        mediaEvidenceHash: mediaHash,
        directHealthEvidenceId,
        productDraft: context.productDraft, idempotencyKey,
      });
      if (TERMINAL_LINK_STATUSES.has(reservation?.status) && reservation.submissionJobId) {
        return safeResult(itemId, reservation, true);
      }
      if (["FAILED", "BLOCKED"].includes(reservation?.status)) {
        throw uploadError("AUTO_LISTING_UPLOAD_BLOCKED", 409);
      }
      if (reservation?.claimOwned !== true) {
        throw uploadError("AUTO_LISTING_UPLOAD_CLAIM_BUSY", 409, true);
      }

      let listing = await findSubmission({ accountId, idempotencyKey, collectItemId: context.collectItem.id,
        targetStoreId: context.item.targetStoreId });
      let duplicate = Boolean(listing);
      if (!listing) {
        try {
          listing = await createSubmission({
            accountId,
            collectItem: context.collectItem,
            targetStoreId: context.item.targetStoreId,
            idempotencyKey,
            normalizedItems: draft.items,
            stocks: draft.stocks,
            type: "AUTO_LISTING",
            frozenProductDraft: context.productDraft,
            versions: {
              categoryRuleVersion: draft.versions.categoryRuleVersion,
              dictionaryVersion: draft.versions.dictionaryVersion,
              richContentRuleVersion: draft.versions.richContentRuleVersion,
            },
          });
        } catch (caught) {
          listing = await findSubmission({ accountId, idempotencyKey, collectItemId: context.collectItem.id,
            targetStoreId: context.item.targetStoreId });
          if (!listing) {
            const code = safeErrorCode(caught);
            const failedAttempt = { accountId, jobId: context.item.jobId, itemId,
              submissionLinkId: reservation.id, actorAccountId: accountId, action, expectedStatusVersion,
              targetStoreId: context.item.targetStoreId, targetWarehouseId: context.item.targetWarehouseId,
              productDraftHash: context.productDraft.dataHash, requestHash, resultHash: draft.resultHash,
              directHealthEvidenceId,
              outcome: caught?.definitelyNotSubmitted === true ? "FAILED" : "BLOCKED", errorCode: code,
              errorSafe: caught?.definitelyNotSubmitted === true
                ? "标准上架任务尚未创建，可安全重试" : "标准上架任务暂时无法确认",
              correlationId, responseSummary: {} };
            if (caught?.definitelyNotSubmitted === true) {
              await repository.releaseSubmissionForRetry({ accountId, itemId, linkId: reservation.id,
                claimToken: reservation.claimToken, correlationId, attempt: failedAttempt });
              throw uploadError("AUTO_LISTING_UPLOAD_RETRYABLE", 503, true);
            }
            await repository.blockSubmission({ accountId, itemId, linkId: reservation.id,
              claimToken: reservation.claimToken, correlationId, errorCode: code, attempt: failedAttempt });
            throw uploadError("AUTO_LISTING_UPLOAD_BLOCKED", 409);
          }
          duplicate = true;
        }
      }
      const ids = submissionIds(listing);
      const successAttempt = (submission) => ({ accountId, jobId: context.item.jobId, itemId,
          submissionLinkId: reservation.id, actorAccountId: accountId, action, expectedStatusVersion,
          targetStoreId: context.item.targetStoreId, targetWarehouseId: context.item.targetWarehouseId,
          productDraftHash: context.productDraft.dataHash, requestHash, resultHash: draft.resultHash,
          directHealthEvidenceId,
          outcome: "SUCCEEDED", errorCode: null, errorSafe: null, correlationId,
          responseSummary: { submissionJobId: submission.submissionJobId,
            submissionSnapshotId: submission.submissionSnapshotId, status: submission.status } });
      const uncertainAttempt = { accountId, jobId: context.item.jobId, itemId,
        submissionLinkId: reservation.id, actorAccountId: accountId, action, expectedStatusVersion,
        targetStoreId: context.item.targetStoreId, targetWarehouseId: context.item.targetWarehouseId,
        productDraftHash: context.productDraft.dataHash, requestHash, resultHash: draft.resultHash,
        directHealthEvidenceId,
        outcome: "UNCERTAIN", errorCode: "AUTO_LISTING_UPLOAD_UNCERTAIN",
        errorSafe: "标准上架任务暂时无法确认", correlationId, responseSummary: {} };
      if (!ids) {
        await repository.blockSubmission({ accountId, itemId, linkId: reservation.id,
          claimToken: reservation.claimToken, correlationId,
          errorCode: "AUTO_LISTING_UPLOAD_UNCERTAIN", attempt: uncertainAttempt });
        throw uploadError("AUTO_LISTING_UPLOAD_BLOCKED", 409);
      }
      let bound;
      try {
        bound = await repository.bindSubmission({ accountId, itemId, linkId: reservation.id,
          claimToken: reservation.claimToken,
          submissionJobId: ids.submissionJobId, submissionSnapshotId: ids.submissionSnapshotId,
          attempt: successAttempt(ids) });
      } catch {
        const recovered = await findSubmission({ accountId, idempotencyKey,
          collectItemId: context.collectItem.id, targetStoreId: context.item.targetStoreId }).catch(() => null);
        const recoveredIds = submissionIds(recovered);
        if (!recoveredIds || recoveredIds.submissionJobId !== ids.submissionJobId
          || recoveredIds.submissionSnapshotId !== ids.submissionSnapshotId) {
          await repository.recordAttempt(uncertainAttempt).catch(() => {});
          throw uploadError("AUTO_LISTING_UPLOAD_UNCERTAIN", 503, true);
        }
        try {
          bound = await repository.bindSubmission({ accountId, itemId, linkId: reservation.id,
            claimToken: reservation.claimToken,
            submissionJobId: recoveredIds.submissionJobId, submissionSnapshotId: recoveredIds.submissionSnapshotId,
            attempt: successAttempt(recoveredIds) });
        } catch {
          await repository.recordAttempt(uncertainAttempt).catch(() => {});
          throw uploadError("AUTO_LISTING_UPLOAD_UNCERTAIN", 503, true);
        }
        duplicate = true;
      }
      return safeResult(itemId, bound, duplicate || Boolean(listing?.duplicate));
    },
  });
}
