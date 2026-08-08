const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;

function finalizerError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function id(value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(result)) throw finalizerError("AUTO_LISTING_IMPORT_FINALIZER_INVALID");
  return result;
}

function safeImport(value, accountId) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.accountId !== accountId
    || !["QUEUED", "COLLECTING"].includes(value.status)
    || !Number.isInteger(value.statusVersion) || value.statusVersion < 1
    || !Number.isInteger(value.acceptedRows) || value.acceptedRows < 0
    || !Number.isInteger(value.readyRows) || value.readyRows < 0
    || !Number.isInteger(value.failedRows) || value.failedRows < 0) {
    throw finalizerError("AUTO_LISTING_IMPORT_FINALIZER_INVALID");
  }
  return { ...value, id: id(value.id) };
}

function jobLinks(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.sourceType !== "EXCEL_SKU" || !Array.isArray(value.items) || value.items.length < 1) {
    throw finalizerError("AUTO_LISTING_IMPORT_FINALIZER_INVALID");
  }
  return {
    jobId: id(value.jobId),
    itemLinks: value.items.map((item) => ({ rowId: id(item?.sourceRecordId), itemId: id(item?.itemId) })),
  };
}

function safeWarn(logger, payload) {
  try {
    const result = logger?.warn?.(payload);
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch { /* logging cannot alter finalization */ }
}

export function createAutoListingImportFinalizer({ repository, createExcelJob, logger = console } = {}) {
  if (typeof repository?.listFinalizableImports !== "function"
    || typeof repository?.finalizeWithJob !== "function"
    || typeof repository?.finalizeWithoutJob !== "function"
    || typeof createExcelJob !== "function") {
    throw new TypeError("Auto-listing import finalizer dependencies are required");
  }
  return Object.freeze({
    async finalizeAccount(input = {}) {
      const accountId = id(input.accountId);
      const limit = input.limit ?? 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw finalizerError("AUTO_LISTING_IMPORT_FINALIZER_INVALID");
      }
      const imports = await repository.listFinalizableImports({ accountId, limit });
      const totals = { inspected: 0, finalized: 0, failed: 0 };
      for (const raw of Array.isArray(imports) ? imports : []) {
        totals.inspected += 1;
        let current;
        try {
          current = safeImport(raw, accountId);
          if (current.acceptedRows === 0) {
            await repository.finalizeWithoutJob({
              accountId, importFileId: current.id, expectedStatusVersion: current.statusVersion,
            });
          } else {
            if (current.status !== "COLLECTING"
              || current.readyRows + current.failedRows !== current.acceptedRows || current.readyRows < 1) {
              throw finalizerError("AUTO_LISTING_IMPORT_FINALIZER_INVALID");
            }
            const job = jobLinks(await createExcelJob({
              actor: { id: accountId, role: "user" }, importFileId: current.id,
            }));
            if (job.itemLinks.length !== current.readyRows) {
              throw finalizerError("AUTO_LISTING_IMPORT_FINALIZER_INVALID");
            }
            await repository.finalizeWithJob({
              accountId, importFileId: current.id, expectedStatusVersion: current.statusVersion,
              jobId: job.jobId, itemLinks: job.itemLinks,
            });
          }
          totals.finalized += 1;
        } catch {
          totals.failed += 1;
          safeWarn(logger, {
            code: "AUTO_LISTING_IMPORT_FINALIZATION_FAILED",
            accountId,
            importFileId: current?.id || "invalid",
          });
        }
      }
      return Object.freeze(totals);
    },
  });
}
