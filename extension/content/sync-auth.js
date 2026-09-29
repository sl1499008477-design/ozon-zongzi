/**
 * Trusted Web-page adapter for collector authentication.
 *
 * The page owns its Web login credential. This content script accepts only
 * normalized generation messages and forwards one-time collector tickets to
 * the service worker. Authentication-cycle state lives in collector-auth-flow.
 */
(() => {
  const isTrustedCollectorAuthOrigin = (value) => {
    if (value === 'https://www.ozonzongzi.com') return true;
    return [
      'http://localhost:3000',
      'https://www.ozonzongzi.com',
      'http://store.localhost:3000',
    ].includes(value);
  };
  if (!isTrustedCollectorAuthOrigin(window.location.origin)) return;
  const INSTALL_GUARD = '__JZ_COLLECTOR_SYNC_AUTH_INSTALLED__';
  if (globalThis[INSTALL_GUARD]) return;
  const policy = globalThis.JzWebBridgePolicy;
  const collectorAuthFlow = globalThis.JzCollectorAuthFlow;
  if (!policy || !collectorAuthFlow) return;
  globalThis[INSTALL_GUARD] = true;

  const isCanonicalRequestId = (requestId) => (
    typeof requestId === 'string'
    && /^collector-[a-zA-Z0-9-]+$/.test(requestId)
    && requestId.length <= 128
  );
  let selectedByWorker = false;
  let selectedRequestPending = false;
  let latestReady = null;

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

  const forwardAccepted = ({ protocol, action, requestId, generationId }) => new Promise(
    (resolve) => {
      try {
        chrome.runtime.sendMessage({ protocol, action, requestId, generationId }, (result) => {
          void chrome.runtime.lastError;
          resolve(result || null);
        });
      } catch {
        resolve(null);
      }
    },
  );

  const flow = collectorAuthFlow.createCollectorAuthFlow({
    postRequest: (requestId) => window.postMessage(
      policy.createCollectorAuthRequest(requestId),
      window.location.origin,
    ),
    beginGeneration: (generationId, accountIdHint, requestId) => sendRuntime('collector.auth.begin', {
      requestId,
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
    failAuthentication: ({ requestId, generationId, publicCode }) => sendRuntime(
      'collector.auth.failure',
      { requestId, generationId, publicCode },
    ),
  });

  window.addEventListener('message', async (event) => {
    if (
      event.source !== window
      || event.origin !== window.location.origin
    ) return;

    const readyV2 = policy.normalizeCollectorAuthReadyV2(event.data);
    if (readyV2) {
      if (!selectedByWorker || selectedRequestPending) {
        latestReady = readyV2;
        return;
      }
      await flow.handleReady(readyV2);
      return;
    }
    const ready = policy.normalizeCollectorAuthReady(event.data);
    if (ready) {
      if (!selectedByWorker || selectedRequestPending) {
        if (
          !latestReady
          || latestReady.generationId !== ready.generationId
          || !latestReady.accountIdHint
        ) latestReady = ready;
        return;
      }
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
      const outcome = flow.handleAccepted(accepted);
      if (outcome?.accepted === true) void forwardAccepted(accepted);
      return;
    }
    const failure = policy.normalizeCollectorAuthFailure(event.data);
    if (failure) {
      selectedRequestPending = false;
      if (latestReady?.generationId === failure.generationId) latestReady = null;
      await flow.handleFailure(failure);
      return;
    }
    const response = policy.normalizeCollectorAuthResponse(event.data);
    if (response) {
      selectedRequestPending = false;
      if (latestReady?.generationId === response.generationId) latestReady = null;
      await flow.handleResponse(response);
    }
  });

  try {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.action !== 'collector.auth.request') return false;
      if (!isCanonicalRequestId(message.requestId)) {
        sendResponse({ ok: false, requested: false, requestId: '' });
        return false;
      }
      selectedByWorker = true;
      const readyForSelection = latestReady;
      latestReady = null;
      if (!readyForSelection) {
        const { requested } = flow.requestAuthoritatively(message.requestId);
        selectedRequestPending = requested;
        sendResponse({ ok: true, requested, requestId: message.requestId });
        return false;
      }
      void Promise.resolve(flow.requestAuthoritatively(
        message.requestId,
        readyForSelection.accountIdHint,
        readyForSelection,
      )).then((outcome) => {
        const requested = outcome?.requested === true || outcome?.authenticated === true;
        selectedRequestPending = outcome?.requested === true;
        sendResponse({ ok: true, requested, requestId: message.requestId });
      }).catch(() => {
        selectedRequestPending = false;
        sendResponse({ ok: true, requested: false, requestId: message.requestId });
      });
      return true;
    });
  } catch {}
})();
