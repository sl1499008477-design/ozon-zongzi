(function (root) {
  'use strict';

  // A scheduling budget is not evidence that a source request failed.
  // Zero explicitly disables application-imposed request cancellation.
  const portalRequestOptions = ({ automaticCapture = false, deadlineAt } = {}) => ({
    timeoutMs: 0,
    allowOzonTab: false,
    singleStrategy: automaticCapture || Number.isFinite(Number(deadlineAt)),
  });

  const api = Object.freeze({ portalRequestOptions });
  root.JzCollectorCaptureDeadline = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
