// Rates have six decimal places; a one-token charge can have twelve.
const unit = 1_000_000n;
const decimal = (value, places) => {
  const digits = value.toString().padStart(places + 1, '0');
  return `${digits.slice(0, -places)}.${digits.slice(-places)}`.replace(/\.?0+$/, '');
};
const rateUnits = value => {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * unit + BigInt(fraction.padEnd(6, '0'));
};

export function normalizeChannelPricing(input) {
  if (input == null) return null;
  const fail = () => { throw Object.assign(new Error('请选择计价方式和币种，并填写非负单价（最多6位小数）。'), {code:'INVALID_CHANNEL_PRICING',statusCode:400}); };
  if (!['REQUEST','TOKEN'].includes(input.mode) || !['CNY','USD'].includes(input.currency)) fail();
  const result = {mode:input.mode,currency:input.currency};
  for (const key of input.mode === 'REQUEST' ? ['requestPrice'] : ['inputPrice','outputPrice']) {
    const value = String(input[key] ?? '').trim();
    if (!/^\d{1,9}(\.\d{1,6})?$/.test(value)) fail();
    result[key] = decimal(rateUnits(value), 6);
  }
  return result;
}

export function estimateChannelCost(pricing, usage) {
  if (!pricing) return null;
  if (pricing.mode === 'REQUEST') return pricing.requestPrice;
  if (!Number.isSafeInteger(usage?.inputTokens) || usage.inputTokens < 0 ||
      !Number.isSafeInteger(usage?.outputTokens) || usage.outputTokens < 0) return null;
  return decimal(rateUnits(pricing.inputPrice) * BigInt(usage.inputTokens) + rateUnits(pricing.outputPrice) * BigInt(usage.outputTokens), 12);
}

export function sampleChannelPricing(report) {
  if (report?.currency !== 'CNY' || report.quotaPerYuan !== 500000 || !Number.isSafeInteger(report.latestQuota) || report.latestQuota < 0) return null;
  return {mode:'REQUEST',currency:'CNY',requestPrice:decimal(BigInt(report.latestQuota) * 2n,6),source:'PRICE_SAMPLE',checkedAt:report.checkedAt};
}
