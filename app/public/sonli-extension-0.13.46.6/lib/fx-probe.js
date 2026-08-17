(function initFxProbe(globalScope) {
  'use strict';

  const MIN_RATE = 5;
  const MAX_RATE = 30;

  function parseWidgetState(value) {
    if (value && typeof value === 'object') return value;
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function detectCurrency(value) {
    const text = String(value || '').toUpperCase();
    if (/[\u00a5\uffe5¥￥]/u.test(text) || /\b(?:CNY|RMB)\b/.test(text)) return 'CNY';
    if (/[\u20bd₽]/u.test(text) || /\b(?:RUB|RUR)\b/.test(text) || /РУБ/i.test(text)) return 'RUB';
    return '';
  }

  function parseMoney(value) {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
    const compact = String(value || '')
      .replace(/[\s\u00a0\u2007\u202f]/gu, '')
      .replace(/[^\d,.-]/g, '');
    if (!compact) return 0;
    const comma = compact.lastIndexOf(',');
    const dot = compact.lastIndexOf('.');
    let normalized = compact;
    if (comma >= 0 && dot >= 0) {
      const decimal = comma > dot ? ',' : '.';
      const thousands = decimal === ',' ? /\./g : /,/g;
      normalized = compact.replace(thousands, '').replace(decimal, '.');
    } else if (comma >= 0) {
      const fractionLength = compact.length - comma - 1;
      normalized = fractionLength > 0 && fractionLength <= 2
        ? compact.replace(/\./g, '').replace(',', '.')
        : compact.replace(/,/g, '');
    } else if (dot >= 0) {
      const fractionLength = compact.length - dot - 1;
      normalized = fractionLength > 0 && fractionLength <= 2
        ? compact.replace(/,/g, '')
        : compact.replace(/\./g, '');
    }
    const number = Number(normalized);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  function approximatelyEqual(left, right) {
    const a = Number(left);
    const b = Number(right);
    if (!(a > 0) || !(b > 0)) return false;
    return Math.abs(a - b) <= Math.max(0.02, Math.min(a, b) * 0.0001);
  }

  function extractFrontendPricePair(payload, requestedSku) {
    const sku = String(requestedSku || '').trim();
    const widgetStates = payload?.widgetStates && typeof payload.widgetStates === 'object'
      ? payload.widgetStates
      : {};
    let visibleCardPrice = 0;
    let visiblePrice = 0;
    const candidates = [];

    for (const [widgetKey, rawState] of Object.entries(widgetStates)) {
      const state = parseWidgetState(rawState);
      if (!state) continue;
      if (widgetKey.startsWith('webPrice-')) {
        if (detectCurrency(state.cardPrice) === 'CNY') visibleCardPrice = parseMoney(state.cardPrice);
        if (detectCurrency(state.price) === 'CNY') visiblePrice = parseMoney(state.price);
        continue;
      }
      if (!widgetKey.startsWith('webAspects-')) continue;
      for (const aspect of Array.isArray(state.aspects) ? state.aspects : []) {
        for (const variant of Array.isArray(aspect?.variants) ? aspect.variants : []) {
          if (String(variant?.sku || '') !== sku) continue;
          const cnyText = variant?.data?.price;
          const cnyPrice = detectCurrency(cnyText) === 'CNY' ? parseMoney(cnyText) : 0;
          const rubPrice = parseMoney(variant?.price);
          const impliedRate = cnyPrice > 0 ? rubPrice / cnyPrice : 0;
          if (!(rubPrice > 0) || !(cnyPrice > 0) || impliedRate < MIN_RATE || impliedRate > MAX_RATE) continue;
          let score = 0;
          if (approximatelyEqual(cnyPrice, visibleCardPrice)) score += 100;
          if (variant?.active === true) score += 20;
          if (String(variant?.availability || '').toLowerCase() === 'instock') score += 10;
          candidates.push({
            rubPrice,
            cnyPrice,
            impliedRate,
            score,
            widgetKey,
            availability: variant?.availability || '',
            active: variant?.active === true,
          });
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score || a.widgetKey.localeCompare(b.widgetKey));
    const selected = candidates[0] || null;
    if (!selected) {
      return {
        ok: false,
        error: visibleCardPrice > 0 || visiblePrice > 0
          ? '该 SKU 商品页只返回了 CNY 前台价，没有返回同一售价基准的 RUB 原价；请更换汇率 SKU'
          : '该 SKU 商品页未返回可用的前台售价；请确认商品仍在售',
        evidence: { visibleCardPrice, visiblePrice },
      };
    }
    return {
      ok: true,
      rubPrice: selected.rubPrice,
      cnyPrice: selected.cnyPrice,
      evidence: {
        basis: 'webAspects.variant.price + data.price',
        widgetKey: selected.widgetKey,
        rubPath: 'variant.price',
        cnyPath: 'variant.data.price',
        visibleCardPrice,
        visiblePrice,
        active: selected.active,
        availability: selected.availability,
      },
    };
  }

  globalScope.JzFxProbe = Object.freeze({
    detectCurrency,
    extractFrontendPricePair,
    parseMoney,
    parseWidgetState,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
