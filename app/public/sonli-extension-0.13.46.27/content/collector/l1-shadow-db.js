// 极掌 L1 影子表 — composer-api 拦截数据的独立 IndexedDB 存储
//
// 目的:Phase 1 PoC,把 MAIN world fetch 拦截到的 BFF 响应单独存,**不进**
// 主 collector 的 'sales' 表。后续与 DOM 抓取并行采样,对比覆盖率/字段完整度。
// 验收通过后再决定是否合并到主缓存。
//
// 设计原则:
//   - 完全独立的 database 'jzL1Shadow' (与主 jzCollector 隔离)
//   - 用户即便清理主桶也不影响这里;反之亦然
//   - schema:samples 表(响应级 metadata)+ sku_samples 表(SKU 级字段存在性)
//
// v2 schema (Phase 1.5 增):
//   - sku_samples store: 每个响应里抽到的 SKU 一行,记录 fields=[]
//     (price/title/image/seller/sales/rating 各 probe 命中的字段集合)。
//     供 l1-diff.js 做 L1 vs L2 字段完整度对比 → 数据驱动 Phase 2 决策。
//
// API (挂在 window.JZL1ShadowDB):
//   init()                          — 打开 db
//   putSample({url, data, ts})      — 写入一条响应样本 + SKU 详情双写
//   countSamples()                  — 统计样本总数
//   getRecentSamples(limit=20)      — 拿最近 N 条(debug 用)
//   getSkuSamples({sinceTs?})       — 拿 sku_samples 行(diff 工具用)
//   countSkuSamples()               — SKU 行数
//   clearSamples()                  — 清空两个 store
//   pruneSamples(force?)            — 手动 prune(节流 60s)
//   stats()                         — 汇总指标 { total, byUrlPattern, lastTs }

(() => {
  if (window.JZL1ShadowDB && window.JZL1ShadowDB._v2) return;

  const DB_NAME = "jzL1Shadow";
  const DB_VERSION = 2;
  const STORE_SAMPLES = "samples";
  const STORE_SKU_SAMPLES = "sku_samples";

  let _db = null;
  let _initPromise = null;

  // ─── 遍历预算 ─────────────────────────────────────
  // estimateSkuCount 在 widget 树上递归,Ozon BFF 响应可能很大或被脚本故意构造
  // 成超大对象。无上限的 for-in 会卡 content script 主线程。
  // 预算选值依据:典型搜索响应 50KB-500KB,含 ~50 卡片 × 30 字段 ≈ 1500 节点。
  // 5000 节点足够覆盖正常 case,触顶时直接 return 当前统计 — skuCount 只用来
  // 估覆盖率,不当精确业务数据用,丢失尾部样本可接受。
  const WALK_MAX_NODES = 5000;
  const WALK_MAX_DEPTH = 30;
  const WALK_MAX_ARRAY_ITEMS = 200;
  const WALK_MAX_JSON_PARSE_ATTEMPTS = 50;
  // 响应体超过此大小直接跳过 skuCount 估算(返回 -1 标记 "skipped");
  // JSON.stringify 是 native 但巨型对象仍会耗时,且大概率不是正常 BFF 响应。
  const MAX_DATA_BYTES_FOR_SKU_ESTIMATE = 2_000_000;

  // ─── 保留策略 ─────────────────────────────────────
  // 两个 store 独立 retention(数量级不同):
  //   samples:     5000 行上限 + 14 天 TTL(每行 metadata ~200B,约 1MB)
  //   sku_samples: 50000 行上限 + 7 天 TTL(每行 ~80B,约 4MB;粒度更细易膨胀)
  // 检测时机:init() 一次性 + putSample 后 2% 概率(节流 60s)
  const SAMPLE_LIMIT = 5000;
  const SAMPLE_MAX_AGE_MS = 14 * 24 * 3600 * 1000;
  const SKU_SAMPLE_LIMIT = 50_000;
  const SKU_SAMPLE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
  const PRUNE_PROBABILITY = 0.02;
  const PRUNE_THROTTLE_MS = 60_000;
  let _lastPruneAt = 0;
  let _prunePending = false;

  // ─── 字段 probe ──────────────────────────────────
  // 用于 extractSkuDetails:遇到 SKU 节点时,检查兄弟字段命中哪些 probe。
  // 字段名是 L1 BFF / L2 DOM 都有的归一化语义(price/title/image/seller/sales/rating)。
  // 同语义的多种 key 用 OR — 命中任一即 probe 命中。
  // 顺序对应 l1-diff.js 输出列(保持稳定便于人眼对比)。
  const FIELD_PROBES = [
    { name: "price", keys: ["price", "cardPrice", "finalPrice", "mainPrice"] },
    { name: "title", keys: ["title", "name", "productName"] },
    { name: "image", keys: ["image", "mainImage", "images", "imageUrl"] },
    { name: "seller", keys: ["sellerName", "sellerId", "seller"] },
    { name: "sales", keys: ["sales", "salesCount", "soldCount", "ordersCount"] },
    { name: "rating", keys: ["rating", "reviewCount", "reviewsCount"] },
  ];

  function _open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        // v1 schema (samples store)— 老用户升级到 v2 时此 store 已存在直接复用
        if (!db.objectStoreNames.contains(STORE_SAMPLES)) {
          const store = db.createObjectStore(STORE_SAMPLES, {
            keyPath: "id",
            autoIncrement: true,
          });
          store.createIndex("ts", "ts", { unique: false });
          store.createIndex("urlPattern", "urlPattern", { unique: false });
        }
        // v2 新增 sku_samples store(Phase 1.5 — SKU 级字段存在性)
        if (!db.objectStoreNames.contains(STORE_SKU_SAMPLES)) {
          const store = db.createObjectStore(STORE_SKU_SAMPLES, {
            keyPath: "id",
            autoIncrement: true,
          });
          store.createIndex("sku", "sku", { unique: false });
          store.createIndex("ts", "ts", { unique: false });
          store.createIndex("urlPattern", "urlPattern", { unique: false });
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function init() {
    if (_db) return _db;
    if (!_initPromise) {
      _initPromise = _open().then((db) => {
        _db = db;
        // 一次性启动 prune:清掉超龄 + 超额样本(从上次会话残留)。
        // fire-and-forget,失败不影响 db 可用性。
        setTimeout(() => {
          pruneSamples(true).catch(() => {});
        }, 0);
        return db;
      });
    }
    return _initPromise;
  }

  // 把 URL 归一化成统计用的 pattern key,避免 query string 把统计粒度搞碎
  function urlToPattern(url) {
    if (!url || typeof url !== "string") return "unknown";
    try {
      const u = new URL(url, "https://www.ozon.ru/");
      const path = u.pathname;
      if (path.includes("/_action/getCatalog")) return "getCatalog";
      if (path.includes("/_action/getSimilarSearch")) return "getSimilarSearch";
      if (path.includes("/composer-api.bx/page/json/v2")) return "composer-page-json";
      if (path.includes("/entrypoint-api.bx/page/json/v2")) return "entrypoint-page-json";
      return path;
    } catch (e) {
      return "unknown";
    }
  }

  // 从 BFF widget 树里抽 SKU 详情:返回 [{sku, fields}] 数组。
  //   sku: 命中 sku/skuId/itemId/productSku 之一且为 ≥6 位纯数字
  //   fields: SKU 节点的兄弟字段在 FIELD_PROBES 命中的 probe 名集合
  // **有预算上限** — 触顶提前 return,丢失尾部样本可接受。
  // 返回 null 表示 "skipped"(响应过大,由调用方做 byteSize 检查后传 null)。
  // Phase 1 的 estimateSkuCount 等价于 extractSkuDetails(data).length。
  function extractSkuDetails(data) {
    if (!data || typeof data !== "object") return [];
    const seen = new Set();
    const records = [];
    const visited = new WeakSet();
    const budget = { nodes: 0, jsonParses: 0 };
    let truncated = false;

    function probeFields(node) {
      const hit = [];
      for (const probe of FIELD_PROBES) {
        for (const k of probe.keys) {
          const v = node[k];
          if (v != null && v !== "") {
            hit.push(probe.name);
            break;
          }
        }
      }
      return hit;
    }

    function walk(node, depth) {
      if (truncated) return;
      if (!node || typeof node !== "object" || visited.has(node)) return;
      if (depth > WALK_MAX_DEPTH) return;
      if (budget.nodes >= WALK_MAX_NODES) {
        truncated = true;
        return;
      }
      visited.add(node);
      budget.nodes += 1;

      if (Array.isArray(node)) {
        const len = Math.min(node.length, WALK_MAX_ARRAY_ITEMS);
        for (let i = 0; i < len; i += 1) {
          if (truncated) return;
          walk(node[i], depth + 1);
        }
        return;
      }

      // 检查当前 node 是否本身是个 SKU 记录(SKU key + 数字 value)
      let skuValue = null;
      for (const k of ["sku", "skuId", "itemId", "productSku"]) {
        if (k in node) {
          const v = node[k];
          if (typeof v === "string" || typeof v === "number") {
            const s = String(v);
            if (/^\d{6,}$/.test(s)) {
              skuValue = s;
              break;
            }
          }
        }
      }
      if (skuValue && !seen.has(skuValue)) {
        seen.add(skuValue);
        records.push({ sku: skuValue, fields: probeFields(node) });
      }

      // 递归子节点。注意:即使当前 node 是 SKU 记录,仍然要递归 — 子结构里可能
      // 嵌套子 SKU(variants / similar items)。
      for (const k in node) {
        if (truncated) return;
        if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
        const v = node[k];
        if (typeof v === "object") {
          walk(v, depth + 1);
        } else if (typeof v === "string") {
          // widgetStates 里 SKU 通常埋在 JSON-string-encoded payload。
          // 每个响应最多尝试 WALK_MAX_JSON_PARSE_ATTEMPTS 次 JSON.parse,
          // 防止深度嵌套 SKU 树触发 N² parse 风暴。
          if (
            v.length < 4096 &&
            v.indexOf('"sku"') > -1 &&
            budget.jsonParses < WALK_MAX_JSON_PARSE_ATTEMPTS
          ) {
            budget.jsonParses += 1;
            try {
              walk(JSON.parse(v), depth + 1);
            } catch (e) {}
          }
        }
      }
    }
    try {
      walk(data, 0);
    } catch (e) {}
    return records;
  }

  async function putSample({ url, data, ts, source }) {
    const db = await init();
    const urlPattern = urlToPattern(url);
    // 不存全量 data — 太大 + 隐私敏感。只存 schema 顶层 key 集合 + sku 抽样。
    // 顺序:先 byteSize → 决定是否做 SKU 抽取(大响应跳过避免 jank)。
    let topKeys = [];
    let byteSize = 0;
    try {
      topKeys = data && typeof data === "object" ? Object.keys(data).slice(0, 50) : [];
      // JSON.stringify 是 native 实现,正常响应(50KB-500KB)在 ms 级,可接受
      byteSize = JSON.stringify(data || null).length;
    } catch (e) {}
    // byteSize > 2MB 直接 skip 抽取(skuCount=-1,skuDetails=[]),避免递归 walk
    const skipSkuExtract = byteSize > MAX_DATA_BYTES_FOR_SKU_ESTIMATE;
    const skuDetails = skipSkuExtract ? [] : extractSkuDetails(data);
    const skuCount = skipSkuExtract ? -1 : skuDetails.length;
    const sampleTs = ts || Date.now();

    // step 1: 写 samples 表(响应级 metadata)
    const sampleId = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SAMPLES, "readwrite");
      const store = tx.objectStore(STORE_SAMPLES);
      const req = store.add({
        url,
        urlPattern,
        ts: sampleTs,
        source: source || "fetch",
        skuCount,
        topKeys,
        byteSize,
      });
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });

    // step 2: 写 sku_samples 表(每个 SKU 一行)。一个事务批量 add,失败静默 —
    // samples 表已经成功,sku_samples 是补充字段维度信息,缺了不影响 Phase 1 主链路。
    if (skuDetails.length > 0) {
      await new Promise((resolve) => {
        const tx = db.transaction(STORE_SKU_SAMPLES, "readwrite");
        const store = tx.objectStore(STORE_SKU_SAMPLES);
        for (const r of skuDetails) {
          try {
            store.add({
              sku: r.sku,
              fields: r.fields,
              urlPattern,
              ts: sampleTs,
              sampleId,
            });
          } catch (e) {}
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    }

    // 概率触发 prune — fire-and-forget,不阻塞写入返回。节流在 pruneSamples 内部。
    if (Math.random() < PRUNE_PROBABILITY) {
      pruneSamples().catch(() => {});
    }
    return sampleId;
  }

  // ─── 保留策略实现 ─────────────────────────────────
  // 两步清理:1) 按 ts 删超龄;2) count 后超过 limit 删最老的差额。
  // **永远不抛**,失败静默 — prune 是 best-effort,影子表写入路径优先。
  //
  // pruneOne 抽出来给 samples / sku_samples 共享 —— 两个 store 各自有不同
  // limit/maxAge,但游标/事务逻辑完全一致。
  async function pruneOne(db, storeName, limit, maxAgeMs, errorsOut) {
    const out = { deletedByAge: 0, deletedByLimit: 0 };
    const cutoffTs = Date.now() - maxAgeMs;

    // step 1: 按 ts 索引删 < cutoffTs 的
    await new Promise((resolve) => {
      const tx = db.transaction(storeName, "readwrite");
      const idx = tx.objectStore(storeName).index("ts");
      const range = IDBKeyRange.upperBound(cutoffTs);
      const req = idx.openCursor(range);
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (cur) {
          cur.delete();
          out.deletedByAge += 1;
          cur.continue();
        }
      };
      req.onerror = (e) => {
        errorsOut.push(
          `${storeName}-age: ${e.target.error && e.target.error.message}`
        );
      };
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => {
        errorsOut.push(
          `${storeName}-age-tx: ${e.target.error && e.target.error.message}`
        );
        resolve();
      };
    });

    // step 2: count + 删最老差额
    const remaining = await new Promise((resolve) => {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(0);
    });
    if (remaining > limit) {
      const toDelete = remaining - limit;
      await new Promise((resolve) => {
        const tx = db.transaction(storeName, "readwrite");
        const idx = tx.objectStore(storeName).index("ts");
        const req = idx.openCursor(); // 默认升序 = 老的先来
        req.onsuccess = (e) => {
          const cur = e.target.result;
          if (cur && out.deletedByLimit < toDelete) {
            cur.delete();
            out.deletedByLimit += 1;
            cur.continue();
          }
        };
        req.onerror = (e) => {
          errorsOut.push(
            `${storeName}-limit: ${e.target.error && e.target.error.message}`
          );
        };
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => {
          errorsOut.push(
            `${storeName}-limit-tx: ${e.target.error && e.target.error.message}`
          );
          resolve();
        };
      });
    }
    return out;
  }

  async function pruneSamples(force) {
    if (_prunePending) return { skipped: "in_progress" };
    if (!force && Date.now() - _lastPruneAt < PRUNE_THROTTLE_MS) {
      return { skipped: "throttled" };
    }
    _prunePending = true;
    const stats = { samples: null, skuSamples: null, errors: [] };
    try {
      const db = await init();
      stats.samples = await pruneOne(
        db,
        STORE_SAMPLES,
        SAMPLE_LIMIT,
        SAMPLE_MAX_AGE_MS,
        stats.errors
      );
      stats.skuSamples = await pruneOne(
        db,
        STORE_SKU_SAMPLES,
        SKU_SAMPLE_LIMIT,
        SKU_SAMPLE_MAX_AGE_MS,
        stats.errors
      );
      _lastPruneAt = Date.now();
    } catch (e) {
      stats.errors.push(String(e && e.message ? e.message : e));
    } finally {
      _prunePending = false;
    }
    return stats;
  }

  async function countSamples() {
    const db = await init();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SAMPLES, "readonly");
      const req = tx.objectStore(STORE_SAMPLES).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function getRecentSamples(limit) {
    const db = await init();
    const lim = Math.max(1, Math.min(200, limit || 20));
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SAMPLES, "readonly");
      const store = tx.objectStore(STORE_SAMPLES);
      const idx = store.index("ts");
      const out = [];
      const cur = idx.openCursor(null, "prev");
      cur.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor && out.length < lim) {
          out.push(cursor.value);
          cursor.continue();
        } else {
          resolve(out);
        }
      };
      cur.onerror = (e) => reject(e.target.error);
    });
  }

  async function clearSamples() {
    const db = await init();
    // 同时清两个 store,语义"全部重置"
    await Promise.all([
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_SAMPLES, "readwrite");
        const req = tx.objectStore(STORE_SAMPLES).clear();
        req.onsuccess = () => resolve();
        req.onerror = (e) => reject(e.target.error);
      }),
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_SKU_SAMPLES, "readwrite");
        const req = tx.objectStore(STORE_SKU_SAMPLES).clear();
        req.onsuccess = () => resolve();
        req.onerror = (e) => reject(e.target.error);
      }),
    ]);
  }

  async function countSkuSamples() {
    const db = await init();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SKU_SAMPLES, "readonly");
      const req = tx.objectStore(STORE_SKU_SAMPLES).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  // 拿 sku_samples 行(diff 工具用)。可选 sinceTs 过滤(只要 ts >= sinceTs);
  // 默认 limit 200_000 兜底,防游标无限滚导致主线程卡顿(理论上 retention 卡在
  // 50k 以下,200k 是安全上限)。
  async function getSkuSamples(opts) {
    const o = opts || {};
    const sinceTs = typeof o.sinceTs === "number" ? o.sinceTs : 0;
    const limit = Math.max(1, Math.min(200_000, o.limit || 200_000));
    const db = await init();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SKU_SAMPLES, "readonly");
      const idx = tx.objectStore(STORE_SKU_SAMPLES).index("ts");
      const range = sinceTs > 0 ? IDBKeyRange.lowerBound(sinceTs) : null;
      const req = idx.openCursor(range);
      const out = [];
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (cur && out.length < limit) {
          out.push(cur.value);
          cur.continue();
        } else {
          resolve(out);
        }
      };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function stats() {
    const samples = await getRecentSamples(200);
    const byUrlPattern = {};
    let totalSku = 0;
    let totalBytes = 0;
    let lastTs = 0;
    for (const s of samples) {
      byUrlPattern[s.urlPattern] = (byUrlPattern[s.urlPattern] || 0) + 1;
      totalSku += s.skuCount > 0 ? s.skuCount : 0;
      totalBytes += s.byteSize || 0;
      if (s.ts > lastTs) lastTs = s.ts;
    }
    const total = await countSamples();
    const skuTotal = await countSkuSamples();
    return {
      total,
      recentSample: samples.length,
      byUrlPattern,
      totalSku,
      totalBytes,
      lastTs,
      skuSamplesTotal: skuTotal,
    };
  }

  window.JZL1ShadowDB = {
    _v2: true,
    init,
    putSample,
    countSamples,
    countSkuSamples,
    getRecentSamples,
    getSkuSamples,
    clearSamples,
    pruneSamples,
    stats,
  };
})();
