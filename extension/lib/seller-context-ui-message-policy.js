(function (root) {
  'use strict';

  const STATUS = Object.freeze({
    READY: 'READY',
    RECOVERING: 'RECOVERING',
    LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  });
  const ACTIONS = new Set(['getSellerContextStatus', 'openSellerLogin']);
  const OZONE_PANEL_ORIGINS = new Set(['https://www.ozon.ru', 'https://ozon.ru']);
  const normalizeCompanyId = (value) => {
    const normalized = String(value == null ? '' : value).trim();
    return /^\d{4,15}$/.test(normalized) ? normalized : '';
  };
  const isExactAction = (message) => (
    message
    && typeof message === 'object'
    && !Array.isArray(message)
    && Object.keys(message).length === 1
    && ACTIONS.has(message.action)
  );
  const senderUrl = (sender) => String(sender?.url || '');
  const isPopupSender = (sender, extensionId) => (
    sender?.id === extensionId
    && !sender?.tab
    && senderUrl(sender) === `chrome-extension://${extensionId}/popup/popup.html`
  );
  const isOzonPanelSender = (sender, extensionId) => {
    if (sender?.id !== extensionId || Number(sender?.frameId) !== 0 || !sender?.tab) return false;
    try {
      const page = new URL(senderUrl(sender));
      const tab = new URL(String(sender.tab.url || ''));
      return OZONE_PANEL_ORIGINS.has(page.origin)
        && page.href === tab.href
        && OZONE_PANEL_ORIGINS.has(tab.origin);
    } catch {
      return false;
    }
  };
  const isAllowedSellerContextUiMessage = (message, sender, extensionId) => (
    isExactAction(message)
    && (isPopupSender(sender, extensionId) || isOzonPanelSender(sender, extensionId))
  );
  const projectSellerContextStatus = (context) => {
    if (context?.status === STATUS.RECOVERING) return { status: STATUS.RECOVERING };
    if (context?.status !== STATUS.READY) return { status: STATUS.LOGIN_REQUIRED };
    const companyId = normalizeCompanyId(context.companyId);
    const observedAt = Number(context.observedAt);
    if (!companyId || !Number.isFinite(observedAt)) return { status: STATUS.LOGIN_REQUIRED };
    return { status: STATUS.READY, companyId, observedAt };
  };
  const createSingleFlight = (operation) => {
    let pending = null;
    return () => {
      if (!pending) {
        try {
          pending = Promise.resolve(operation())
          .finally(() => { pending = null; });
        } catch (error) {
          pending = Promise.reject(error).finally(() => { pending = null; });
        }
      }
      return pending;
    };
  };

  const api = Object.freeze({
    STATUS,
    createSingleFlight,
    isAllowedSellerContextUiMessage,
    projectSellerContextStatus,
  });
  root.JzSellerContextUiMessagePolicy = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
