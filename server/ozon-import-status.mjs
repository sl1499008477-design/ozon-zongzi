function normalizeStatus(value = "") {
  const status = String(value || "").toLowerCase();
  if (["imported", "success", "processed", "done", "complete", "completed", "finished"].includes(status)) return "SUCCEEDED";
  if (status === "skipped") return "SKIPPED";
  if (["failed", "error", "rejected", "cancelled", "canceled", "validation_error"].includes(status)) return "FAILED";
  if (["pending", "processing", "created", "queued", "running", "importing", "checking", "in_progress"].includes(status)) return "CHECKING";
  return status ? status.toUpperCase() : "CHECKING";
}

export function importInfoItems(data = {}) {
  const result = data?.result && typeof data.result === "object" ? data.result : {};
  if (Array.isArray(result.items)) return result.items;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(result.products)) return result.products;
  if (Array.isArray(data.products)) return data.products;
  return [];
}

function errorMessages(value, output = []) {
  if (!value || output.length >= 12) return output;
  if (typeof value === "string") {
    if (value.trim()) output.push(value.trim());
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) errorMessages(item, output);
    return output;
  }
  if (typeof value === "object") {
    const message = value.message || value.error || value.description || value.code;
    if (message) output.push(String(message));
    for (const key of ["errors", "reasons", "validation_errors", "details"]) {
      errorMessages(value[key], output);
    }
  }
  return output;
}

export function deriveOzonImportStatus(data = {}) {
  const result = data?.result && typeof data.result === "object" ? data.result : {};
  const items = importInfoItems(data);
  const rootErrors = errorMessages([data?.errors, data?.error, data?.message, result?.errors, result?.error]);
  if (items.length) {
    const normalizedItems = items.map((item, index) => {
      const status = normalizeStatus(item?.status || item?.state || item?.status_name);
      const errors = errorMessages([
        item?.errors,
        item?.error,
        item?.message,
        item?.validation_errors,
        item?.reasons,
        status === "FAILED" ? item?.status_description : "",
      ]);
      return {
        index,
        sku: String(item?.sku || ""),
        offerId: String(item?.offer_id || item?.offerId || ""),
        productId: String(item?.product_id || item?.productId || ""),
        status,
        errors,
        response: item,
      };
    });
    const failed = normalizedItems.filter((item) => item.status === "FAILED").length;
    const success = normalizedItems.filter((item) => item.status === "SUCCEEDED").length;
    const skipped = normalizedItems.filter((item) => item.status === "SKIPPED").length;
    const done = failed + success + skipped === normalizedItems.length;
    const status = !done
      ? "CHECKING"
      : failed
        ? (success || skipped ? "PARTIAL_SUCCESS" : "FAILED")
        : (success ? (skipped ? "PARTIAL_SUCCESS" : "SUCCEEDED") : "FAILED");
    return {
      status,
      done,
      failed,
      success,
      skipped,
      items: normalizedItems,
      errorMessage: failed ? [...rootErrors, ...normalizedItems.flatMap((item) => item.errors)].join("；") : "",
      statusMessage: skipped ? `Ozon 跳过了 ${skipped} 个变体` : "",
    };
  }
  const direct = normalizeStatus(result.status || result.state || data.status || data.state);
  return {
    status: direct,
    done: ["SUCCEEDED", "FAILED", "SKIPPED"].includes(direct),
    failed: direct === "FAILED" ? 1 : 0,
    success: direct === "SUCCEEDED" ? 1 : 0,
    skipped: direct === "SKIPPED" ? 1 : 0,
    items: [],
    errorMessage: direct === "FAILED" ? (rootErrors.join("；") || "Ozon 上架任务失败") : "",
    statusMessage: "",
  };
}
