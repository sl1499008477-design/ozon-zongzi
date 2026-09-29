/* SKU clipboard data: no collection, listing or database writes. */
(function () {
  'use strict';
  const skuText = value => /^\d+$/.test(String(value ?? '').trim()) ? String(value).trim() : '';

  async function readCopyData(request) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(request),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('SKU 数据读取超时')), 45000); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  async function resolveSkus({ currentSku, aspects, fetchModal, fetchAspects, onProgress = () => {} }) {
    const current = skuText(currentSku);
    if (!current) throw new Error('未获取到当前商品 SKU');
    const rows = new Map([[current, { sku: current }]]);
    const warnings = [];
    const modals = new Map();
    const add = variants => {
      for (const row of variants || []) {
        const sku = skuText(row?.sku);
        if (sku) rows.set(sku, { ...rows.get(sku), ...row, sku });
      }
    };
    const expand = async pageAspects => {
      for (const aspect of pageAspects) {
        add(aspect.variants);
        const info = aspect.aspectModalInfo;
        if (!info?.link || !(Number(info.realNumberOfVariants) > (aspect.variants?.length || 0))) continue;
        try {
          if (!modals.has(info.link)) modals.set(info.link, await readCopyData(() => fetchModal(info.link)));
          const variants = modals.get(info.link);
          add(variants);
          if (new Set(variants.map(v => skuText(v.sku)).filter(Boolean)).size < Number(info.realNumberOfVariants)) {
            warnings.push('部分隐藏变体未能展开');
          }
        } catch { warnings.push('隐藏变体读取失败'); }
      }
    };
    await expand(aspects || []);
    // Multi-axis pages expose only neighbours. Traverse each discovered SKU once
    // to cover sparse grids and more than two axes without assuming a full grid.
    if (aspects?.length > 1) {
      const visited = new Set([current]);
      for (const [sku, row] of rows) {
        if (visited.has(sku)) continue;
        visited.add(sku);
        onProgress(`展开变体 ${visited.size - 1}/${rows.size - 1}…`);
        try {
          const next = await readCopyData(() => fetchAspects(sku, row.link));
          if (!next?.length) throw new Error('missing aspects');
          await expand(next);
        } catch { warnings.push(`变体 ${sku} 读取失败`); }
      }
    }
    return { skus: [...rows.keys()], warnings: [...new Set(warnings)] };
  }

  async function collectFollowSkus({ skus, includeSales, period, fetchSellers, fetchSales, onProgress = () => {} }) {
    const sources = new Set(skus);
    const found = new Set();
    const warnings = [];
    for (const [i, sku] of skus.entries()) {
      onProgress(`读取跟卖 ${i + 1}/${skus.length}…`);
      try {
        const result = await readCopyData(() => fetchSellers(sku));
        if (!result || !Array.isArray(result.sellers)) throw new Error('missing sellers');
        const valid = result.sellers.map(seller => skuText(seller.sku)).filter(Boolean);
        for (const sellerSku of valid) if (!sources.has(sellerSku)) found.add(sellerSku);
        if (valid.length < result.sellers.length || Number(result.count) > result.sellers.length) {
          warnings.push(`商品 ${sku} 的跟卖列表不完整`);
        }
      } catch { warnings.push(`商品 ${sku} 的跟卖读取失败`); }
    }
    const rows = [...found].map(sku => ({ sku, sales: '' }));
    let missingSales = 0;
    if (includeSales) {
      let cursor = 0;
      let done = 0;
      const worker = async () => {
        while (cursor < rows.length) {
          const row = rows[cursor++];
          try {
            const data = await readCopyData(() => fetchSales(row.sku, period));
            const value = data?.soldCount;
            if (value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0) row.sales = String(Number(value));
          } catch { /* Missing is blank, never zero. */ }
          if (row.sales === '') missingSales++;
          onProgress(`读取销量 ${++done}/${rows.length}…`);
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, rows.length) }, worker));
    }
    return { text: rows.map(row => includeSales ? `${row.sku}\t${row.sales}` : row.sku).join('\n'), count: rows.length, missingSales, warnings };
  }
  globalThis.JzSkuCopy = { resolveSkus, collectFollowSkus };
})();
