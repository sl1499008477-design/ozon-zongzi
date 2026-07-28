/**
 * extension/background/sync/diff-index.js
 *
 * PRODUCTS contentHash 本地索引 — 用 chrome.storage.local 分片 blob 存储:
 *   key 格式: diff:{storeId}:PRODUCTS:{shard 00..ff}
 *   value:    { [productId]: "sha256 hex (64 char)" }
 *
 * 分片理由(codex review #5):50K 单 key 扫描会慢;每商品分到 256 片其中之一,
 * 一页 500 行最多触到 ~256 片(大概率 hit 几片重复),读写都批量。
 *
 * volatile 字段黑名单(codex review #6):用黑名单不用白名单,新 Ozon 字段
 * 默认进 hash 避免静默漂移。带 _at 后缀 / prices / stocks 走专门 sync。
 */

(() => {
  const SHARD_KEY_PREFIX = "diff:";
  const VOLATILE_TOP_KEYS = new Set([
    "updated_at",
    "created_at",
    "synced_at",
    "stocks",
    "prices",
    "price_indexes",
    "primary_image",
  ]);

  function shardOf(productId) {
    // 简易:productId 前 2 char 作分片,数字 id 取后 2 位也行。
    // SubtleCrypto 异步太重,选 cheap 算法即可,均匀性不严格。
    const s = String(productId);
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    const byte = (h >>> 0) & 0xff;
    return byte.toString(16).padStart(2, "0");
  }

  function shardKey(storeId, type, shard) {
    return `${SHARD_KEY_PREFIX}${storeId}:${type}:${shard}`;
  }

  function stripVolatile(raw) {
    if (!raw || typeof raw !== "object") return raw;
    const out = {};
    for (const k of Object.keys(raw)) {
      if (VOLATILE_TOP_KEYS.has(k)) continue;
      // 任何 *_at 时间戳字段
      if (k.endsWith("_at")) continue;
      out[k] = raw[k];
    }
    return out;
  }

  // 稳定 stringify — 对象按 key 排序,数组保持原序。避免 Ozon 偶尔字段顺序漂移
  // 导致 hash 误判变更。
  function stableStringify(value) {
    if (value === null || typeof value !== "object") {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return "[" + value.map(stableStringify).join(",") + "]";
    }
    const keys = Object.keys(value).sort();
    return (
      "{" +
      keys
        .map((k) => JSON.stringify(k) + ":" + stableStringify(value[k]))
        .join(",") +
      "}"
    );
  }

  async function sha256Hex(str) {
    const buf = new TextEncoder().encode(str);
    const hash = await crypto.subtle.digest("SHA-256", buf);
    const bytes = new Uint8Array(hash);
    let hex = "";
    for (const b of bytes) hex += b.toString(16).padStart(2, "0");
    return hex;
  }

  async function computeHash(raw) {
    const stripped = stripVolatile(raw);
    const str = stableStringify(stripped);
    return sha256Hex(str);
  }

  // 一次读多片(给定 productIds),返 Map<productId, hash | undefined>
  async function getHashes(storeId, type, productIds) {
    if (!productIds.length) return new Map();
    const shards = new Set(productIds.map(shardOf));
    const keys = [...shards].map((s) => shardKey(storeId, type, s));
    const data = await chrome.storage.local.get(keys);
    const out = new Map();
    for (const pid of productIds) {
      const k = shardKey(storeId, type, shardOf(pid));
      const blob = data[k] || {};
      out.set(pid, blob[pid]);
    }
    return out;
  }

  // 批量写 — 按分片归并后一次 set
  async function setHashes(storeId, type, entries) {
    // entries: Array<{ productId, hash }>
    if (!entries.length) return;
    const grouped = new Map(); // shard -> { productId: hash }
    for (const { productId, hash } of entries) {
      const s = shardOf(productId);
      if (!grouped.has(s)) grouped.set(s, {});
      grouped.get(s)[productId] = hash;
    }
    // 先读现有分片,merge 再写
    const keys = [...grouped.keys()].map((s) => shardKey(storeId, type, s));
    const existing = await chrome.storage.local.get(keys);
    const toSet = {};
    for (const [s, patch] of grouped) {
      const k = shardKey(storeId, type, s);
      toSet[k] = { ...(existing[k] || {}), ...patch };
    }
    await chrome.storage.local.set(toSet);
  }

  // 7 天清理:遍历所有分片,删掉"过去 30 天没出现"的 productId。
  // MVP 不实现(等灰度看实际配额再加),先 stub。
  async function gcOldEntries() {
    // TODO Phase 3 / 灰度后实现
    return { removed: 0 };
  }

  globalThis.JzDiffIndex = {
    computeHash,
    getHashes,
    setHashes,
    gcOldEntries,
    // 暴露便于测试
    _internals: { shardOf, stripVolatile, stableStringify },
  };
})();
