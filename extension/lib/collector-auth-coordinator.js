(function (root) {
  'use strict';

  const COLLECTOR_AUTH_STATUS_STORAGE_KEY = 'sonliCollectorAuthStatus';
  const COLLECTOR_AUTH_RETRY_ALARM = 'collectorAuthRetry';
  const RETRY_BASE_DELAYS_MS = Object.freeze([1_000, 2_000, 5_000, 10_000, 30_000]);
  const MAX_RETRY_DELAY_MS = 30_000;
  const JITTER_RATIO = 0.1;
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

  const projectStatus = (value) => {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const attempt = Number(source.attemptNumber);
    return {
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

    let operationPromise = null;
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
    const scheduleRetryAlarm = async (when) => {
      await clearRetryAlarm();
      await Promise.resolve(alarms.create(COLLECTOR_AUTH_RETRY_ALARM, { when }));
    };
    const readStatus = async () => {
      const stored = await storageSession.get(COLLECTOR_AUTH_STATUS_STORAGE_KEY);
      const raw = stored?.[COLLECTOR_AUTH_STATUS_STORAGE_KEY];
      const status = raw === undefined ? defaultStatus() : projectStatus(raw);
      if (raw !== undefined && JSON.stringify(raw) !== JSON.stringify(status)) {
        await storageSession.set({ [COLLECTOR_AUTH_STATUS_STORAGE_KEY]: status });
      }
      return status;
    };
    const writeStatus = async (value) => {
      const status = projectStatus(value);
      await storageSession.set({ [COLLECTOR_AUTH_STATUS_STORAGE_KEY]: status });
      return status;
    };
    const generationIsCurrent = (status, generationId) => (
      status.generationId === String(generationId || '')
    );
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
      return serializeStatusMutation(async () => {
        const current = await readStatus();
        const changed = current.generationId !== normalizedGenerationId;
        const timestamp = currentIso();
        if (changed) await clearRetryAlarm();
        return writeStatus({
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
      });
    };

    const accept = ({ requestId, generationId } = {}) => serializeStatusMutation(async () => {
      const current = await readStatus();
      const normalizedRequestId = typeof requestId === 'string' ? requestId.trim() : '';
      if (
        !generationIsCurrent(current, generationId)
        || !['DISCOVERING_WEB', 'REQUESTING_TICKET'].includes(current.phase)
        || !normalizedRequestId
        || normalizedRequestId !== requestId
        || normalizedRequestId.length > 128
      ) return current;
      return writeStatus({
        ...current,
        phase: 'REQUESTING_TICKET',
        updatedAt: currentIso(),
        nextRetryAt: '',
        publicCode: '',
        account: null,
        expiresAt: '',
      });
    });

    const exchange = ({ generationId } = {}) => serializeStatusMutation(async () => {
      const current = await readStatus();
      if (!generationIsCurrent(current, generationId)) return current;
      return writeStatus({
        ...current,
        phase: 'EXCHANGING',
        updatedAt: currentIso(),
        nextRetryAt: '',
        publicCode: '',
        account: null,
        expiresAt: '',
      });
    });

    const succeed = ({ generationId, account, expiresAt } = {}) => serializeStatusMutation(async () => {
      const current = await readStatus();
      if (!generationIsCurrent(current, generationId)) return current;
      const timestamp = currentIso();
      await clearRetryAlarm();
      return writeStatus({
        ...current,
        phase: 'AUTHENTICATED',
        startedAt: current.startedAt || timestamp,
        updatedAt: timestamp,
        nextRetryAt: '',
        publicCode: '',
        account: safeAccount(account),
        expiresAt: safeIso(expiresAt),
      });
    });

    const fail = ({ generationId, error } = {}) => serializeStatusMutation(async () => {
      const current = await readStatus();
      if (!generationIsCurrent(current, generationId)) return current;
      const classification = classifyFailure(error);
      const timestamp = currentIso();
      if (!classification.retry) {
        await clearRetryAlarm();
        return writeStatus({
          ...current,
          phase: classification.phase,
          updatedAt: timestamp,
          nextRetryAt: '',
          publicCode: classification.publicCode,
          account: null,
          expiresAt: '',
        });
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
      await scheduleRetryAlarm(when);
      return status;
    });

    const retryNow = () => {
      if (operationPromise) return operationPromise;
      const operation = (async () => {
        const start = await serializeStatusMutation(async () => {
          const current = await readStatus();
          const timestamp = currentIso();
          await clearRetryAlarm();
          return {
            status: await writeStatus({
              ...current,
              phase: 'DISCOVERING_WEB',
              startedAt: current.startedAt || timestamp,
              updatedAt: timestamp,
              nextRetryAt: '',
              publicCode: '',
              account: null,
              expiresAt: '',
            }),
          };
        });
        const discovering = start.status;
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

    const resume = async () => {
      const current = await getStatus();
      let session = null;
      try { session = await getSession(); } catch {}
      if (session?.account && safeIso(session.expiresAt)) {
        return succeed({
          generationId: current.generationId,
          account: session.account,
          expiresAt: session.expiresAt,
        });
      }
      if (current.phase === 'ACTION_REQUIRED') return current;
      if (current.phase === 'AUTHENTICATED') {
        return fail({
          generationId: current.generationId,
          error: { code: 'WEB_AUTH_REQUIRED' },
        });
      }
      if (current.phase === 'RETRY_WAIT') {
        const scheduled = await serializeStatusMutation(async () => {
          const latest = await readStatus();
          const when = Date.parse(latest.nextRetryAt);
          if (latest.phase !== 'RETRY_WAIT' || !Number.isFinite(when) || when <= Number(now())) {
            return { restored: false, status: latest };
          }
          await scheduleRetryAlarm(when);
          return { restored: true, status: latest };
        });
        if (scheduled.restored) return scheduled.status;
      }
      if (![
        'DISCOVERING_WEB',
        'REQUESTING_TICKET',
        'EXCHANGING',
        'RETRY_WAIT',
      ].includes(current.phase)) return current;
      const result = await retryNow();
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
