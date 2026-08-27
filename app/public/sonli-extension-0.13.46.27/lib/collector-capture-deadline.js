(function (root) {
  'use strict';

  const DEFAULT_TIMEOUT_MS = 30_000;
  const MAX_DEADLINE_STAGE_MS = 6_000;
  const RESULT_RESERVE_MS = 1_500;
  const MIN_STAGE_MS = 1_000;

  const timeoutError = () => Object.assign(
    new Error('Ozon 商品资料补全请求超时'),
    { code: 'OZON_ENRICH_UPSTREAM_FAILED' },
  );

  const portalRequestOptions = ({ deadlineAt, now = Date.now() } = {}) => {
    const normalizedDeadline = Number(deadlineAt);
    if (!Number.isFinite(normalizedDeadline)) {
      return {
        timeoutMs: DEFAULT_TIMEOUT_MS,
        allowOzonTab: true,
        singleStrategy: false,
      };
    }
    const available = Math.floor(normalizedDeadline - Number(now) - RESULT_RESERVE_MS);
    if (available < MIN_STAGE_MS) throw timeoutError();
    return {
      timeoutMs: Math.min(MAX_DEADLINE_STAGE_MS, available),
      allowOzonTab: false,
      singleStrategy: true,
    };
  };

  const api = Object.freeze({ portalRequestOptions });
  root.JzCollectorCaptureDeadline = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
