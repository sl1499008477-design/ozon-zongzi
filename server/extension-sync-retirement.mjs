const RETIRED_EXTENSION_SYNC_ROUTES = Object.freeze([
  ["PUT", /^\/auth\/device\/heartbeat$/],
  ["GET", /^\/ozon\/sync\/client-intervals$/],
  ["GET", /^\/ozon\/stores\/[^/]+\/sync-credentials$/],
  ["POST", /^\/ozon\/sync\/lease\/(?:acquire|heartbeat|release)$/],
  ["POST", /^\/ozon\/sync\/client-report$/],
  ["POST", /^\/ozon\/cache\/import-with-hash$/],
  ["POST", /^\/ozon\/postings\/cache\/import$/],
  ["POST", /^\/ozon\/warehouses\/cache\/import$/],
]);

const REMOVED_RESPONSE = Object.freeze({
  ok: false,
  code: "EXTENSION_SYNC_REMOVED",
  message: "插件同步已移除，请更新插件并在 Web 端执行同步",
});

export function handleRetiredExtensionSyncRoute(req, res, url, { sendJson }) {
  const matched = RETIRED_EXTENSION_SYNC_ROUTES.some(
    ([method, pattern]) => method === req.method && pattern.test(url.pathname),
  );
  if (!matched) return false;
  sendJson(res, 410, REMOVED_RESPONSE);
  return true;
}
