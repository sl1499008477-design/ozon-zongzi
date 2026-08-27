/**
 * V3 跟卖 payload 拼装：
 *   row（用户粘贴解析得到）+ distilled（search-variant-model 提炼）
 * → V3 importOzonProductV3 的 item 对象。
 *
 * 关键决策：
 *   - 用户填了的字段 > distilled 兜底（尊重用户显式输入）
 *   - 三维必须齐全才发；缺一维就整组留空让 Ozon 用源 SKU 原值
 *   - offer_id 用户没填 → `${prefix}-${batchSalt}-${sku}`（batchSalt 防同 SKU 多次提交冲突）
 *   - images 必须有，否则跟卖会被 Ozon 拒；distilled.images 为空且无别的来源 → 标记 invalid
 *
 * 移植自 frontend/hooks/useBatchImport.ts:196-230 + ozon-product.js:4940-5038。
 */
(function (root) {
  "use strict";

  const NAME_MAX = 200;

  function safeText(s, max) {
    if (s == null) return "";
    const trimmed = String(s).replace(/\s+/g, " ").trim();
    return max && trimmed.length > max ? trimmed.slice(0, max) : trimmed;
  }

  /**
   * @param {QuickListRow} row 解析后的一行（含用户填的 sku/price/minPrice/offerId/weightG/lengthMm/widthMm/heightMm）
   * @param {distilled|null} distilled  search-variant-model 提炼结果，可能为 null
   * @param {object} opts
   * @returns {{ ok: boolean, item?: object, error?: string }}
   */
  function buildV3Item(row, distilled, opts = {}) {
    const {
      offerIdPrefix = "jz",
      batchSalt = "",
      currencyCode = "CNY",
      vat = "0",
      defaultStock,
      modelName,
    } = opts;

    if (!distilled) {
      return { ok: false, error: "未采集到商品信息" };
    }

    // 名称：distilled.name > row 没有名字 fallback 用 SKU
    const name = safeText(distilled.name || `Ozon SKU ${row.sku}`, NAME_MAX);

    // 图片：distilled.images（4194 主图 + 4195 collection）
    if (!distilled.images || distilled.images.length === 0) {
      return { ok: false, error: "采集结果缺少图片（attr 4194/4195 都为空）" };
    }
    const images = distilled.images.map((url, i) => ({
      file_name: url,
      default: i === 0,
    }));

    // 三维 + 重量：用户填了的优先，否则用 distilled 的 attribute 值，再否则用 fallback 100
    // 与跟卖面板（ozon-product.js:4948-4955）保持一致
    const weight = row.weightG != null && row.weightG > 0
      ? Math.round(row.weightG)
      : (distilled.weight || 100);
    const depth = row.lengthMm != null && row.lengthMm > 0
      ? Math.round(row.lengthMm)
      : (distilled.depth || 100);
    const width = row.widthMm != null && row.widthMm > 0
      ? Math.round(row.widthMm)
      : (distilled.width || 100);
    const height = row.heightMm != null && row.heightMm > 0
      ? Math.round(row.heightMm)
      : (distilled.height || 100);

    // offer_id：行内显式 > prefix-salt-sku
    const offerId = row.offerId
      || `${offerIdPrefix}-${batchSalt || Math.random().toString(36).slice(2, 8)}-${row.sku}`;

    const oldPrice = (row.price * 1.25).toFixed(2);
    const description = root.JZFollowSellContentCopy?.pickFollowSellDescription
      ? root.JZFollowSellContentCopy.pickFollowSellDescription({
          sourceVariant: distilled._sourceVariant,
          richContent: distilled.richContent || "",
          fallbackName: name,
          max: 4096,
        })
      : name;

    const item = {
      offer_id: offerId,
      name,
      price: row.price.toFixed(2),
      old_price: oldPrice,
      vat,
      currency_code: currencyCode,
      images,
      // 视频:带上 bundle(Ozon 复制 API)的视频/PDF complex 属性,后端 applyBundleComplexAttributes
      // 据此重建 import 的 complex_attributes,让批量跟卖也带上原 SKU 视频(与一键跟卖同路)。
      // 为空时 JSON 序列化跳过该 key。
      bundleComplexAttrs: distilled._bundleComplexAttrs || undefined,
      // 跟卖视频:collectBySkus(captureVideo)逐 SKU 抓竞品 PDP .mp4 转存成自有 Ozon 视频后写在
      // distilled.videoUrl。后端 injectUserVideoComplexAttribute 据此注入主视频槽(与一键跟卖同路)。
      videoUrl: distilled.videoUrl || undefined,
      scraped_description: description,
      scraped_breadcrumbs: distilled.breadcrumbs || [],
      scraped_sku: String(row.sku),
      // 型号名称(attr 9048)— Ozon 据此把多变体归到同一张卡。整组必须共享同一个值,
      // 否则后端降级用 offer_id/scraped_sku(每变体各异)→ 各成独立卡,不合并(本次修的 bug)。
      // 调用方(批量上架)传整批共享的 modelName;为空则不写,保持后端旧兜底行为。
      scraped_model_name: modelName ? safeText(modelName, NAME_MAX) : undefined,
      _sourceVariant: distilled._sourceVariant || undefined,
      weight,
      weight_unit: "g",
      depth,
      width,
      height,
      dimension_unit: "mm",
      // GTIN 从源 SKU 继承（distilled.barcode 来自 attr 7822 / /search barcodes[0]）。
      // 有 GTIN 是 Ozon 内容评分加分项。当前 QuickListRow 没有 barcode 输入列,
      // 全部走 distilled 兜底;若日后给行级 barcode 加入口,这里能自动尊重用户输入。
      barcode: row.barcode || distilled.barcode || "",
      complex_attributes: [],
      service_type: "IS_CODE_SERVICE",
    };

    // 品牌策略：'no_brand' / 'copy'（=保留原品牌）；后端 product.service.ts 据此设置 attr 31
    if (opts.brand) {
      item.scraped_brand = opts.brand;
    }
    if (defaultStock != null) {
      item._stock = parseInt(defaultStock, 10) || 0;
    }
    // 最低价(用户在批量行用 `~最低价` 标记)→ V3 API min_price 字段(Ozon 自动调价的下限)。
    // 仅在 > 0 时下发,避免发空字符串触发 Ozon 校验报错。
    if (row.minPrice != null && row.minPrice > 0) {
      item.min_price = row.minPrice.toFixed(2);
    }

    return { ok: true, item };
  }

  root.JZV3Payload = {
    buildV3Item,
    safeText,
  };
})(typeof self !== "undefined" ? self : window);
