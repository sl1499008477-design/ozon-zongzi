/**
 * SKU 批采工具：按 SKU 列表调 background searchVariants action,
 * 并发 BATCH_SIZE=3 + 批间节流(2026-06-08 从 5 降回 3:每个 SKU 会向 seller.ozon.ru
 * 发 /search + create-bundle(写,建 draft)2 个门户请求,seller portal 按"短时请求密度"
 * 做反爬风险评分,5 并发 + 0 间隔会累积风险分触发验证码/限制登录 —— 用户实测批量上架后频繁
 * 被限制登录。降并发 + 批间停顿把密度摊平;全局节奏闸门另见 service-worker.js fetchSellerPortal)、
 * 每个 SKU 失败重试 1 次,命中反爬(ANTIBOT_BLOCKED)立即中止剩余批次并进入冷却,
 * 提取属性 4180/4191/4194/4195/4497/9454/9455/9456/7822 → distilled。
 *
 * 单源策略（v0.9.58+）：只调 background 提供的 searchVariants，不再 fetch 公开页。原因：
 *   - 一键跟卖的 type/属性 100% 来自 seller 接口；批采用同一接口才能保证 type 精确
 *   - 公开页只能贡献 breadcrumbs/brand/部分图片质量，不参与 type 决定
 *   - 接口 miss 时面包屑模糊匹配会命中错误 type → Ozon 报"商品照片与其类型不符"
 *   - miss 直接失败让 batch-upload UI 给出明确错误，比上架后 Ozon 拒卡反馈更早
 *
 * SW searchVariants 2026-05 endpoint 迁移：旧 /api/v1/search-variant-model 下线,
 * 现走 /api/v1/search (按 sku.values 精确匹配) + /api/site/seller-prototype/
 * create-bundle-by-variant-id (拿 bundle item,SW 注入 weight/三维/barcode 到 items[0])。
 *
 * 移植自 extension/content/ozon-product.js 跟卖面板批采逻辑（4755-4848 + 4937-5002）。
 * 挂在 window.JZSkuCollect。依赖 chrome.runtime.sendMessage 可用（在扩展页面 / popup / content 都可以）。
 */
(function (root) {
  "use strict";

  const BATCH_SIZE = 3;
  // service-worker 的 searchVariants 内部已经对 TIMEOUT / NETWORK 重试 2 次（间隔 2s），
  // 这里外层只跑 1 次即可；多重试一层只会让用户等更久不会让结果更对。
  const PER_SKU_RETRIES = 1;
  const RETRY_INTERVAL_MS = 0;
  // 批与批之间的节流(+ jitter):把 seller.ozon.ru 门户请求密度摊平,降低反爬风险分累积速度。
  // 与 service-worker fetchSellerPortal 的全局 200ms 闸门是两层互补防护(此处管批采节奏)。
  const BATCH_INTERVAL_MS = 400;
  const BATCH_INTERVAL_JITTER_MS = 300;
  // 视频转存逐 SKU 间隔:转存额外走买家页抓取 + 卖家 upload-file 2 个门户请求,同样摊平。
  const VIDEO_INTERVAL_MS = 500;
  // 反爬熔断冷却:命中 ANTIBOT_BLOCKED(seller portal 403)后中止剩余采集并冷却,
  // 冷却期内拒绝新采集请求,避免继续猛打把"限速"升级成"限制登录"。
  const ANTIBOT_COOLDOWN_MS = 10 * 60 * 1000;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 模块级反爬冷却时间戳(batch-upload 页面生命周期内有效;跨页面/刷新会重置,
  // 但 Ozon 端风险分仍在,重置后再打会立刻再次 403 → 再次冷却)。
  let antibotCooldownUntil = 0;
  const antibotCooldownRemainingMs = () => Math.max(0, antibotCooldownUntil - Date.now());

  function sendMsg(payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(payload, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(resp);
        }
      });
    });
  }

  /**
   * search-variant-model 的 name 是模糊搜索（attr 9024 Артикул），
   * 必须挑出 attr 9024 以输入 SKU 为前缀的那个。多个匹配按"可变特性 collection 最少"排序。
   */
  function pickItemForSku(items, sku) {
    if (!Array.isArray(items) || items.length === 0) return null;
    const matching = items.filter((it) =>
      (it.attributes || []).some(
        (a) =>
          String(a.key) === "9024" &&
          (String(a.value || "").startsWith(sku + "-") || String(a.value || "") === sku),
      ),
    );
    if (matching.length === 0) return null;
    const score = (it) => {
      let s = 0;
      for (const key of ["10096", "22814", "8219"]) {
        const a = (it.attributes || []).find((x) => String(x.key) === key);
        if (Array.isArray(a?.collection)) s += a.collection.length;
        else if (a?.value) s += 1;
      }
      return s;
    };
    matching.sort((a, b) => score(a) - score(b));
    return matching[0];
  }

  /** 从 sourceVariant 抽出 attribute 整数值 */
  function readSourceInt(sv, key) {
    const a = (sv?.attributes || []).find((x) => String(x.key) === String(key));
    const v = a?.value;
    const n = v ? parseInt(v, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  /** 从 sourceVariant 抽出字符串值（去除多余空白） */
  function readSourceText(sv, key) {
    const a = (sv?.attributes || []).find((x) => String(x.key) === String(key));
    return a?.value ? String(a.value).replace(/\s+/g, " ").trim() : null;
  }

  /** 从 sourceVariant 抽出图册：attr 4194 主图 + attr 4195 collection */
  function readSourceImages(sv) {
    if (!sv?.attributes) return [];
    const out = [];
    const seen = new Set();
    const push = (u) => {
      if (!u || typeof u !== "string") return;
      const norm = u.split("?")[0].split("#")[0].toLowerCase();
      if (seen.has(norm)) return;
      seen.add(norm);
      out.push(u);
    };
    const primary = sv.attributes.find((a) => String(a.key) === "4194");
    const addl = sv.attributes.find((a) => String(a.key) === "4195");
    if (primary?.value) push(primary.value);
    if (Array.isArray(addl?.collection)) {
      for (const u of addl.collection) push(u);
    }
    return out;
  }

  /**
   * 从 sourceVariant 提炼出可上架字段。sv 单源时直接当 distilled 用。
   * - 4180 商品名 / 4191 描述
   * - 4194 主图 / 4195 图册
   * - 4497 重量(g) / 9454 深 / 9455 宽 / 9456 高 (mm)
   * - 7822 GTIN（写入 item.barcode 顶层字段，影响内容评分）
   */
  function distillSource(sv) {
    if (!sv) return null;
    return {
      _sourceVariant: sv,
      _pageProduct: null,
      // bundle(Ozon 复制 API)的视频/PDF complex 属性,SW searchVariants 已注入到 sv 上。
      // 顶层透出(与原始 sv 同 key),让批量 buildV3Item 能直接带上,跟卖原 SKU 视频。
      _bundleComplexAttrs: sv._bundleComplexAttrs || undefined,
      name: readSourceText(sv, "4180"),
      description: readSourceText(sv, "4191"),
      richContent: readSourceText(sv, "11254"),
      images: readSourceImages(sv),
      breadcrumbs: [], // sv 单源下不需要,backend 严格模式不走面包屑
      brand: null,
      barcode: readSourceText(sv, "7822"),
      weight: readSourceInt(sv, "4497"),
      depth: readSourceInt(sv, "9454"),
      width: readSourceInt(sv, "9455"),
      height: readSourceInt(sv, "9456"),
      categories: sv.categories || [],
      descriptionCategoryId: sv.description_category_id,
    };
  }

  /**
   * 兼容旧 API 名 — 现已等价于 distillSource(sv)，pageProduct 参数被忽略。
   * 保留导出仅为外部代码不报错；新代码请直接用 distillSource。
   */
  function mergeDistilled(_pageProductIgnored, sourceVariant) {
    return sourceVariant ? distillSource(sourceVariant) : null;
  }

  /**
   * 单 SKU 抓取：
   * 1. searchVariants(SW) → /api/v1/search + create-bundle-by-variant-id —
   *    /search 按 sku.values 精确匹配,items[0] 必是该 SKU 的 variant,且 SW 已注入 bundle
   *    物理 attr (4497/9454/9455/9456/7822)。9024 前缀筛只对自家目录有意义
   *    (跨店 SKU 的 9024 是别人家货号必失配),失配也走 items[0]。
   * 2. searchProductBySku → /api/v1/search(无 bundle 注入),仅在 searchVariants 完全
   *    error 时降级用,物理 attr 会缺失。
   */
  async function fetchOneSku(sku) {
    const variantResp = await sendMsg({ action: "searchVariants", sku });

    let sourceVariant = null;
    let lastNetworkErr = null;
    if (variantResp?.ok) {
      const items = variantResp.data?.items || [];
      // /search 已精确按 sku 过滤,items[0] 即目标 variant(且 SW 已注入 bundle 物理 attr)。
      // pickItemForSku 仅作自家目录场景的 9024 优选;失配不再丢弃带 bundle 数据的 items[0]。
      sourceVariant = pickItemForSku(items, sku) || items[0] || null;
    } else if (variantResp?.error) {
      lastNetworkErr = { code: variantResp.error, msg: variantResp.message };
    }

    // searchVariants 命中反爬/认证/无 tab/权限等"基础设施性"错误时直接返回,不再 fallback 调
    // searchProductBySku 多打一枪门户请求 —— 反爬已触发,继续打只会加重风险分,且让 collectBySkus
    // 尽快据 ANTIBOT_BLOCKED 熔断进冷却。仅"业务性未命中"(空 items / NOT_IN_OWN_CATALOG)才降级。
    const INFRA_ERRORS = ["ANTIBOT_BLOCKED", "AUTH_REQUIRED", "NO_SELLER_TAB", "PERMISSION_DENIED", "NO_COMPANY_ID"];
    if (!sourceVariant && lastNetworkErr && INFRA_ERRORS.includes(lastNetworkErr.code)) {
      return {
        ok: false,
        errorCode: lastNetworkErr.code,
        message: lastNetworkErr.msg || lastNetworkErr.code || "卖家中心接口失败",
      };
    }

    // searchVariants error 或返空 items → 降级 /api/v1/search(无 bundle 注入,物理 attr 会缺失)
    if (!sourceVariant) {
      const searchResp = await sendMsg({ action: "searchProductBySku", sku });
      if (searchResp?.ok) {
        const globalItems = searchResp.data?.items || [];
        if (globalItems.length > 0) {
          sourceVariant = pickItemForSku(globalItems, sku) || globalItems[0];
        }
      } else if (searchResp?.error && !lastNetworkErr) {
        lastNetworkErr = { code: searchResp.error, msg: searchResp.message };
      }
    }

    if (!sourceVariant) {
      // 区分两类失败：接口错（cookie/网络）vs 真没匹配（SKU 在 ozon 找不到）
      return {
        ok: false,
        errorCode: lastNetworkErr ? lastNetworkErr.code : "NO_VARIANT_MATCH",
        message: lastNetworkErr
          ? lastNetworkErr.msg || lastNetworkErr.code || "卖家中心接口失败"
          : "在 ozon 找不到同款源商品（无法跟卖）",
      };
    }

    return {
      ok: true,
      distilled: distillSource(sourceVariant),
      hasPageProduct: false, // 单源化后恒为 false,保留字段名只为避免 caller 报错
      hasSourceVariant: true,
    };
  }

  /**
   * Gate check：先单独跑第一个 SKU 验证通讯能力。
   * 失败时返回 errorCode 让 caller 决定是否中止 / 触发 cookie resync。
   */
  async function gateCheck(firstSku) {
    const cd = antibotCooldownRemainingMs();
    if (cd > 0) {
      return {
        ok: false,
        errorCode: "ANTIBOT_BLOCKED",
        message: `seller.ozon.ru 触发反爬保护,冷却中,请约 ${Math.ceil(cd / 60000)} 分钟后再试`,
      };
    }
    try {
      const r = await fetchOneSku(firstSku);
      if (!r.ok) {
        // gate 阶段就命中反爬 → 立即进入冷却,后续 collectBySkus 入口会据此直接拒绝。
        if (r.errorCode === "ANTIBOT_BLOCKED") {
          antibotCooldownUntil = Date.now() + ANTIBOT_COOLDOWN_MS;
        }
        return {
          ok: false,
          errorCode: r.errorCode,
          message: r.message,
        };
      }
      return {
        ok: true,
        distilled: r.distilled,
        hasPageProduct: r.hasPageProduct,
        hasSourceVariant: r.hasSourceVariant,
      };
    } catch (e) {
      return {
        ok: false,
        errorCode: "UNKNOWN_ERROR",
        message: e.message || String(e),
      };
    }
  }

  /**
   * 批采核心入口：对 skus 数组里每个 SKU 调 searchVariants，
   * 提炼后写入 Map<string, distilled>。
   *
   * @param {string[]} skus
   * @param {{
   *   onProgress?: (done, total, sku, ok, error) => void,
   *   signal?: AbortSignal,
   *   prefetched?: Map<string, distilled>  // gateCheck 已经拿到的结果可塞回避免重复调
   * }} opts
   * @returns {Promise<{ sourceMap: Map<string, distilled>, failed: Array<{sku, error}> }>}
   */
  async function collectBySkus(skus, opts = {}) {
    const sourceMap = new Map();
    const failed = [];
    const total = skus.length;
    let done = 0;

    // 反爬冷却期内直接拒绝,不发任何门户请求(caller 据 antibotTripped 提示用户稍后再试)。
    const cooldownAtEntry = antibotCooldownRemainingMs();
    if (cooldownAtEntry > 0) {
      return { sourceMap, failed, antibotTripped: true, cooldownMs: cooldownAtEntry };
    }

    const onProgress = opts.onProgress || (() => {});
    const aborted = () => opts.signal?.aborted;

    // 把 gateCheck 已经拿到的结果直接塞进 sourceMap，避免重复 fetch
    if (opts.prefetched && opts.prefetched.size > 0) {
      for (const [sku, distilled] of opts.prefetched.entries()) {
        if (distilled) {
          sourceMap.set(sku, distilled);
        }
      }
    }

    const tryOneSku = async (sku) => {
      if (aborted()) return { ok: false, error: "已取消" };
      try {
        const r = await fetchOneSku(sku);
        if (r.ok) return { ok: true, distilled: r.distilled };
        return { ok: false, error: r.message, errorCode: r.errorCode };
      } catch (e) {
        return { ok: false, error: e.message || String(e) };
      }
    };

    // 跳过已 prefetched 的 SKU（gateCheck 已经处理）
    const remaining = skus.filter((sku) => !sourceMap.has(sku));
    // 已 prefetched 的也要算进 done 里，让进度条显示准确
    done = sourceMap.size;
    if (sourceMap.size > 0) {
      for (const sku of skus) {
        if (sourceMap.has(sku)) onProgress(done, total, sku, true, null);
      }
    }

    let antibotTripped = false;
    for (let b = 0; b < remaining.length; b += BATCH_SIZE) {
      if (aborted()) break;
      // 批间节流(首批不停):把门户请求密度摊平,降低反爬风险分累积速度。
      if (b > 0) {
        await sleep(BATCH_INTERVAL_MS + Math.random() * BATCH_INTERVAL_JITTER_MS);
        if (aborted()) break;
      }
      const batch = remaining.slice(b, b + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (sku) => {
          const r = await tryOneSku(sku);
          done++;
          onProgress(done, total, sku, r.ok, r.error);
          return { sku, r };
        }),
      );
      for (const settled of results) {
        if (settled.status !== "fulfilled") continue;
        const { sku, r } = settled.value;
        if (r.ok) sourceMap.set(sku, r.distilled);
        else {
          failed.push({ sku, error: r.error });
          if (r.errorCode === "ANTIBOT_BLOCKED") antibotTripped = true;
        }
      }
      // 命中反爬:进入冷却并中止剩余批次,避免继续猛打把"限速"升级成"限制登录"。
      // 已采到的部分仍随结果返回 —— 上架走后端官方 API,不碰门户,可正常提交。
      if (antibotTripped) {
        antibotCooldownUntil = Date.now() + ANTIBOT_COOLDOWN_MS;
        break;
      }
    }

    // 源富内容(11254)注入 distilled._sourceVariant.attributes(幂等)。与
    // content/ozon-product.js 的 jzInjectRichContentAttr 同语义 —— 上架时后端
    // pickSourceRichContent 从 _sourceVariant 统一下发,跟卖卡保留源富内容。
    const injectRichContent = (distilled, richContent) => {
      if (!richContent || !distilled) return;
      distilled.richContent = richContent;
      const sv = distilled._sourceVariant;
      if (!sv || typeof sv !== "object") return;
      const attrs = Array.isArray(sv.attributes) ? sv.attributes : [];
      const existing = attrs.find((a) => String(a?.key) === "11254");
      if (existing) {
        if (!readSourceText({ attributes: [existing] }, "11254")) existing.value = richContent;
        return;
      }
      sv.attributes = [...attrs, { key: "11254", value: richContent }];
    };
    const hasRichContent = (distilled) =>
      Boolean(distilled?.richContent || readSourceText(distilled?._sourceVariant, "11254"));

    // 源描述(4191)+ 主题标签(23171)注入 —— 与富内容(11254)同源同次抓取(SW page json)。
    // /search 不返这三样,只活在 PDP widget;批量经买家 tab 抓回后在此落地,让上架继承源店铺内容。
    // 描述:写 distilled.description(供 v3-payload pageDescription 兜底)+ 经 contentCopy 合并进
    //   _sourceVariant 的 4191(供 pickFollowSellDescription 直读 / 后端保留),仅在原值空时填,不覆盖。
    // 标签:经 contentCopy 合并进 _sourceVariant 的 23171(原样存,**品牌清洗在 backend 注入处做** ——
    //   源标签裸下发会触发 Ozon BR_hashtag_brand 拒卡,见 product.service.ts filterBrandHashtags)。
    const contentCopy =
      (root && root.JZFollowSellContentCopy) ||
      (typeof window !== "undefined" && window.JZFollowSellContentCopy) ||
      null;
    const injectSourceText = (distilled, description, hashtags) => {
      if (!distilled) return;
      const sv = distilled._sourceVariant;
      const desc = typeof description === "string" ? description.trim() : "";
      if (desc) {
        if (!distilled.description) distilled.description = desc;
        if (sv && typeof sv === "object" && contentCopy?.mergeSourceDescriptionIntoVariant) {
          contentCopy.mergeSourceDescriptionIntoVariant(sv, desc);
        }
      }
      const tags = Array.isArray(hashtags) ? hashtags : [];
      if (tags.length && sv && typeof sv === "object" && contentCopy?.mergeSourceHashtagsIntoVariant) {
        contentCopy.mergeSourceHashtagsIntoVariant(sv, tags);
      }
    };

    // 跟卖视频(opts.captureVideo,batch-upload 用):逐 SKU 借买家 tab 抓竞品 PDP gallery 的
    // .mp4 → 转存成卖家自有 Ozon 视频,写进 distilled.videoUrl,buildV3Item 据此下发 item.videoUrl。
    // **串行**执行:转存走 seller/buyer tab 的 executeScript,并发会抢同一 tab 致 flaky;且本就
    // best-effort —— 任何 SKU 抓不到/转存失败都 null 降级,不影响该 SKU 上架。
    // SW 同一次 page json 顺带抽源富内容(richContent)随响应带回,此处一并注入,零增量请求。
    if (opts.captureVideo && sourceMap.size > 0 && !antibotTripped) {
      const onVideoProgress = opts.onVideoProgress || (() => {});
      const entries = Array.from(sourceMap.entries());
      let vDone = 0;
      for (let vi = 0; vi < entries.length; vi++) {
        if (aborted()) break;
        // 逐 SKU 节流:视频转存额外走买家页抓取 + 卖家 upload-file 门户请求,首个不停。
        if (vi > 0) await sleep(VIDEO_INTERVAL_MS);
        const [sku, distilled] = entries[vi];
        try {
          const resp = await sendMsg({ action: "transferVariantVideo", url: `https://www.ozon.ru/product/${sku}` });
          // SW 统一返回 { ok:true, data:{ url, richContent } };url 为 null 表示无视频/失败(已降级)。
          const url = resp?.ok ? resp.data?.url : (resp?.data?.url ?? null);
          if (url && distilled) distilled.videoUrl = url;
          injectRichContent(distilled, resp?.data?.richContent || "");
          injectSourceText(distilled, resp?.data?.description || "", resp?.data?.hashtags || []);
          onVideoProgress(++vDone, entries.length, sku, !!url);
        } catch (e) {
          onVideoProgress(++vDone, entries.length, sku, false);
        }
      }
    }

    // 源富内容独立通道:视频转存没开(或个别 SKU 没抽到)时,逐 SKU 借买家 tab 只拉 page json
    // 抽 11254(纯读、无门户写请求,与 seller portal 反爬风险分离)。同视频段串行 + 同间隔节流;
    // best-effort —— 抓不到/失败一律跳过,绝不阻断上架。opts.captureRichContent === false 可关。
    if (opts.captureRichContent !== false && sourceMap.size > 0 && !antibotTripped) {
      const pending = Array.from(sourceMap.entries()).filter(([, d]) => !hasRichContent(d));
      let first = true;
      for (const [sku, distilled] of pending) {
        if (aborted()) break;
        if (!first) await sleep(VIDEO_INTERVAL_MS);
        first = false;
        try {
          const resp = await sendMsg({ action: "fetchVariantRichContent", url: `https://www.ozon.ru/product/${sku}` });
          injectRichContent(distilled, resp?.data?.richContent || "");
          injectSourceText(distilled, resp?.data?.description || "", resp?.data?.hashtags || []);
        } catch (e) {
          // best-effort:富内容是增强项,失败静默。
        }
      }
    }

    return { sourceMap, failed, antibotTripped, cooldownMs: antibotTripped ? ANTIBOT_COOLDOWN_MS : 0 };
  }

  root.JZSkuCollect = {
    gateCheck,
    collectBySkus,
    pickItemForSku,
    distillSource,
    mergeDistilled, // 兼容旧 caller，新代码直接用 distillSource
    BATCH_SIZE,
    PER_SKU_RETRIES,
  };
})(typeof self !== "undefined" ? self : window);
