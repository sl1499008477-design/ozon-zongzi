/**
 * Trusted Web-page adapter for collector authentication.
 *
 * The page owns its Web login credential. This content script knows only a
 * one-time collector ticket and forwards that ticket to the service worker for
 * exchange. It never reads or writes Web localStorage.
 */
(() => {
  const policy = globalThis.JzWebBridgePolicy;
  if (!policy) return;

  const MAX_TICKET_EXCHANGE_ATTEMPTS = 2;
  const MAX_BRIDGE_REQUESTS = 10;
  const BRIDGE_RETRY_MS = 1000;
  let activeRequestId = '';
  let attempts = 0;
  let requestCount = 0;
  let exchangeInFlight = false;
  let authenticated = false;
  let retryTimer = null;

  const newRequestId = () => {
    try {
      return `collector-${crypto.randomUUID()}`;
    } catch {
      return `collector-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
  };

  const requestTicket = () => {
    if (
      authenticated
      || exchangeInFlight
      || attempts >= MAX_TICKET_EXCHANGE_ATTEMPTS
      || requestCount >= MAX_BRIDGE_REQUESTS
    ) return;
    requestCount += 1;
    activeRequestId = newRequestId();
    const message = policy.createCollectorAuthRequest(activeRequestId);
    window.postMessage(message, window.location.origin);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      requestTicket();
    }, BRIDGE_RETRY_MS);
  };

  const restartRequestCycle = () => {
    if (exchangeInFlight || authenticated) return false;
    clearTimeout(retryTimer);
    retryTimer = null;
    attempts = 0;
    requestCount = 0;
    requestTicket();
    return true;
  };

  const sendExchange = (response) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({
        portalProtocol: policy.COLLECTOR_AUTH_PROTOCOL,
        action: 'collector.auth.exchange',
        requestId: response.requestId,
        ticket: response.ticket,
        expiresAt: response.expiresAt,
      }, (result) => {
        void chrome.runtime.lastError;
        resolve(result || null);
      });
    } catch {
      resolve(null);
    }
  });

  window.addEventListener('message', async (event) => {
    if (
      event.source !== window
      || event.origin !== window.location.origin
    ) {
      return;
    }
    if (policy.normalizeCollectorAuthReady(event.data)) {
      restartRequestCycle();
      return;
    }
    if (exchangeInFlight) return;
    const response = policy.normalizeCollectorAuthResponse(event.data, activeRequestId);
    if (!response) return;
    clearTimeout(retryTimer);
    retryTimer = null;
    attempts += 1;
    exchangeInFlight = true;
    const result = await sendExchange(response);
    exchangeInFlight = false;
    if (result?.ok === true) {
      authenticated = true;
      return;
    }
    if (
      result?.ok === false
      && result?.code === 'COLLECTOR_TICKET_EXPIRED'
      && attempts < MAX_TICKET_EXCHANGE_ATTEMPTS
    ) {
      requestCount = 0;
      requestTicket();
    }
  });

  try {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.action !== 'collector.auth.request') return false;
      sendResponse({ ok: true, requested: restartRequestCycle() });
      return false;
    });
  } catch {}

  requestTicket();
})();
