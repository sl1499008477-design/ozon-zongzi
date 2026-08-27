// l1-diff.js — Phase 1.5 对比诊断工具
//
// 注入:ISOLATED / document_idle / 搜索/类目/商品页
//
// 职责:
//   对比 L1(jzL1Shadow.sku_samples)和 L2(jzCollector.sales)在同一时间窗口
//   内的 SKU 集合与字段完整度,输出 Phase 2 决策需要的指标:
//     - L1 覆盖率 ratio = |L1| / |L2|(plan 第六节 Phase 2 验收标准要求 ≥ 1.2x)
//     - 字段完整度对比:price/title/image/seller/sales/rating 各 probe
//       在 L1 与 L2 上的命中次数,L1 比 L2 有"独占字段"是合并入主缓存的关键论据
//     - phase2Verdict:READY_FOR_PHASE2 / NO_DATA / L1 覆盖率不足 / 字段无优势
//
// API:
//   __jzc.l1vsL2Diff({hours=24})  → 计算并返回结果对象
//
// 设计原则:
//   - 纯只读,不写任何数据
//   - 走现有 JZL1ShadowDB / JZCollectorDB,不引新存储
//   - 内存合并 SKU 集合,几万条数据集 union/intersection 在 <100ms 内完成

(() => {
  if (window.__JZC_L1_DIFF_INSTALLED__) return;
  window.__JZC_L1_DIFF_INSTALLED__ = true;

  // L1 → L2 字段语义映射在 l1-shadow-db.js 的 FIELD_PROBES 已定义。
  // 这里只列要对比的字段名(顺序对应输出列)。
  const PROBE_NAMES = ["price", "title", "image", "seller", "sales", "rating"];

  // 把 L2 sales 行映射成 {fields:[...]} — 跟 L1 sku_samples 行 schema 对齐,
  // 方便后续 intersection 字段比对走同一份代码路径。
  // L2 schema(buildSaleRecord)只有 price/name/image/soldCount,无 seller/rating
  // —— 这正是 L1 BFF 可能带来的"字段优势",由 fieldCompletenessOnIntersection
  // 比对结果显式暴露给用户。
  function l2RowToFields(row) {
    const f = [];
    if (row.price != null && row.price !== "" && row.price !== "0") f.push("price");
    if (row.name) f.push("title");
    if (row.image) f.push("image");
    if (row.soldCount != null) f.push("sales");
    // L2 无 seller / rating — 留空,intersection 对比时会显式看到 0
    return f;
  }

  async function readL2Skus(sinceTs) {
    if (!window.JZCollectorDB || !window.JZCollectorDB.getSalesSince) {
      return { skus: new Map(), reason: "JZCollectorDB.getSalesSince-unavailable" };
    }
    let sales;
    try {
      // 走 collectedAt 索引游标,IDB 层只 yield 命中窗口的行;避免 getAllSales
      // 整桶载入(可能上万 row)。索引本身会跳过 collectedAt=null/undefined 的
      // 老/坏数据,所以游标返回的每一行 collectedAt 都是 >= sinceTs。
      sales = await window.JZCollectorDB.getSalesSince(sinceTs);
    } catch (e) {
      return {
        skus: new Map(),
        reason: `getSalesSince-error: ${e && e.message ? e.message : e}`,
      };
    }
    const map = new Map();
    for (const row of sales) {
      if (!row || !row.sku) continue;
      // 防御:理论上 getSalesSince 不会返回这种行(索引会过滤),但 JS 兜底
      // 一层 — 防止未来上游 schema/索引变更引入无 collectedAt 的脏数据
      // 污染窗口统计。
      if (!row.collectedAt || row.collectedAt < sinceTs) continue;
      map.set(String(row.sku), {
        fields: l2RowToFields(row),
        ts: row.collectedAt,
      });
    }
    return { skus: map, reason: null };
  }

  async function readL1Skus(sinceTs) {
    if (!window.JZL1ShadowDB || !window.JZL1ShadowDB.getSkuSamples) {
      return { skus: new Map(), reason: "JZL1ShadowDB-unavailable" };
    }
    let samples;
    try {
      samples = await window.JZL1ShadowDB.getSkuSamples({ sinceTs });
    } catch (e) {
      return { skus: new Map(), reason: `getSkuSamples-error: ${e.message || e}` };
    }
    // 同一 SKU 可能在多个响应里出现(翻页/SPA 切路由)— 字段集合 union,
    // ts 取最新。
    const map = new Map();
    const urlPatternByS = new Map();
    for (const s of samples) {
      if (!s || !s.sku) continue;
      const prev = map.get(s.sku);
      if (prev) {
        // union fields
        const seen = new Set(prev.fields);
        for (const f of s.fields || []) seen.add(f);
        prev.fields = [...seen];
        if (s.ts > prev.ts) prev.ts = s.ts;
        urlPatternByS.get(s.sku).add(s.urlPattern);
      } else {
        map.set(s.sku, { fields: [...(s.fields || [])], ts: s.ts });
        urlPatternByS.set(s.sku, new Set([s.urlPattern]));
      }
    }
    return { skus: map, reason: null, urlPatterns: urlPatternByS };
  }

  function judgePhase2(l1Count, l2Count, fieldStats) {
    if (l1Count === 0) return "NO_L1_DATA: 装上扩展浏览搜索/类目/商品页才会有 L1 样本";
    if (l2Count === 0) return "NO_L2_DATA: 主 collector 还没开过采集(去搜索页点采集器面板)";
    const ratio = l1Count / l2Count;
    // L1 有但 L2 完全没有的字段(seller/rating 是典型)
    const l1OnlyFields = PROBE_NAMES.filter(
      (f) => (fieldStats.l1[f] || 0) > 0 && (fieldStats.l2[f] || 0) === 0
    );
    if (ratio < 1.2 && l1OnlyFields.length === 0) {
      return `NOT_READY: L1 覆盖率 ${ratio.toFixed(2)}x (需要 ≥ 1.2x) 且字段无优势`;
    }
    if (ratio < 1.2) {
      return `PARTIAL: L1 覆盖率 ${ratio.toFixed(2)}x (需要 ≥ 1.2x),但字段优势 ${l1OnlyFields.join(",")} — 看你能否容忍较低覆盖率`;
    }
    if (l1OnlyFields.length === 0) {
      return `PARTIAL: L1 覆盖率 ${ratio.toFixed(2)}x OK 但字段无优势 — 合并意义有限`;
    }
    return `READY_FOR_PHASE2: L1 ${ratio.toFixed(2)}x 覆盖 + 字段优势 ${l1OnlyFields.join(",")}`;
  }

  async function computeL1vsL2Diff(opts) {
    const o = opts || {};
    const hours = typeof o.hours === "number" && o.hours > 0 ? o.hours : 24;
    const sinceTs = Date.now() - hours * 3600 * 1000;

    const [l1Result, l2Result] = await Promise.all([
      readL1Skus(sinceTs),
      readL2Skus(sinceTs),
    ]);

    const l1Skus = l1Result.skus;
    const l2Skus = l2Result.skus;

    const l1Set = new Set(l1Skus.keys());
    const l2Set = new Set(l2Skus.keys());

    const l1Only = [];
    const l2Only = [];
    const intersection = [];
    for (const s of l1Set) {
      if (l2Set.has(s)) intersection.push(s);
      else l1Only.push(s);
    }
    for (const s of l2Set) {
      if (!l1Set.has(s)) l2Only.push(s);
    }

    // 字段命中统计(只在 intersection 上算 — 这样两边都能"看到"同一 SKU,
    // 字段差异才有意义)
    const fieldStats = { l1: {}, l2: {} };
    for (const f of PROBE_NAMES) {
      fieldStats.l1[f] = 0;
      fieldStats.l2[f] = 0;
    }
    for (const sku of intersection) {
      const l1 = l1Skus.get(sku);
      const l2 = l2Skus.get(sku);
      for (const f of l1.fields) {
        if (f in fieldStats.l1) fieldStats.l1[f] += 1;
      }
      for (const f of l2.fields) {
        if (f in fieldStats.l2) fieldStats.l2[f] += 1;
      }
    }

    return {
      windowHours: hours,
      sinceTs: new Date(sinceTs).toISOString(),
      l1: {
        total: l1Set.size,
        readError: l1Result.reason,
      },
      l2: {
        total: l2Set.size,
        readError: l2Result.reason,
      },
      coverageRatio: l2Set.size > 0 ? +(l1Set.size / l2Set.size).toFixed(2) : null,
      intersection: intersection.length,
      l1Only: l1Only.length,
      l2Only: l2Only.length,
      // 抽样 5 个 SKU 出来给用户手动验证(用户可以拿这 SKU 去 ozon 验证 L1/L2 哪边正确)
      l1OnlySample: l1Only.slice(0, 5),
      l2OnlySample: l2Only.slice(0, 5),
      fieldCompletenessOnIntersection: fieldStats,
      phase2Verdict: judgePhase2(l1Set.size, l2Set.size, fieldStats),
    };
  }

  window.__jzc = window.__jzc || {};
  window.__jzc.l1vsL2Diff = computeL1vsL2Diff;
})();
