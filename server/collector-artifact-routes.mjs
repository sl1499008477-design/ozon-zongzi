import { getCollectorExportForAccount } from "./collector-desktop-service.mjs";
import { generateCollectorRunExcelExport } from "./collector-export-service.mjs";
import { addSelectedCollectorItemsToCollectBox } from "./collector-selection-service.mjs";
import { getObjectStream } from "./object-storage.mjs";

function disposition(name) {
  return `attachment; filename*=UTF-8''${encodeURIComponent(String(name || "sonli-collector.xlsx"))}`;
}

function objectSegment(value, fallback) {
  return String(value || fallback)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || fallback;
}

export async function handleCollectorArtifactRoute(req, res, url, options = {}) {
  const pathname = url?.pathname || new URL(req.url || "/", "http://localhost").pathname;
  const exportMatch = pathname.match(/^\/collector\/runs\/([^/]+)\/exports\/?$/);
  const selectionMatch = pathname.match(/^\/collector\/runs\/([^/]+)\/collect-box\/?$/);
  const downloadMatch = pathname.match(/^\/collector\/exports\/([^/]+)\/download\/?$/);
  if (!exportMatch && !selectionMatch && !downloadMatch) return false;
  // Let the general collector router serve the export history GET endpoint;
  // this handler owns only synchronous XLSX generation for POST.
  if (exportMatch && req.method !== "POST") return false;

  const authenticate = options.authenticate;
  const readBody = options.readBody;
  const sendJson = options.sendJson;
  const sendError = options.sendError;
  try {
    const account = await authenticate(req);
    if (exportMatch && req.method === "POST") {
      const body = await readBody(req);
      const result = await (options.generateExport || generateCollectorRunExcelExport)({
        accountId: account.id,
        runId: decodeURIComponent(exportMatch[1]),
        fileName: body.fileName || body.name || "",
        statuses: body.statuses || ["QUALIFIED"],
        metadata: body.metadata || {},
      });
      sendJson(res, 201, { ok: true, ...result });
      return true;
    }
    if (selectionMatch && req.method === "POST") {
      const body = await readBody(req);
      const result = await (options.addSelected || addSelectedCollectorItemsToCollectBox)({
        accountId: account.id,
        runId: decodeURIComponent(selectionMatch[1]),
        itemIds: body.itemIds || body.ids || [],
        sourceKeys: body.sourceKeys || [],
      });
      sendJson(res, result.ok ? 200 : 207, result);
      return true;
    }
    if (downloadMatch && req.method === "GET") {
      const record = await (options.getExport || getCollectorExportForAccount)(
        account.id,
        decodeURIComponent(downloadMatch[1]),
      );
      if (!record || record.status !== "READY" || !record.objectKey) {
        sendError(res, 404, "导出文件不存在或尚未生成", "COLLECTOR_EXPORT_NOT_READY");
        return true;
      }
      const expectedPrefix = `collector/${objectSegment(account.id, "account")}/${objectSegment(record.runId, "run")}/`;
      if (!String(record.objectKey).startsWith(expectedPrefix)) {
        sendError(res, 403, "导出对象不属于当前账号运行", "COLLECTOR_EXPORT_OBJECT_SCOPE_MISMATCH");
        return true;
      }
      const stream = await (options.getStream || getObjectStream)(record.objectKey);
      res.writeHead(200, {
        "Content-Type": record.contentType || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": disposition(record.fileName),
        ...(record.size ? { "Content-Length": String(record.size) } : {}),
        "Access-Control-Allow-Origin": "*",
      });
      for await (const chunk of stream) res.write(chunk);
      res.end();
      return true;
    }
    sendError(res, 405, "该采集资源接口不支持当前方法", "METHOD_NOT_ALLOWED");
  } catch (error) {
    sendError(res, error?.status || 500, error?.message || "采集资源处理失败", error?.code || "COLLECTOR_ARTIFACT_FAILED");
  }
  return true;
}
