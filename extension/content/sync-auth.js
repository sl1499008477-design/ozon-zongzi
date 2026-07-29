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
  let activeRequestId = '';
  let attempts = 0;
  let exchangeInFlight = false;

  const newRequestId = () => {
    try {
      return `collector-${crypto.randomUUID()}`;
    } catch {
      return `collector-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
  };

  const requestTicket = () => {
    if (exchangeInFlight || attempts >= MAX_TICKET_EXCHANGE_ATTEMPTS) return;
    activeRequestId = newRequestId();
    const message = policy.createCollectorAuthRequest(activeRequestId);
    window.postMessage(message, window.location.origin);
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
      || exchangeInFlight
    ) {
      return;
    }
    const response = policy.normalizeCollectorAuthResponse(event.data, activeRequestId);
    if (!response) return;
    attempts += 1;
    exchangeInFlight = true;
    const result = await sendExchange(response);
    exchangeInFlight = false;
    if (
      result?.ok === false
      && result?.code === 'COLLECTOR_TICKET_EXPIRED'
      && attempts < MAX_TICKET_EXCHANGE_ATTEMPTS
    ) {
      requestTicket();
    }
  });

  try {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.action !== 'collector.auth.request') return false;
      attempts = 0;
      requestTicket();
      sendResponse({ ok: true, requested: true });
      return false;
    });
  } catch {}

  requestTicket();
  setTimeout(() => {
    if (attempts === 0 && !exchangeInFlight) requestTicket();
  }, 1000);
})();
