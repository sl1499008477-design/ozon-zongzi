(function (root) {
  'use strict';

  const MAX_TICKET_EXCHANGE_ATTEMPTS = 2;
  const BRIDGE_RETRY_MS = 1000;
  const RESPONSE_WATCHDOG_MS = 30_000;

  const createCollectorAuthFlow = ({
    newRequestId,
    postRequest,
    beginGeneration,
    clearGeneration,
    exchangeTicket,
    setTimer,
    clearTimer,
  } = {}) => {
    for (const dependency of [
      newRequestId,
      postRequest,
      beginGeneration,
      clearGeneration,
      exchangeTicket,
      setTimer,
      clearTimer,
    ]) {
      if (typeof dependency !== 'function') {
        throw new TypeError('collector auth flow requires function dependencies');
      }
    }

    let desiredGenerationId = '';
    let desiredAccountIdHint = '';
    let activeRequest = null; // { requestId, generationId, accountIdHint, accepted, leaseExpiresAt }
    let lastHandledGenerationId = '';
    let pendingGenerationId = '';
    let attempts = 0;
    let exchangeInFlight = false;
    let authenticated = false;
    let retryTimer = null;
    let transitionTail = Promise.resolve();

    const cancelRetry = () => {
      if (retryTimer !== null) clearTimer(retryTimer);
      retryTimer = null;
    };

    const queueTransition = (operation) => {
      const transition = transitionTail.then(operation);
      transitionTail = transition.then(() => undefined, () => undefined);
      return transition;
    };

    const transitionSucceeded = (result) => result !== null && result?.ok !== false;

    const requestTicket = (generationId, accountIdHint, allowUnacceptedRetry = true) => {
      if (
        authenticated
        || exchangeInFlight
        || attempts >= MAX_TICKET_EXCHANGE_ATTEMPTS
      ) return false;
      if (generationId ? desiredGenerationId !== generationId : desiredGenerationId !== '') {
        return false;
      }
      const requestId = String(newRequestId() || '').trim();
      if (!requestId || requestId.length > 128) return false;
      const request = {
        requestId,
        generationId,
        accountIdHint,
        accepted: false,
        leaseExpiresAt: 0,
      };
      activeRequest = request;
      try {
        postRequest(requestId);
      } catch {
        if (activeRequest === request) activeRequest = null;
        return false;
      }
      cancelRetry();
      if (allowUnacceptedRetry) {
        retryTimer = setTimer(() => {
          retryTimer = null;
          if (activeRequest !== request || request.accepted) return;
          requestTicket(generationId, accountIdHint, false);
        }, BRIDGE_RETRY_MS);
      }
      return true;
    };

    const restartRequestCycle = (generationId, accountIdHint) => {
      cancelRetry();
      activeRequest = null;
      attempts = 0;
      authenticated = false;
      return requestTicket(generationId, accountIdHint);
    };

    const rollbackFailedBegin = (generationId) => {
      if (desiredGenerationId !== generationId) return;
      desiredGenerationId = '';
      desiredAccountIdHint = '';
      activeRequest = null;
      if (lastHandledGenerationId === generationId) lastHandledGenerationId = '';
      if (pendingGenerationId === generationId) pendingGenerationId = '';
      attempts = 0;
      authenticated = false;
      cancelRetry();
    };

    const waitForQueuedTransitions = async () => {
      let observedTail;
      do {
        observedTail = transitionTail;
        await observedTail;
      } while (observedTail !== transitionTail);
    };

    const processPendingGeneration = async () => {
      await waitForQueuedTransitions();
      const generationId = pendingGenerationId;
      if (!generationId || generationId !== desiredGenerationId || exchangeInFlight) {
        return false;
      }
      pendingGenerationId = '';
      return restartRequestCycle(generationId, desiredAccountIdHint);
    };

    const performExchange = async (message) => {
      if (exchangeInFlight) {
        if (desiredGenerationId) pendingGenerationId = desiredGenerationId;
        return { accepted: false, reason: 'exchange-in-flight' };
      }
      cancelRetry();
      activeRequest = null;
      attempts += 1;
      exchangeInFlight = true;
      let result = null;
      try {
        result = await exchangeTicket({
          requestId: message.requestId,
          generationId: message.generationId,
          ticket: message.ticket,
          expiresAt: message.expiresAt,
        });
      } catch {
        result = null;
      }
      const authenticatedCurrentGeneration = result?.ok === true
        && desiredGenerationId === message.generationId;
      if (authenticatedCurrentGeneration) authenticated = true;
      const retryExpiredTicket = result?.ok === false
        && result?.code === 'COLLECTOR_TICKET_EXPIRED'
        && attempts < MAX_TICKET_EXCHANGE_ATTEMPTS
        && desiredGenerationId === message.generationId;
      exchangeInFlight = false;
      if (pendingGenerationId) {
        await processPendingGeneration();
      } else if (retryExpiredTicket) {
        requestTicket(message.generationId, desiredAccountIdHint);
      }
      return {
        accepted: true,
        authenticated: authenticatedCurrentGeneration,
      };
    };

    const startDiscovery = () => {
      if (desiredGenerationId || exchangeInFlight) return { requested: false };
      return { requested: restartRequestCycle('', '') };
    };

    const handleReady = async (message) => {
      const generationId = String(message?.generationId || '');
      const accountIdHint = typeof message?.accountIdHint === 'string'
        && message.accountIdHint === message.accountIdHint.trim()
        && message.accountIdHint.length <= 128
        ? message.accountIdHint
        : '';
      if (!generationId) return { accepted: false, reason: 'invalid-generation' };
      if (
        generationId === lastHandledGenerationId
        && generationId === desiredGenerationId
      ) {
        return { accepted: false, reason: 'duplicate-generation' };
      }

      desiredGenerationId = generationId;
      desiredAccountIdHint = accountIdHint;
      lastHandledGenerationId = generationId;
      pendingGenerationId = generationId;
      authenticated = false;
      activeRequest = null;
      attempts = 0;
      cancelRetry();

      let result;
      try {
        result = await queueTransition(() => beginGeneration(
          generationId,
          accountIdHint || undefined,
        ));
      } catch {
        result = null;
      }
      if (desiredGenerationId !== generationId) {
        return { accepted: false, reason: 'stale-generation' };
      }
      if (!transitionSucceeded(result)) {
        rollbackFailedBegin(generationId);
        return { accepted: false, reason: 'begin-failed' };
      }
      if (exchangeInFlight) {
        pendingGenerationId = generationId;
        return { accepted: true, requested: false };
      }
      if (pendingGenerationId === generationId) pendingGenerationId = '';
      return {
        accepted: true,
        requested: restartRequestCycle(generationId, accountIdHint),
      };
    };

    const handleLogout = async (message) => {
      const generationId = String(message?.generationId || '');
      if (!generationId) return { accepted: false, reason: 'invalid-generation' };
      const matchingGeneration = generationId === desiredGenerationId;
      if (matchingGeneration) {
        desiredGenerationId = '';
        desiredAccountIdHint = '';
        activeRequest = null;
        lastHandledGenerationId = '';
        pendingGenerationId = '';
        attempts = 0;
        authenticated = false;
        cancelRetry();
      }
      let result;
      try {
        result = await queueTransition(() => clearGeneration(generationId));
      } catch {
        result = null;
      }
      if (!matchingGeneration) {
        return { accepted: false, reason: 'stale-generation' };
      }
      return { accepted: true, cleared: transitionSucceeded(result) };
    };

    const handleResponse = async (message) => {
      const request = activeRequest;
      if (!request || message?.requestId !== request.requestId) {
        return { accepted: false, reason: 'stale-request' };
      }
      if (!request.generationId) {
        if (desiredGenerationId) {
          return { accepted: false, reason: 'stale-generation' };
        }
        desiredGenerationId = message.generationId;
        desiredAccountIdHint = request.accountIdHint;
        lastHandledGenerationId = message.generationId;
        pendingGenerationId = message.generationId;
        cancelRetry();
        activeRequest = null;
        let result;
        try {
          result = await queueTransition(() => beginGeneration(message.generationId, undefined));
        } catch {
          result = null;
        }
        if (desiredGenerationId !== message.generationId) {
          return { accepted: false, reason: 'stale-generation' };
        }
        if (!transitionSucceeded(result)) {
          rollbackFailedBegin(message.generationId);
          return { accepted: false, reason: 'begin-failed' };
        }
        if (pendingGenerationId === message.generationId) pendingGenerationId = '';
        return performExchange(message);
      }
      if (
        request.generationId !== desiredGenerationId
        || message?.generationId !== request.generationId
      ) {
        return { accepted: false, reason: 'stale-generation' };
      }
      return performExchange(message);
    };

    const handleAccepted = (message) => {
      const request = activeRequest;
      if (!request || message?.requestId !== request.requestId) {
        return { accepted: false, reason: 'stale-request' };
      }
      if (
        request.generationId
        && (
          request.generationId !== desiredGenerationId
          || message?.generationId !== request.generationId
        )
      ) {
        return { accepted: false, reason: 'stale-generation' };
      }
      if (!request.generationId && desiredGenerationId) {
        return { accepted: false, reason: 'stale-generation' };
      }
      if (request.accepted) return { accepted: true };
      cancelRetry();
      request.accepted = true;
      request.leaseExpiresAt = Date.now() + RESPONSE_WATCHDOG_MS;
      retryTimer = setTimer(() => {
        retryTimer = null;
        if (activeRequest !== request || !request.accepted) return;
        requestTicket(request.generationId, request.accountIdHint);
      }, RESPONSE_WATCHDOG_MS);
      return { accepted: true };
    };

    const requestAuthoritatively = () => {
      if (exchangeInFlight) return { requested: false };
      if (pendingGenerationId && pendingGenerationId === desiredGenerationId) {
        return { requested: false };
      }
      cancelRetry();
      desiredGenerationId = '';
      desiredAccountIdHint = '';
      lastHandledGenerationId = '';
      pendingGenerationId = '';
      activeRequest = null;
      attempts = 0;
      authenticated = false;
      return startDiscovery();
    };

    return Object.freeze({
      startDiscovery,
      handleAccepted,
      handleReady,
      handleLogout,
      handleResponse,
      requestAuthoritatively,
    });
  };

  const api = Object.freeze({ createCollectorAuthFlow });
  root.JzCollectorAuthFlow = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
