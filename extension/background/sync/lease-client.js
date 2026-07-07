/**
 * extension/background/sync/lease-client.js
 *
 * SyncLease 端的 acquire/heartbeat/release + 自动续期 timer。
 *
 * 抽出来独立文件原因(plan "扩展 关键文件清单" ⊕):
 *   - sync-engine 跑 PRODUCTS 长任务时,SW 在 fetch await 期间会被休眠,
 *     续期需要单独的轻量计时器机制
 *   - 一处管理 leaseId → expiresAt 状态,避免散落在 sync-engine 多处
 *
 * 通过 importScripts 加载,挂 globalThis.JzLeaseClient。
 * 依赖 globalThis.JzBackendClient(同 importScripts 顺序加载)。
 */

(() => {
  // 自动续期间隔:lease TTL 的 1/3,确保 lease 到期前至少 heartbeat 2 次。
  // chrome.alarms 最小粒度 30s,这里用 setTimeout(在 SW 活跃期间生效;
  // SW 休眠后下次 alarm 唤醒会重新调用 acquire/heartbeat 续期)。
  const HEARTBEAT_FRACTION = 1 / 3;

  // leaseKey (`${storeId}:${type}`) -> timer id
  const heartbeatTimers = new Map();

  function leaseKey(storeId, type) {
    return `${storeId}:${type}`;
  }

  /**
   * 抢 lease + 启动自动 heartbeat。返 null 表示别人持有(本轮跳过)。
   */
  async function acquire(storeId, type, deviceId, ttlSeconds) {
    const res = await globalThis.JzBackendClient.acquireLease({
      storeId,
      type,
      deviceId,
      ttlSeconds,
    });
    if (!res?.acquired) return null;
    startAutoHeartbeat(storeId, type, deviceId, res.leaseId, res.expiresAt);
    return { leaseId: res.leaseId, expiresAt: new Date(res.expiresAt) };
  }

  /**
   * 主动释放 + 清自动续期 timer。释放失败靠 backend TTL 兜底。
   */
  async function release(storeId, type, deviceId, leaseId) {
    stopAutoHeartbeat(storeId, type);
    try {
      await globalThis.JzBackendClient.releaseLease({ leaseId, deviceId });
    } catch {}
  }

  /**
   * 单次 heartbeat。**ttlSeconds 必传**:不传 backend 默认 5min,PRODUCTS 长 sync
   * (单轮 30+min)首次 heartbeat 后就被续短到 5min 中途丢锁(codex review #2)。
   * 通常 sync-engine 每页结束主动调一次"显式 heartbeat",防止 SW 休眠时 timer 没跑。
   */
  async function heartbeat(leaseId, deviceId, ttlSeconds) {
    if (!ttlSeconds || ttlSeconds < 60) {
      console.warn(
        `[JzLeaseClient] heartbeat called without ttlSeconds — backend will use 5min default, may drop long-running PRODUCTS lease`,
      );
    }
    try {
      const res = await globalThis.JzBackendClient.heartbeatLease({
        leaseId,
        deviceId,
        ttlSeconds,
      });
      return res;
    } catch {
      return { refreshed: false, expiresAt: null };
    }
  }

  // 跟 backend SYNC_LEASE_DEFAULT_TTL_SECONDS / sync-engine LEASE_TTL_SECONDS 对齐
  const TYPE_TTL_SECONDS = {
    PRODUCTS: 45 * 60,
    POSTINGS: 5 * 60,
    WAREHOUSES: 10 * 60,
  };

  function startAutoHeartbeat(
    storeId,
    type,
    deviceId,
    leaseId,
    expiresAtIso,
  ) {
    stopAutoHeartbeat(storeId, type);
    const expiresAt = new Date(expiresAtIso).getTime();
    const ttlMs = Math.max(60_000, expiresAt - Date.now());
    const interval = Math.floor(ttlMs * HEARTBEAT_FRACTION);
    const ttlSeconds = TYPE_TTL_SECONDS[type] ?? 5 * 60;
    const k = leaseKey(storeId, type);
    const timer = setInterval(async () => {
      // 每次自动续期都按类型 TTL 续(不传 → backend 默认 5min,PRODUCTS 会丢锁)
      const r = await heartbeat(leaseId, deviceId, ttlSeconds);
      // 续期失败(lease 被人抢/过期)→ 停 timer,sync-engine 下次 acquire 重抢
      if (!r?.refreshed) stopAutoHeartbeat(storeId, type);
    }, interval);
    heartbeatTimers.set(k, timer);
  }

  function stopAutoHeartbeat(storeId, type) {
    const k = leaseKey(storeId, type);
    const t = heartbeatTimers.get(k);
    if (t) {
      clearInterval(t);
      heartbeatTimers.delete(k);
    }
  }

  globalThis.JzLeaseClient = {
    acquire,
    heartbeat,
    release,
    _internal: { heartbeatTimers, leaseKey },
  };
})();
