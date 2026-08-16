/**
 * Trusted Web-page adapter for collector authentication.
 *
 * The page owns its Web login credential. This content script accepts only
 * normalized generation messages and forwards one-time collector tickets to
 * the service worker. Authentication-cycle state lives in collector-auth-flow.
 */
(() => {
  const INSTALL_GUARD = '__JZ_COLLECTOR_SYNC_AUTH_INSTALLED__';
  if (globalThis[INSTALL_GUARD]) return;
  const policy = globalThis.JzWebBridgePolicy;
  const collectorAuthFlow = globalThis.JzCollectorAuthFlow;
  if (!policy || !collectorAuthFlow) return;
  globalThis[INSTALL_GUARD] = true;

  const newRequestId = () => {
    try {
      return `collector-${crypto.randomUUID()}`;
    } catch {
      return `collector-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
  };

  const sendRuntime = (action, fields) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({
        portalProtocol: policy.COLLECTOR_AUTH_PROTOCOL,
        action,
        ...fields,
      }, (result) => {
        void chrome.runtime.lastError;
        resolve(result || null);
      });
    } catch {
      resolve(null);
    }
  });

  const flow = collectorAuthFlow.createCollectorAuthFlow({
    newRequestId,
    postRequest: (requestId) => window.postMessage(
      policy.createCollectorAuthRequest(requestId),
      window.location.origin,
    ),
    beginGeneration: (generationId, accountIdHint) => sendRuntime('collector.auth.begin', {
      generationId,
      ...(accountIdHint ? { accountIdHint } : {}),
    }),
    clearGeneration: (generationId) => sendRuntime('collector.auth.logout', {
      generationId,
    }),
    exchangeTicket: ({ requestId, generationId, ticket, expiresAt }) => sendRuntime(
      'collector.auth.exchange',
      { requestId, generationId, ticket, expiresAt },
    ),
    setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimer: (timer) => clearTimeout(timer),
  });

  window.addEventListener('message', async (event) => {
    if (
      event.source !== window
      || event.origin !== window.location.origin
    ) return;

    const readyV2 = policy.normalizeCollectorAuthReadyV2(event.data);
    if (readyV2) {
      await flow.handleReady(readyV2);
      return;
    }
    const ready = policy.normalizeCollectorAuthReady(event.data);
    if (ready) {
      await flow.handleReady(ready);
      return;
    }
    const logout = policy.normalizeCollectorAuthLogout(event.data);
    if (logout) {
      await flow.handleLogout(logout);
      return;
    }
    const accepted = policy.normalizeCollectorAuthAccepted(event.data);
    if (accepted) {
      flow.handleAccepted(accepted);
      return;
    }
    const response = policy.normalizeCollectorAuthResponse(event.data);
    if (response) await flow.handleResponse(response);
  });

  try {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.action !== 'collector.auth.request') return false;
      const { requested } = flow.requestAuthoritatively();
      sendResponse({ ok: true, requested });
      return false;
    });
  } catch {}

  flow.startDiscovery();
})();
