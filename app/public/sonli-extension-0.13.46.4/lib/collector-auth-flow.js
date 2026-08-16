(function (root) {
  'use strict';

  const REQUEST_PATTERN = /^collector-[A-Za-z0-9-]+$/;
  const GENERATION_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

  const safeRequestId = (value) => (
    typeof value === 'string'
    && value.length <= 128
    && REQUEST_PATTERN.test(value)
      ? value
      : ''
  );
  const safeGenerationId = (value) => (
    typeof value === 'string' && GENERATION_PATTERN.test(value) ? value : ''
  );
  const safeAccountIdHint = (value) => (
    typeof value === 'string'
    && value === value.trim()
    && value.length <= 128
      ? value
      : ''
  );

  const createCollectorAuthFlow = ({
    postRequest,
    beginGeneration,
    clearGeneration,
    exchangeTicket,
    failAuthentication,
  } = {}) => {
    for (const dependency of [
      postRequest,
      beginGeneration,
      clearGeneration,
      exchangeTicket,
      failAuthentication,
    ]) {
      if (typeof dependency !== 'function') {
        throw new TypeError('collector auth flow requires function dependencies');
      }
    }

    let activeRequest = null;
    let exchangeInFlight = false;
    let transitionTail = Promise.resolve();

    const queueTransition = (operation) => {
      const transition = transitionTail.then(operation);
      transitionTail = transition.then(() => undefined, () => undefined);
      return transition;
    };
    const transitionSucceeded = (result) => result !== null && result?.ok !== false;
    const transitionAuthenticated = (result) => (
      result?.authenticated === true || result?.data?.authenticated === true
    );

    const postSelectedRequest = (request) => {
      if (request.posted) return true;
      try {
        postRequest(request.requestId);
        request.posted = true;
        return true;
      } catch {
        if (activeRequest === request) activeRequest = null;
        return false;
      }
    };

    const adoptGeneration = async (request, generationId, accountIdHint = '') => {
      let result = null;
      try {
        result = await queueTransition(() => beginGeneration(
          generationId,
          accountIdHint || undefined,
          request.requestId,
        ));
      } catch {}
      if (activeRequest !== request) {
        return { accepted: false, reason: 'stale-request' };
      }
      if (!transitionSucceeded(result)) {
        activeRequest = null;
        return { accepted: false, reason: 'begin-failed' };
      }
      request.generationId = generationId;
      request.accountIdHint = accountIdHint;
      return {
        accepted: true,
        authenticated: transitionAuthenticated(result),
      };
    };

    const handleReady = async (message) => {
      const request = activeRequest;
      const generationId = safeGenerationId(message?.generationId);
      if (!request) return { accepted: false, reason: 'stale-request' };
      if (!generationId) return { accepted: false, reason: 'invalid-generation' };
      if (exchangeInFlight) return { accepted: false, reason: 'exchange-in-flight' };
      if (request.generationId) {
        return {
          accepted: false,
          reason: request.generationId === generationId
            ? 'duplicate-generation'
            : 'stale-generation',
        };
      }
      const accountIdHint = safeAccountIdHint(message?.accountIdHint);
      const adopted = await adoptGeneration(request, generationId, accountIdHint);
      if (!adopted.accepted) return adopted;
      if (adopted.authenticated) {
        activeRequest = null;
        return { accepted: true, requested: false, authenticated: true };
      }
      return {
        accepted: true,
        requested: postSelectedRequest(request),
        requestId: request.requestId,
      };
    };

    const handleAccepted = (message) => {
      const request = activeRequest;
      if (!request || safeRequestId(message?.requestId) !== request.requestId) {
        return { accepted: false, reason: 'stale-request' };
      }
      const generationId = safeGenerationId(message?.generationId);
      if (!generationId || (request.generationId && request.generationId !== generationId)) {
        return { accepted: false, reason: 'stale-generation' };
      }
      return { accepted: true };
    };

    const handleFailure = async (message) => {
      const request = activeRequest;
      if (!request || safeRequestId(message?.requestId) !== request.requestId) {
        return { accepted: false, reason: 'stale-request' };
      }
      const generationId = safeGenerationId(message?.generationId);
      if (!generationId || (request.generationId && request.generationId !== generationId)) {
        return { accepted: false, reason: 'stale-generation' };
      }
      activeRequest = null;
      await failAuthentication({
        requestId: request.requestId,
        generationId,
        publicCode: message.publicCode,
      });
      return { accepted: true };
    };

    const handleResponse = async (message) => {
      const request = activeRequest;
      if (!request || safeRequestId(message?.requestId) !== request.requestId) {
        return { accepted: false, reason: 'stale-request' };
      }
      const generationId = safeGenerationId(message?.generationId);
      if (!generationId || (request.generationId && request.generationId !== generationId)) {
        return { accepted: false, reason: 'stale-generation' };
      }
      if (exchangeInFlight) return { accepted: false, reason: 'exchange-in-flight' };
      if (!request.generationId) {
        const adopted = await adoptGeneration(
          request,
          generationId,
          request.accountIdHint,
        );
        if (!adopted.accepted) return adopted;
        if (adopted.authenticated) {
          activeRequest = null;
          return { accepted: true, authenticated: true };
        }
      }
      exchangeInFlight = true;
      let result = null;
      try {
        result = await exchangeTicket({
          requestId: request.requestId,
          generationId,
          ticket: message.ticket,
          expiresAt: message.expiresAt,
        });
      } catch {}
      exchangeInFlight = false;
      if (activeRequest === request) activeRequest = null;
      return {
        accepted: true,
        authenticated: result?.ok === true,
      };
    };

    const handleLogout = async (message) => {
      const generationId = safeGenerationId(message?.generationId);
      if (!generationId) return { accepted: false, reason: 'invalid-generation' };
      const matching = activeRequest?.generationId === generationId;
      if (matching) activeRequest = null;
      let result = null;
      try { result = await queueTransition(() => clearGeneration(generationId)); } catch {}
      return matching
        ? { accepted: true, cleared: transitionSucceeded(result) }
        : { accepted: false, reason: 'stale-generation' };
    };

    const requestAuthoritatively = (requestId, accountIdHint, readyMessage) => {
      const normalized = safeRequestId(requestId);
      if (!normalized || exchangeInFlight) return { requested: false, requestId: normalized };
      const request = {
        requestId: normalized,
        generationId: '',
        accountIdHint: safeAccountIdHint(accountIdHint),
        posted: false,
      };
      activeRequest = request;
      if (readyMessage) return handleReady(readyMessage);
      return {
        requested: postSelectedRequest(request),
        requestId: normalized,
      };
    };

    return Object.freeze({
      startDiscovery: () => ({ requested: false, requestId: '' }),
      handleAccepted,
      handleFailure,
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
