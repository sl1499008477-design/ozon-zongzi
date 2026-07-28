import {
  createCollectorExport,
  listCollectorRunItems,
  updateCollectorExport,
} from "./collector-desktop-service.mjs";
import { buildCollectorExcelBuffer } from "./collector-excel-service.mjs";
import { putObjectFromBuffer } from "./object-storage.mjs";

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const COLLECTOR_EXPORT_LIMITS = Object.freeze({
  maxItems: 20_000,
  maxImagePixels: 40_000_000,
});

function positiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function exportError(message, code, status = 400, details = {}) {
  return Object.assign(new Error(message), { code, status, ...details });
}

function safeFileName(value, fallback = "sonli-collector.xlsx") {
  const normalized = String(value || fallback)
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 180) || fallback;
  return normalized.toLowerCase().endsWith(".xlsx") ? normalized : `${normalized}.xlsx`;
}

function safeObjectSegment(value, fallback) {
  return String(value || fallback)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || fallback;
}

async function loadSharp() {
  try {
    return (await import("sharp")).default;
  } catch (error) {
    throw Object.assign(new Error("服务端图片转换依赖 sharp 不可用", { cause: error }), {
      code: "COLLECTOR_SHARP_MISSING",
      status: 503,
    });
  }
}

async function defaultImageConverter(buffer, context = {}) {
  const sharp = await loadSharp();
  const maxImagePixels = positiveInteger(
    context.maxImagePixels,
    COLLECTOR_EXPORT_LIMITS.maxImagePixels,
    { min: 1, max: 100_000_000 },
  );
  try {
    const pipeline = sharp(buffer, {
      failOn: "warning",
      limitInputPixels: maxImagePixels,
      sequentialRead: true,
    });
    const metadata = await pipeline.metadata();
    const width = Number(metadata.width || 0);
    const height = Number(metadata.height || 0);
    if (!width || !height || width * height > maxImagePixels) {
      throw exportError(
        `图片像素超过 ${maxImagePixels} 上限`,
        "COLLECTOR_EXPORT_IMAGE_PIXEL_LIMIT",
        413,
        { maxImagePixels, width, height },
      );
    }
    return { buffer: await pipeline.png().toBuffer(), extension: "png" };
  } catch (error) {
    if (error?.code === "COLLECTOR_EXPORT_IMAGE_PIXEL_LIMIT") throw error;
    if (/pixel limit|exceeds.*pixels?/i.test(String(error?.message || ""))) {
      throw exportError(
        `图片像素超过 ${maxImagePixels} 上限`,
        "COLLECTOR_EXPORT_IMAGE_PIXEL_LIMIT",
        413,
        { maxImagePixels },
      );
    }
    throw error;
  }
}

async function listAllItems(service, { accountId, runId, statuses, maxItems }) {
  const items = [];
  const requestedStatuses = Array.isArray(statuses) && statuses.length ? statuses : ["QUALIFIED"];
  for (const status of requestedStatuses) {
    let offset = 0;
    while (true) {
      const page = await service.listCollectorRunItems({
        accountId,
        runId,
        status,
        limit: 5000,
        offset,
      });
      if (items.length + page.length > maxItems) {
        throw exportError(
          `导出条目超过 ${maxItems} 条上限，请缩小范围或分批导出`,
          "COLLECTOR_EXPORT_ITEM_LIMIT_EXCEEDED",
          413,
          { maxItems, observedItems: items.length + page.length },
        );
      }
      items.push(...page);
      if (page.length < 5000) break;
      offset += page.length;
    }
  }
  return items;
}

/**
 * Generates the recovered 63-column workbook and stores it in MinIO.
 * The export record is transitioned PENDING -> GENERATING -> READY/FAILED.
 */
export async function generateCollectorRunExcelExport({
  accountId,
  runId,
  fileName = "",
  statuses = ["QUALIFIED"],
  metadata = {},
} = {}, dependencies = {}) {
  const service = {
    createCollectorExport,
    listCollectorRunItems,
    updateCollectorExport,
    ...dependencies.service,
  };
  const buildExcel = dependencies.buildExcel || buildCollectorExcelBuffer;
  const putObject = dependencies.putObject || putObjectFromBuffer;
  const maxItems = positiveInteger(
    dependencies.maxExportItems,
    COLLECTOR_EXPORT_LIMITS.maxItems,
    { min: 1, max: 100_000 },
  );
  const maxImagePixels = positiveInteger(
    dependencies.maxImagePixels,
    COLLECTOR_EXPORT_LIMITS.maxImagePixels,
    { min: 1, max: 100_000_000 },
  );
  const normalizedFileName = safeFileName(fileName || `sonli-collector-${runId}`);
  let record = await service.createCollectorExport({
    accountId,
    runId,
    format: "xlsx",
    fileName: normalizedFileName,
    metadata: { ...metadata, statuses },
  });

  try {
    record = await service.updateCollectorExport({
      accountId,
      exportId: record.id,
      patch: { status: "GENERATING" },
    });
    const items = await listAllItems(service, { accountId, runId, statuses, maxItems });
    const imageErrors = [];
    const buffer = await buildExcel(items, {
      convertImage: dependencies.convertImage
        || ((imageBuffer, context) => defaultImageConverter(imageBuffer, { ...context, maxImagePixels })),
      downloadImage: dependencies.downloadImage,
      maxImageBytes: dependencies.maxImageBytes,
      maxDataUrlBytes: dependencies.maxDataUrlBytes,
      maxImageCacheBytes: dependencies.maxImageCacheBytes,
      imageTimeoutMs: dependencies.imageTimeoutMs,
      maxImageRedirects: dependencies.maxImageRedirects,
      onImageError: (error, context) => {
        imageErrors.push({
          code: String(error?.code || "COLLECTOR_EXPORT_IMAGE_FAILED"),
          message: String(error?.message || error).slice(0, 300),
          rowNumber: context?.rowNumber || 0,
          column: context?.column || 0,
          url: String(context?.url || "").slice(0, 1000),
        });
      },
    });
    const stored = await putObject({
      key: `collector/${safeObjectSegment(accountId, "account")}/${safeObjectSegment(runId, "run")}/${safeObjectSegment(record.id, "export")}-${normalizedFileName}`,
      name: normalizedFileName,
      contentType: XLSX_CONTENT_TYPE,
      buffer,
    });
    record = await service.updateCollectorExport({
      accountId,
      exportId: record.id,
      patch: {
        status: "READY",
        fileName: normalizedFileName,
        objectKey: stored.key,
        contentType: stored.contentType || XLSX_CONTENT_TYPE,
        size: stored.size,
        sha256: stored.sha256,
        itemCount: items.length,
        metadata: {
          ...metadata,
          statuses,
          bucket: stored.bucket,
          imageErrorCount: imageErrors.length,
          imageErrors: imageErrors.slice(0, 100),
          columnCount: 63,
          limits: { maxItems, maxImagePixels },
        },
      },
    });
    return { export: record, itemCount: items.length, imageErrors };
  } catch (error) {
    if (record?.id) {
      await service.updateCollectorExport({
        accountId,
        exportId: record.id,
        patch: {
          status: "FAILED",
          errorCode: String(error?.code || "COLLECTOR_EXPORT_FAILED").slice(0, 120),
          errorMessage: String(error?.message || error).slice(0, 2000),
        },
      }).catch(() => {});
    }
    error.exportId = record?.id || "";
    throw error;
  }
}

export { XLSX_CONTENT_TYPE };
