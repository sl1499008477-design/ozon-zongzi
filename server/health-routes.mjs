import { readFile } from 'node:fs/promises';
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

export async function handleHealthRoute(req, res, url, dependencies) {
  if (req.method !== "GET" || !["/health", "/local/storage/health"].includes(url.pathname)) return false;
  const { sendJson, persistenceMode } = dependencies;
  if (url.pathname === "/health") {
    sendJson(res, 200, { ok: true, service: "ozon 粽子", version, persistence: persistenceMode() });
    return true;
  }
  const { dataFile, persistenceHealth, objectStorageHealth, objectStorageInfo, listingPipelineHealth, listingPipelineEnabled } = dependencies;
  const [database, storage, queue] = await Promise.allSettled([
    persistenceHealth({ dataFile }), objectStorageHealth(), listingPipelineHealth(),
  ]);
  const persistence = database.status === "fulfilled" ? database.value
    : { ok: false, mode: persistenceMode(), message: "数据存储健康检查失败" };
  const objectStorage = storage.status === "fulfilled" ? storage.value
    : { ok: false, ...objectStorageInfo(), message: "对象存储健康检查失败" };
  const listingPipeline = queue.status === "fulfilled" ? queue.value
    : { enabled: listingPipelineEnabled(), ok: false, message: "上架队列健康检查失败" };
  const ok = Boolean(persistence.ok && objectStorage.ok && (!listingPipeline.enabled || listingPipeline.ok !== false));
  sendJson(res, ok ? 200 : 503, {
    ok, persistence, objectStorage, listingPipeline,
    // A readiness probe must not hydrate every account merely to count cleanup work.
    objectCleanup: { pending: null },
  });
  return true;
}
