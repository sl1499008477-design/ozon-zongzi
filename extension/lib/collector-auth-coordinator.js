(function (root) {
  'use strict';

  const COLLECTOR_AUTH_STATUS_STORAGE_KEY = 'sonliCollectorAuthStatus';
  const COLLECTOR_AUTH_RETRY_ALARM = 'collectorAuthRetry';
  const RETRY_BASE_DELAYS_MS = Object.freeze([1_000, 2_000, 5_000, 10_000, 30_000]);
  const MAX_RETRY_DELAY_MS = 30_000;
  const JITTER_RATIO = 0.1;
  const DISCOVERY_GENERATION_ID = 'collector_discovery_pending';
  const GENERATION_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
  const PUBLIC_PHASES = new Set([
    'WAITING_FOR_WEB',
    'DISCOVERING_WEB',
    'REQUESTING_TICKET',
    'EXCHANGING',
    'RETRY_WAIT',
    'AUTHENTICATED',
    'ACTION_REQUIRED',
  ]);
  const PUBLIC_CODES = new Set([
    '',
    'WEB_LOGIN_REQUIRED',
    'WEB_TAB_UNAVAILABLE',
    'LOCAL_SERVICE_UNAVAILABLE',
    'ACCOUNT_DISABLED',
    'ACCOUNT_EXPIRED',
    'PERMISSION_DENIED',
    'TRUST_BOUNDARY_REJECTED',
    'SERVER_UPGRADE_REQUIRED',
  ]);
  const WAITING_CODES = new Set(['', 'WEB_LOGIN_REQUIRED', 'WEB_TAB_UNAVAILABLE']);
  const ACTION_CODES = new Set([
    'ACCOUNT_DISABLED',
    'ACCOUNT_EXPIRED',
    'PERMISSION_DENIED',
    'TRUST_BOUNDARY_REJECTED',
    'SERVER_UPGRADE_REQUIRED',
  ]);
  const SENSITIVE_VALUE_PATTERN = /(?:ctt|cst|csess)_[A-Za-z0-9_-]+|bearer\s+|authorization|fingerprint/i;
  const WEB_LOGIN_CODES = new Set([
    'WEB_AUTH_REQUIRED',
    'WEB_LOGIN_REQUIRED',
    'COLLECTOR_AUTH_REQUIRED',
    'COLLECTOR_PARENT_SESSION_REVOKED',
    'COLLECTOR_SESSION_REVOKED',
  ]);
  const TRANSIENT_CODES = new Set([
    'LOCAL_SERVICE_UNAVAILABLE',
    'COLLECTOR_EXCHANGE_NETWORK_ERROR',
    'COLLECTOR_REQUEST_ABORTED',
    'COLLECTOR_AUTH_PERSISTENCE_FAILED',
  ]);
  const ACCOUNT_DISABLED_CODES = new Set([
    'ACCOUNT_DISABLED',
    'COLLECTOR_ACCOUNT_DISABLED',
    'COLLECTOR_ACCOUNT_INACTIVE',
    'COLLECTOR_ACCOUNT_UNAVAILABLE',
  ]);
  const ACCOUNT_EXPIRED_CODES = new Set([
    'ACCOUNT_EXPIRED',
    'COLLECTOR_ACCOUNT_EXPIRED',
    'COLLECTOR_PARENT_SESSION_EXPIRED',
  ]);
  const PERMISSION_CODES = new Set([
    'PERMISSION_DENIED',
    'COLLECTOR_PERMISSION_DENIED',
  ]);
  const TRUST_CODES = new Set([
    'TRUST_BOUNDARY_REJECTED',
    'PORTAL_BRIDGE_FORBIDDEN',
    'WEB_BRIDGE_FORBIDDEN',
    'COLLECTOR_AUTH_GENERATION_INVALID',
    'COLLECTOR_AUTH_GENERATION_CHANGED',
    'COLLECTOR_AUTH_INCARNATION_INVALID',
    'COLLECTOR_SESSION_CHANGED',
  ]);
  const VERSION_CODES = new Set([
    'SERVER_UPGRADE_REQUIRED',
    'COLLECTOR_AUTH_CONTRACT_UNSUPPORTED',
    'COLLECTOR_SERVER_UPGRADE_REQUIRED',
    'COLLECTOR_AUTH_RESPONSE_INVALID',
    'COLLECTOR_TICKET_EXPIRED',
    'COLLECTOR_TICKET_USED',
    'COLLECTOR_TICKET_INVALID',
  ]);

  const defaultStatus = () => ({
    version: 1,
    phase: 'WAITING_FOR_WEB',
    generationId: '',
    startedAt: '',
    updatedAt: '',
    attemptNumber: 0,
    nextRetryAt: '',
    publicCode: '',
    account: null,
    expiresAt: '',
  });

  const safeIso = (value) => {
    if (typeof value !== 'string' || !value || SENSITIVE_VALUE_PATTERN.test(value)) return '';
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
  };

  const safeGenerationId = (value) => {
    if (typeof value !== 'string' || !GENERATION_PATTERN.test(value)) return '';
    return SENSITIVE_VALUE_PATTERN.test(value) ? '' : value;
  };

  const safeAccountText = (value, { required = false } = {}) => {
    if (typeof value !== 'string') return '';
    const normalized = value.trim();
    if (
      normalized !== value
      || normalized.length > 128
      || SENSITIVE_VALUE_PATTERN.test(normalized)
      || (required && !normalized)
    ) return '';
    return normalized;
  };

  const safeAccount = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const id = safeAccountText(value.id, { required: true });
    if (!id) return null;
    return {
      id,
      displayName: safeAccountText(value.displayName),
    };
  };

  const projectStatus = (value, currentTime = Date.now()) => {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const attempt = Number(source.attemptNumber);
    const status = {
      version: 1,
      phase: PUBLIC_PHASES.has(source.phase) ? source.phase : 'WAITING_FOR_WEB',
      generationId: safeGenerationId(source.generationId),
      startedAt: safeIso(source.startedAt),
      updatedAt: safeIso(source.updatedAt),
      attemptNumber: Number.isSafeInteger(attempt) && attempt >= 0 ? attempt : 0,
      nextRetryAt: safeIso(source.nextRetryAt),
      publicCode: PUBLIC_CODES.has(source.publicCode) ? source.publicCode : '',
      account: safeAccount(source.account),
      expiresAt: safeIso(source.expiresAt),
    };
    const withoutCredentials = (phase, publicCode) => ({
      ...status,
      phase,
      nextRetryAt: '',
      publicCode,
      account: null,
      expiresAt: '',
    });
    if (status.phase === 'WAITING_FOR_WEB') {
      return withoutCredentials(
        'WAITING_FOR_WEB',
        WAITING_CODES.has(status.publicCode) ? status.publicCode : '',
      );
    }
    if (status.phase === 'ACTION_REQUIRED') {
      return withoutCredentials(
        'ACTION_REQUIRED',
        ACTION_CODES.has(status.publicCode) ? status.publicCode : 'SERVER_UPGRADE_REQUIRED',
      );
    }
    if (status.phase === 'AUTHENTICATED') {
      if (
        !status.account
        || !status.expiresAt
        || Date.parse(status.expiresAt) <= Number(currentTime)
      ) return withoutCredentials('WAITING_FOR_WEB', 'WEB_LOGIN_REQUIRED');
      return {
        ...status,
        nextRetryAt: '',
        publicCode: '',
      };
    }
    if (!status.generationId) {
      return withoutCredentials('ACTION_REQUIRED', 'TRUST_BOUNDARY_REJECTED');
    }
    if (!status.startedAt || !status.updatedAt) {
      return withoutCredentials('ACTION_REQUIRED', 'SERVER_UPGRADE_REQUIRED');
    }
    if (status.phase === 'RETRY_WAIT') {
      if (
        status.attemptNumber < 1
        || status.publicCode !== 'LOCAL_SERVICE_UNAVAILABLE'
        || !status.nextRetryAt
      ) return withoutCredentials('ACTION_REQUIRED', 'SERVER_UPGRADE_REQUIRED');
      return {
        ...status,
        account: null,
        expiresAt: '',
      };
    }
    return withoutCredentials(status.phase, '');
  };

  const errorFacts = (error) => {
    const source = error && typeof error === 'object' ? error : {};
    const code = typeof source.code === 'string' ? source.code.trim().toUpperCase() : '';
    const status = typeof source.status === 'number' || typeof source.status === 'string'
      ? Number(source.status)
      : 0;
    const name = typeof source.name === 'string' ? source.name : '';
    return {
      code,
      status: Number.isFinite(status) ? status : 0,
      aborted: name === 'AbortError' || name === 'TimeoutError',
    };
  };

  const classifyFailure = (error) => {
    const { code, status, aborted } = errorFacts(error);
    if (WEB_LOGIN_CODES.has(code)) {
      return { phase: 'WAITING_FOR_WEB', publicCode: 'WEB_LOGIN_REQUIRED', retry: false };
    }
    if (code === 'WEB_TAB_UNAVAILABLE') {
      return { phase: 'WAITING_FOR_WEB', publicCode: 'WEB_TAB_UNAVAILABLE', retry: false };
    }
    if (ACCOUNT_DISABLED_CODES.has(code)) {
      return { phase: 'ACTION_REQUIRED', publicCode: 'ACCOUNT_DISABLED', retry: false };
    }
    if (ACCOUNT_EXPIRED_CODES.has(code)) {
      return { phase: 'ACTION_REQUIRED', publicCode: 'ACCOUNT_EXPIRED', retry: false };
    }
    if (TRUST_CODES.has(code)) {
      return { phase: 'ACTION_REQUIRED', publicCode: 'TRUST_BOUNDARY_REJECTED', retry: false };
    }
    if (VERSION_CODES.has(code) || status === 426) {
      return { phase: 'ACTION_REQUIRED', publicCode: 'SERVER_UPGRADE_REQUIRED', retry: false };
    }
    if (PERMISSION_CODES.has(code) || status === 403) {
      return { phase: 'ACTION_REQUIRED', publicCode: 'PERMISSION_DENIED', retry: false };
    }
    if (
      TRANSIENT_CODES.has(code)
      || aborted
      || status === 408
      || status === 425
      || status === 429
      || status >= 500
    ) {
      return { phase: 'RETRY_WAIT', publicCode: 'LOCAL_SERVICE_UNAVAILABLE', retry: true };
    }
    return { phase: 'ACTION_REQUIRED', publicCode: 'SERVER_UPGRADE_REQUIRED', retry: false };
  };

  function createCollectorAuthCoordinator({
    storageSession = root.chrome?.storage?.session,
    alarms = root.chrome?.alarms,
    now = () => Date.now(),
    random = () => Math.random(),
    requestAuth,
    getSession = async () => null,
    setTimer = root.setTimeout?.bind(root),
    clearTimer = root.clearTimeout?.bind(root),
  } = {}) {
    if (!storageSession || typeof storageSession.get !== 'function'
      || typeof storageSession.set !== 'function') {
      throw new TypeError('collector auth coordinator requires chrome.storage.session');
    }
    if (!alarms || typeof alarms.create !== 'function') {
      throw new TypeError('collector auth coordinator requires chrome.alarms');
    }
    if (typeof requestAuth !== 'function') {
      throw new TypeError('collector auth coordinator requires requestAuth');
    }
    if (typeof getSession !== 'function') {
      throw new TypeError('collector auth coordinator requires getSession');
    }
    if (typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
      throw new TypeError('collector auth coordinator requires timer functions');
    }

    let operationPromise = null;
    let activeRequestGenerationId = null;
    let requestFence = 0;
    let retryTimer = null;
    let statusMutationTail = Promise.resolve();

    const serializeStatusMutation = (operation) => {
      const run = statusMutationTail.then(operation, operation);
      statusMutationTail = run.catch(() => {});
      return run;
    };

    const currentIso = () => new Date(Number(now())).toISOString();
    const clearRetryAlarm = async () => {
      if (typeof alarms.clear !== 'function') return;
      try { await alarms.clear(COLLECTOR_AUTH_RETRY_ALARM); } catch {}
    };
    const clearRetrySchedule = async () => {
      if (retryTimer !== null) {
        try { clearTimer(retryTimer); } catch {}
        retryTimer = null;
      }
      await clearRetryAlarm();
    };
    const scheduleRetry = async (when) => {
      await clearRetrySchedule();
      const currentTime = Number(now());
      const delay = Math.max(0, when - currentTime);
      if (delay < 30_000) {
        retryTimer = setTimer(
          () => Promise.resolve().then(() => resume()).catch(() => null),
          delay,
        );
      }
      await Promise.resolve(alarms.create(COLLECTOR_AUTH_RETRY_ALARM, {
        when: Math.max(when, currentTime + 30_000),
      }));
    };
    const readStatus = async () => {
      const stored = await storageSession.get(COLLECTOR_AUTH_STATUS_STORAGE_KEY);
      const raw = stored?.[COLLECTOR_AUTH_STATUS_STORAGE_KEY];
      const status = raw === undefined ? defaultStatus() : projectStatus(raw, Number(now()));
      if (raw !== undefined && JSON.stringify(raw) !== JSON.stringify(status)) {
        await storageSession.set({ [COLLECTOR_AUTH_STATUS_STORAGE_KEY]: status });
      }
      return status;
    };
    const writeStatus = async (value) => {
      const status = projectStatus(value, Number(now()));
      await storageSession.set({ [COLLECTOR_AUTH_STATUS_STORAGE_KEY]: status });
      return status;
    };
    const generationIsCurrent = (status, generationId) => (
      status.generationId === String(generationId || '')
    );
    const fenceActiveRequest = (generationId, replace = false) => {
      const normalizedGenerationId = String(generationId || '');
      if (
        activeRequestGenerationId !== null
        && (replace || activeRequestGenerationId === normalizedGenerationId)
      ) requestFence += 1;
    };
    const retryDelay = (attemptNumber) => {
      const base = RETRY_BASE_DELAYS_MS[Math.min(
        Math.max(attemptNumber - 1, 0),
        RETRY_BASE_DELAYS_MS.length - 1,
      )];
      const sample = Math.max(0, Math.min(1, Number(random()) || 0));
      const jittered = Math.round(base * (1 + ((sample * 2) - 1) * JITTER_RATIO));
      return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, jittered));
    };

    const getStatus = () => serializeStatusMutation(() => readStatus());

    const begin = ({ generationId } = {}) => {
      const normalizedGenerationId = safeGenerationId(generationId);
      if (!normalizedGenerationId) return getStatus();
      fenceActiveRequest(normalizedGenerationId, true);
      return serializeStatusMutation(async () => {
        const current = await readStatus();
        const changed = current.generationId !== normalizedGenerationId;
        const timestamp = currentIso();
        await clearRetrySchedule();
        const status = await writeStatus({
          ...current,
          phase: 'REQUESTING_TICKET',
          generationId: normalizedGenerationId,
          startedAt: changed || !current.startedAt ? timestamp : current.startedAt,
          updatedAt: timestamp,
          attemptNumber: changed ? 0 : current.attemptNumber,
          nextRetryAt: '',
          publicCode: '',
          account: null,
          expiresAt: '',
        });
        activeRequestGenerationId = normalizedGenerationId;
        return status;
      });
    };

    const accept = ({ requestId, generationId } = {}) => {
      fenceActiveRequest(generationId);
      return serializeStatusMutation(async () => {
        const current = await readStatus();
        const normalizedRequestId = typeof requestId === 'string' ? requestId.trim() : '';
        if (
          !generationIsCurrent(current, generationId)
          || !['DISCOVERING_WEB', 'REQUESTING_TICKET'].includes(current.phase)
          || !normalizedRequestId
          || normalizedRequestId !== requestId
          || normalizedRequestId.length > 128
        ) return current;
        await clearRetrySchedule();
        const status = await writeStatus({
          ...current,
          phase: 'REQUESTING_TICKET',
          updatedAt: currentIso(),
          nextRetryAt: '',
          publicCode: '',
          account: null,
          expiresAt: '',
        });
        activeRequestGenerationId = current.generationId;
        return status;
      });
    };

    const exchange = ({ generationId } = {}) => {
      fenceActiveRequest(generationId);
      return serializeStatusMutation(async () => {
        const current = await readStatus();
        if (!generationIsCurrent(current, generationId)) return current;
        await clearRetrySchedule();
        const status = await writeStatus({
          ...current,
          phase: 'EXCHANGING',
          updatedAt: currentIso(),
          nextRetryAt: '',
          publicCode: '',
          account: null,
          expiresAt: '',
        });
        activeRequestGenerationId = current.generationId;
        return status;
      });
    };

    const succeed = ({ generationId, account, expiresAt } = {}) => {
      fenceActiveRequest(generationId);
      return serializeStatusMutation(async () => {
        const current = await readStatus();
        if (!generationIsCurrent(current, generationId)) return current;
        const timestamp = currentIso();
        await clearRetrySchedule();
        const status = await writeStatus({
          ...current,
          phase: 'AUTHENTICATED',
          startedAt: current.startedAt || timestamp,
          updatedAt: timestamp,
          nextRetryAt: '',
          publicCode: '',
          account: safeAccount(account),
          expiresAt: safeIso(expiresAt),
        });
        if (activeRequestGenerationId === current.generationId) {
          activeRequestGenerationId = null;
        }
        return status;
      });
    };

    const fail = ({ generationId, error } = {}) => {
      fenceActiveRequest(generationId);
      return serializeStatusMutation(async () => {
        const current = await readStatus();
        if (!generationIsCurrent(current, generationId)) return current;
        const classification = classifyFailure(error);
        const timestamp = currentIso();
        if (!classification.retry) {
          await clearRetrySchedule();
          const status = await writeStatus({
            ...current,
            phase: classification.phase,
            updatedAt: timestamp,
            nextRetryAt: '',
            publicCode: classification.publicCode,
            account: null,
            expiresAt: '',
          });
          if (activeRequestGenerationId === current.generationId) {
            activeRequestGenerationId = null;
          }
          return status;
        }
        const attemptNumber = current.attemptNumber + 1;
        const when = Number(now()) + retryDelay(attemptNumber);
        const status = await writeStatus({
          ...current,
          phase: 'RETRY_WAIT',
          updatedAt: timestamp,
          attemptNumber,
          nextRetryAt: new Date(when).toISOString(),
          publicCode: classification.publicCode,
          account: null,
          expiresAt: '',
        });
        await scheduleRetry(when);
        if (activeRequestGenerationId === current.generationId) {
          activeRequestGenerationId = null;
        }
        return status;
      });
    };

    const runRequest = ({ expectedGenerationId = null, resumeOnly = false } = {}) => {
      if (operationPromise) return operationPromise;
      const operation = (async () => {
        const start = await serializeStatusMutation(async () => {
          const current = await readStatus();
          if (
            resumeOnly
            && (
              current.generationId !== expectedGenerationId
              || ![
                'DISCOVERING_WEB',
                'REQUESTING_TICKET',
                'EXCHANGING',
                'RETRY_WAIT',
              ].includes(current.phase)
            )
          ) return { shouldRequest: false, status: current };
          if (
            activeRequestGenerationId === current.generationId
            && ['DISCOVERING_WEB', 'REQUESTING_TICKET', 'EXCHANGING'].includes(current.phase)
          ) return { shouldRequest: false, status: current };
          const timestamp = currentIso();
          await clearRetrySchedule();
          const status = await writeStatus({
            ...current,
            phase: 'DISCOVERING_WEB',
            generationId: current.generationId || DISCOVERY_GENERATION_ID,
            startedAt: current.startedAt || timestamp,
            updatedAt: timestamp,
            nextRetryAt: '',
            publicCode: '',
            account: null,
            expiresAt: '',
          });
          activeRequestGenerationId = status.generationId;
          return {
            fence: requestFence,
            shouldRequest: true,
            status,
          };
        });
        if (!start.shouldRequest) return { requested: false, status: start.status };
        const discovering = start.status;
        const authorized = await serializeStatusMutation(async () => {
          const latest = await readStatus();
          return {
            allowed: activeRequestGenerationId === discovering.generationId
              && requestFence === start.fence
              && latest.generationId === discovering.generationId
              && latest.phase === 'DISCOVERING_WEB',
            status: latest,
          };
        });
        if (
          !authorized.allowed
          || requestFence !== start.fence
          || activeRequestGenerationId !== discovering.generationId
        ) {
          return { requested: false, status: authorized.status };
        }
        let result;
        try {
          result = await requestAuth({ generationId: discovering.generationId });
        } catch (error) {
          const status = await fail({ generationId: discovering.generationId, error });
          return { requested: false, status };
        }
        const requested = result?.requested === true || result?.requested === 1;
        if (!requested) {
          let status = discovering;
          try {
            status = await fail({
              generationId: discovering.generationId,
              error: { code: result?.publicCode || 'WEB_TAB_UNAVAILABLE' },
            });
          } catch {}
          return { requested: false, status };
        }
        return { requested: true, status: discovering };
      })();
      operationPromise = operation;
      const clearOperation = () => {
        if (operationPromise === operation) operationPromise = null;
      };
      void operation.then(clearOperation, clearOperation);
      return operation;
    };

    const retryNow = () => runRequest();

    const resume = async () => {
      const initial = await getStatus();
      let session = null;
      try { session = await getSession(); } catch {}
      const decision = await serializeStatusMutation(async () => {
        const latest = await readStatus();
        if (latest.generationId !== initial.generationId) {
          return { request: false, status: latest };
        }
        const unchanged = JSON.stringify(latest) === JSON.stringify(initial);
        if (session?.account && safeIso(session.expiresAt)) {
          if (latest.phase === 'ACTION_REQUIRED' || (latest.phase === 'WAITING_FOR_WEB' && !unchanged)) {
            return { request: false, status: latest };
          }
          const timestamp = currentIso();
          await clearRetrySchedule();
          const status = await writeStatus({
            ...latest,
            phase: 'AUTHENTICATED',
            startedAt: latest.startedAt || timestamp,
            updatedAt: timestamp,
            nextRetryAt: '',
            publicCode: '',
            account: safeAccount(session.account),
            expiresAt: safeIso(session.expiresAt),
          });
          if (activeRequestGenerationId === latest.generationId) {
            activeRequestGenerationId = null;
          }
          return { request: false, status };
        }
        if (latest.phase === 'ACTION_REQUIRED' || latest.phase === 'WAITING_FOR_WEB') {
          await clearRetrySchedule();
          return { request: false, status: latest };
        }
        if (latest.phase === 'AUTHENTICATED') {
          if (!unchanged) return { request: false, status: latest };
          await clearRetrySchedule();
          const status = await writeStatus({
            ...latest,
            phase: 'WAITING_FOR_WEB',
            updatedAt: currentIso(),
            nextRetryAt: '',
            publicCode: 'WEB_LOGIN_REQUIRED',
            account: null,
            expiresAt: '',
          });
          if (activeRequestGenerationId === latest.generationId) {
            activeRequestGenerationId = null;
          }
          return { request: false, status };
        }
        if (latest.phase === 'RETRY_WAIT') {
          const when = Date.parse(latest.nextRetryAt);
          if (Number.isFinite(when) && when > Number(now())) {
            await scheduleRetry(when);
            return { request: false, status: latest };
          }
        }
        if (![
          'DISCOVERING_WEB',
          'REQUESTING_TICKET',
          'EXCHANGING',
          'RETRY_WAIT',
        ].includes(latest.phase)) return { request: false, status: latest };
        if (
          activeRequestGenerationId === latest.generationId
          && ['DISCOVERING_WEB', 'REQUESTING_TICKET', 'EXCHANGING'].includes(latest.phase)
        ) return { request: false, status: latest };
        return { request: true, status: latest };
      });
      if (!decision.request) return decision.status;
      const result = await runRequest({
        expectedGenerationId: decision.status.generationId,
        resumeOnly: true,
      });
      return result.status;
    };

    return Object.freeze({
      accept,
      begin,
      exchange,
      fail,
      getStatus,
      resume,
      retryNow,
      succeed,
    });
  }

  const api = Object.freeze({
    COLLECTOR_AUTH_RETRY_ALARM,
    COLLECTOR_AUTH_STATUS_STORAGE_KEY,
    createCollectorAuthCoordinator,
  });
  root.JzCollectorAuthCoordinator = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
