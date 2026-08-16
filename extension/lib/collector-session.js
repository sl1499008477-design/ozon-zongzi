(function (root) {
  'use strict';

  const COLLECTOR_SESSION_STORAGE_KEY = 'sonliCollectorSession';
  const COLLECTOR_AUTH_GENERATION_STORAGE_KEY = 'sonliCollectorAuthGeneration';
  const COLLECTOR_AUTH_INCARNATION_STORAGE_KEY = 'sonliCollectorAuthIncarnation';
  const PENDING_UPLOADS_STORAGE_KEY = 'sonliCollectorPendingUploads';
  const COLLECTOR_LAST_OWNER_KEY = 'sonliCollectorLastOwner';
  const COLLECTOR_PERMISSIONS = Object.freeze([
    'collector.upload',
    'collector.job.read',
    'collector.config.read',
    'collector.ozon.read',
  ]);
  const RETIRED_COLLECTOR_SCOPE_KEYS = new Set([
    'accountid',
    'createdby',
    'clientid',
    'storeid',
    'localstoreid',
    'operatingstoreid',
    'datacollectionstoreid',
    'datacollectionstore',
    'datacollectionstores',
    'datacollectionstoreids',
    'currentdatacollectionstoreid',
    'currentdatacollectionstoreidsbyaccount',
    'sellercompanyid',
    'sellercompany',
    'legacyscope',
  ]);
  const SECRET_PATTERN = /(?:ctt|cst|csess)_[A-Za-z0-9_-]*|bearer\s+[A-Za-z0-9._~+/-]+=*/gi;
  const SENSITIVE_DIAGNOSTIC_KEY_PATTERN = /authorization|bearer|secret|ticket|token/i;
  const STABLE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,119}$/;
  const COLLECTOR_AUTH_GENERATION_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
  const COLLECTOR_AUTH_INCARNATION_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

  const redactCollectorSecrets = (value, secrets = []) => {
    let text = String(value == null ? '' : value);
    for (const secret of secrets) {
      const candidate = String(secret || '');
      if (candidate) text = text.split(candidate).join('[REDACTED]');
    }
    return text.replace(SECRET_PATTERN, '[REDACTED]').slice(0, 500);
  };

  const sanitizeCollectorErrorCode = (
    value,
    fallback = 'COLLECTOR_REQUEST_FAILED',
    secrets = [],
  ) => {
    const sanitized = redactCollectorSecrets(value, secrets).trim();
    return STABLE_ERROR_CODE_PATTERN.test(sanitized)
      ? sanitized
      : String(fallback || 'COLLECTOR_REQUEST_FAILED');
  };

  const sanitizeCollectorDiagnostic = (value, secrets = [], seen = new WeakSet()) => {
    if (typeof value === 'string') return redactCollectorSecrets(value, secrets);
    if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
    if (typeof value !== 'object') return redactCollectorSecrets(value, secrets);
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeCollectorDiagnostic(item, secrets, seen));
    }
    const result = {};
    for (const [key, nested] of Object.entries(value)) {
      const safeKey = redactCollectorSecrets(key, secrets);
      result[safeKey] = SENSITIVE_DIAGNOSTIC_KEY_PATTERN.test(key)
        ? '[REDACTED]'
        : sanitizeCollectorDiagnostic(nested, secrets, seen);
    }
    return result;
  };

  const collectorError = (message, status = 0, code = 'COLLECTOR_REQUEST_FAILED', secrets = []) => {
    const error = new Error(redactCollectorSecrets(message, secrets) || 'Collector request failed');
    error.status = Number(status) || 0;
    error.code = sanitizeCollectorErrorCode(code, 'COLLECTOR_REQUEST_FAILED', secrets);
    return error;
  };

  const requireCollectorGenerationId = (value) => {
    const generationId = String(value || '');
    if (!COLLECTOR_AUTH_GENERATION_PATTERN.test(generationId)) {
      throw collectorError(
        'COLLECTOR_AUTH_GENERATION_INVALID',
        400,
        'COLLECTOR_AUTH_GENERATION_INVALID',
      );
    }
    return generationId;
  };

  const isCollectorAuthIncarnation = (value) =>
    COLLECTOR_AUTH_INCARNATION_PATTERN.test(String(value || ''));

  const defaultNewGenerationIncarnation = () =>
    `collector_activation_${root.crypto.randomUUID()}`;

  const throwIfAborted = (signal) => {
    if (!signal?.aborted) return;
    const error = collectorError('COLLECTOR_REQUEST_ABORTED', 0, 'COLLECTOR_REQUEST_ABORTED');
    error.name = 'AbortError';
    throw error;
  };

  const canonicalCollectorKey = (key) => String(key || '').replace(/[_-]/g, '').toLowerCase();
  const isRetiredCollectorScopeKey = (key) =>
    RETIRED_COLLECTOR_SCOPE_KEYS.has(canonicalCollectorKey(key));
  const withoutCollectorScope = (value) => {
    if (Array.isArray(value)) return value.map(withoutCollectorScope);
    if (!value || typeof value !== 'object') return value;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    const result = {};
    for (const [key, nested] of Object.entries(value)) {
      if (!isRetiredCollectorScopeKey(key)) result[key] = withoutCollectorScope(nested);
    }
    return result;
  };

  const isRetryableCollectorUploadStatus = (status) => {
    const value = Number(status) || 0;
    return value === 0
      || value === 401
      || value === 403
      || value === 408
      || value === 429
      || value >= 500;
  };

  const stableJson = (value) => {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map((key) =>
        `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  };

  const accountIdOf = (session) => String(session?.account?.id || '');
  const sessionIdentityOf = (session) => {
    const accountId = accountIdOf(session);
    return accountId ? `account:${accountId}` : '';
  };

  const safeHeaders = (headers, collectorToken) => {
    const safe = {};
    const source = headers && typeof headers === 'object' ? headers : {};
    for (const [key, value] of Object.entries(source)) {
      if (String(key).toLowerCase() === 'authorization') continue;
      safe[key] = value;
    }
    safe.authorization = `Collector ${collectorToken}`;
    return safe;
  };

  const safeSession = (session) => ({
    collectorToken: String(session?.collectorToken || ''),
    expiresAt: String(session?.expiresAt || ''),
    account: session?.account && typeof session.account === 'object'
      ? {
          id: String(session.account.id || ''),
          displayName: String(session.account.displayName || ''),
        }
      : null,
    permissions: Array.isArray(session?.permissions)
      ? session.permissions.filter((permission) => COLLECTOR_PERMISSIONS.includes(permission))
      : [],
  });

  const publicSessionFields = (session) => {
    const safe = safeSession(session);
    return {
      account: safe.account,
      permissions: safe.permissions,
      expiresAt: safe.expiresAt,
    };
  };

  const unauthenticatedActivation = (changed) => ({
    changed,
    reused: false,
    authenticated: false,
    account: null,
    permissions: [],
    expiresAt: '',
  });

  const validAccountIdHint = (value) => typeof value === 'string'
    && value.length > 0
    && value.length <= 128
    && value.trim() === value;

  function createCollectorSessionManager({
    chromeApi = root.chrome,
    backendUrl,
    fetchImpl = root.fetch?.bind(root),
    createExchangeSignal = () => root.AbortSignal.timeout(60_000),
    now = () => Date.now(),
    newGenerationIncarnation = defaultNewGenerationIncarnation,
    logger = root.console || { warn() {}, error() {} },
  } = {}) {
    if (!chromeApi?.storage?.session || !chromeApi?.storage?.local) {
      throw new TypeError('collector session requires chrome.storage.session and chrome.storage.local');
    }
    if (typeof fetchImpl !== 'function') throw new TypeError('collector session requires fetch');
    if (typeof createExchangeSignal !== 'function') {
      throw new TypeError('collector session requires exchange signal factory');
    }
    if (typeof newGenerationIncarnation !== 'function') {
      throw new TypeError('collector session requires generation incarnation factory');
    }
    const resolveBackendUrl = async () => {
      const value = typeof backendUrl === 'function' ? await backendUrl() : backendUrl;
      return String(value || '').replace(/\/+$/, '');
    };
    let queueMutationTail = Promise.resolve();
    let sessionMutationTail = Promise.resolve();
    const operationSnapshots = new WeakMap();
    const serializeQueueMutation = (operation) => {
      const run = queueMutationTail.then(operation, operation);
      queueMutationTail = run.catch(() => {});
      return run;
    };
    const serializeSessionMutation = (operation) => {
      const run = sessionMutationTail.then(operation, operation);
      sessionMutationTail = run.catch(() => {});
      return run;
    };
    const captureStoredCollectorActivation = async (generationId, secret) => {
      const stored = await chromeApi.storage.session.get([
        COLLECTOR_AUTH_GENERATION_STORAGE_KEY,
        COLLECTOR_AUTH_INCARNATION_STORAGE_KEY,
      ]);
      const incarnation = stored?.[COLLECTOR_AUTH_INCARNATION_STORAGE_KEY];
      if (
        stored?.[COLLECTOR_AUTH_GENERATION_STORAGE_KEY] !== generationId
        || !isCollectorAuthIncarnation(incarnation)
      ) {
        throw collectorError(
          'COLLECTOR_AUTH_GENERATION_CHANGED',
          409,
          'COLLECTOR_AUTH_GENERATION_CHANGED',
          [secret],
        );
      }
      return incarnation;
    };
    const assertStoredCollectorActivation = async (generationId, incarnation, secret) => {
      const storedIncarnation = await captureStoredCollectorActivation(generationId, secret);
      if (storedIncarnation !== incarnation) {
        throw collectorError(
          'COLLECTOR_AUTH_GENERATION_CHANGED',
          409,
          'COLLECTOR_AUTH_GENERATION_CHANGED',
          [secret],
        );
      }
    };

    const createGenerationIncarnation = () => {
      const incarnation = String(newGenerationIncarnation() || '');
      if (!isCollectorAuthIncarnation(incarnation)) {
        throw collectorError(
          'COLLECTOR_AUTH_INCARNATION_INVALID',
          0,
          'COLLECTOR_AUTH_INCARNATION_INVALID',
        );
      }
      return incarnation;
    };

    async function activateCollectorGeneration(value) {
      const legacyActivation = typeof value === 'string';
      const generationId = requireCollectorGenerationId(
        legacyActivation ? value : value?.generationId,
      );
      const accountIdHint = !legacyActivation && validAccountIdHint(value?.accountIdHint)
        ? value.accountIdHint
        : '';
      return serializeSessionMutation(async () => {
        const stored = await chromeApi.storage.session.get([
          COLLECTOR_SESSION_STORAGE_KEY,
          COLLECTOR_AUTH_GENERATION_STORAGE_KEY,
          COLLECTOR_AUTH_INCARNATION_STORAGE_KEY,
        ]);
        const activationIsCurrent = (
          stored?.[COLLECTOR_AUTH_GENERATION_STORAGE_KEY] === generationId
          && isCollectorAuthIncarnation(stored?.[COLLECTOR_AUTH_INCARNATION_STORAGE_KEY])
        );
        if (legacyActivation && activationIsCurrent) {
          return { changed: false };
        }
        const storedSession = stored?.[COLLECTOR_SESSION_STORAGE_KEY] || null;
        const storedExpiry = Date.parse(storedSession?.expiresAt || '');
        const validStoredSession = Boolean(
          storedSession?.collectorToken
          && accountIdOf(storedSession)
          && Number.isFinite(storedExpiry)
          && storedExpiry > now()
        );
        if (
          !legacyActivation
          && validStoredSession
          && accountIdOf(storedSession) === accountIdHint
        ) {
          if (activationIsCurrent) {
            return {
              changed: false,
              reused: true,
              authenticated: true,
              ...publicSessionFields(storedSession),
            };
          }
          await chromeApi.storage.session.set({
            [COLLECTOR_AUTH_GENERATION_STORAGE_KEY]: generationId,
            [COLLECTOR_AUTH_INCARNATION_STORAGE_KEY]: createGenerationIncarnation(),
          });
          return {
            changed: true,
            reused: true,
            authenticated: true,
            ...publicSessionFields(storedSession),
          };
        }
        if (!legacyActivation && activationIsCurrent && !storedSession) {
          return unauthenticatedActivation(false);
        }
        await chromeApi.storage.session.remove([
          COLLECTOR_SESSION_STORAGE_KEY,
          COLLECTOR_AUTH_GENERATION_STORAGE_KEY,
          COLLECTOR_AUTH_INCARNATION_STORAGE_KEY,
        ]);
        const incarnation = createGenerationIncarnation();
        await chromeApi.storage.session.set({
          [COLLECTOR_AUTH_GENERATION_STORAGE_KEY]: generationId,
          [COLLECTOR_AUTH_INCARNATION_STORAGE_KEY]: incarnation,
        });
        return legacyActivation
          ? { changed: true }
          : unauthenticatedActivation(true);
      });
    }

    async function clearCollectorGeneration(value) {
      const generationId = requireCollectorGenerationId(value);
      return serializeSessionMutation(async () => {
        const stored = await chromeApi.storage.session.get(
          COLLECTOR_AUTH_GENERATION_STORAGE_KEY,
        );
        if (stored?.[COLLECTOR_AUTH_GENERATION_STORAGE_KEY] !== generationId) return false;
        await chromeApi.storage.session.remove([
          COLLECTOR_SESSION_STORAGE_KEY,
          COLLECTOR_AUTH_GENERATION_STORAGE_KEY,
          COLLECTOR_AUTH_INCARNATION_STORAGE_KEY,
        ]);
        return true;
      });
    }

    async function logoutCollectorSession() {
      return serializeSessionMutation(async () => {
        await chromeApi.storage.session.remove([
          COLLECTOR_SESSION_STORAGE_KEY,
          COLLECTOR_AUTH_GENERATION_STORAGE_KEY,
          COLLECTOR_AUTH_INCARNATION_STORAGE_KEY,
        ]);
        return true;
      });
    }

    async function getCollectorSession() {
      return serializeSessionMutation(async () => {
        const stored = await chromeApi.storage.session.get(COLLECTOR_SESSION_STORAGE_KEY);
        const session = stored?.[COLLECTOR_SESSION_STORAGE_KEY] || null;
        if (!session) return null;
        const expiresAt = Date.parse(session.expiresAt || '');
        if (
          !session.collectorToken
          || !accountIdOf(session)
          || !Number.isFinite(expiresAt)
          || expiresAt <= now()
        ) {
          await chromeApi.storage.session.remove(COLLECTOR_SESSION_STORAGE_KEY);
          return null;
        }
        return safeSession(session);
      });
    }

    const createCollectorOperation = (session) => {
      const safe = safeSession(session);
      const snapshot = Object.freeze({
        ...safe,
        account: Object.freeze({ ...safe.account }),
        permissions: Object.freeze([...safe.permissions]),
        sessionIdentity: sessionIdentityOf(safe),
      });
      const operation = Object.freeze({
        account: snapshot.account,
        accountId: accountIdOf(snapshot),
        expiresAt: snapshot.expiresAt,
        permissions: snapshot.permissions,
        sessionIdentity: snapshot.sessionIdentity,
      });
      operationSnapshots.set(operation, snapshot);
      return operation;
    };

    async function beginCollectorOperation() {
      const session = await getCollectorSession();
      return session ? createCollectorOperation(session) : null;
    }

    const requireOperationSnapshot = (operation) => {
      if (!operation || typeof operation !== 'object' || !operationSnapshots.has(operation)) {
        throw collectorError(
          'COLLECTOR_OPERATION_INVALID',
          401,
          'COLLECTOR_OPERATION_INVALID',
        );
      }
      return operationSnapshots.get(operation);
    };

    const resolveCollectorOperation = async (operation) => {
      const resolved = operation || await beginCollectorOperation();
      if (!resolved) {
        throw collectorError('COLLECTOR_AUTH_REQUIRED', 401, 'COLLECTOR_AUTH_REQUIRED');
      }
      return {
        operation: resolved,
        snapshot: requireOperationSnapshot(resolved),
      };
    };

    const assertOperationOwnerIsCurrent = async (snapshot, signal) => {
      throwIfAborted(signal);
      const expiresAt = Date.parse(snapshot?.expiresAt || '');
      const current = await getCollectorSession();
      throwIfAborted(signal);
      if (
        !Number.isFinite(expiresAt)
        || expiresAt <= now()
        || !current
        || accountIdOf(current) !== accountIdOf(snapshot)
        || sessionIdentityOf(current) !== snapshot.sessionIdentity
      ) {
        throw collectorError(
          'COLLECTOR_SESSION_CHANGED',
          409,
          'COLLECTOR_SESSION_CHANGED',
          [snapshot?.collectorToken],
        );
      }
      return true;
    };

    const sessionMatchesSnapshot = (session, snapshot) =>
      String(session?.collectorToken || '') === snapshot.collectorToken
      && String(session?.expiresAt || '') === snapshot.expiresAt
      && accountIdOf(session) === accountIdOf(snapshot)
      && sessionIdentityOf(session) === snapshot.sessionIdentity;

    const clearCollectorSessionIfSnapshotCurrent = (snapshot, signal) =>
      serializeSessionMutation(async () => {
        throwIfAborted(signal);
        const stored = await chromeApi.storage.session.get(COLLECTOR_SESSION_STORAGE_KEY);
        throwIfAborted(signal);
        const current = stored?.[COLLECTOR_SESSION_STORAGE_KEY] || null;
        if (!sessionMatchesSnapshot(current, snapshot)) return false;
        throwIfAborted(signal);
        await chromeApi.storage.session.remove(COLLECTOR_SESSION_STORAGE_KEY);
        throwIfAborted(signal);
        return true;
      });

    async function writeCollectorSession(session) {
      const safe = safeSession(session);
      const expiresAt = Date.parse(safe.expiresAt);
      if (!safe.collectorToken || !accountIdOf(safe) || !Number.isFinite(expiresAt)) {
        throw collectorError('COLLECTOR_SESSION_INVALID', 401, 'COLLECTOR_SESSION_INVALID', [
          session?.collectorToken,
        ]);
      }
      await chromeApi.storage.session.set({ [COLLECTOR_SESSION_STORAGE_KEY]: safe });
      await chromeApi.storage.local.set({
        [COLLECTOR_LAST_OWNER_KEY]: {
          accountId: accountIdOf(safe),
          sessionIdentity: sessionIdentityOf(safe),
        },
      });
      return safe;
    }

    async function setCollectorSession(session) {
      return serializeSessionMutation(() => writeCollectorSession(session));
    }

    async function clearCollectorSession(collectorOperation) {
      if (arguments.length > 0) {
        if (!collectorOperation) return false;
        return clearCollectorSessionIfSnapshotCurrent(
          requireOperationSnapshot(collectorOperation),
        );
      }
      return serializeSessionMutation(async () => {
        await chromeApi.storage.session.remove(COLLECTOR_SESSION_STORAGE_KEY);
        return true;
      });
    }

    async function responseBody(response) {
      const text = await response.text().catch(() => '');
      try {
        return text ? JSON.parse(text) : {};
      } catch {
        return { message: text };
      }
    }

    async function exchangeCollectorTicket({
      ticket,
      deviceFingerprint,
      extensionVersion,
      generationId: generationIdValue,
    } = {}) {
      const secret = String(ticket || '');
      if (!secret) throw collectorError('COLLECTOR_TICKET_REQUIRED', 400, 'COLLECTOR_TICKET_REQUIRED');
      const generationId = requireCollectorGenerationId(generationIdValue);
      const incarnation = await serializeSessionMutation(() => (
        captureStoredCollectorActivation(generationId, secret)
      ));
      const baseUrl = await resolveBackendUrl();
      const signal = createExchangeSignal();
      if (!signal || typeof signal.aborted !== 'boolean'
        || typeof signal.addEventListener !== 'function') {
        throw new TypeError('collector exchange signal required');
      }
      let response;
      try {
        response = await fetchImpl(`${baseUrl}/extension/collector-auth/exchange`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal,
          body: JSON.stringify({
            ticket: secret,
            deviceFingerprint: String(deviceFingerprint || ''),
            extensionVersion: String(extensionVersion || ''),
          }),
        });
      } catch (cause) {
        const error = collectorError(
          cause?.message || 'Collector exchange network failure',
          0,
          'COLLECTOR_EXCHANGE_NETWORK_ERROR',
          [secret],
        );
        logger.warn?.('[collector-auth] exchange network failure', {
          ...sanitizeCollectorDiagnostic({
            code: error.code,
            message: error.message,
          }, [secret]),
        });
        throw error;
      }
      const body = await responseBody(response);
      if (!response.ok) {
        const error = collectorError(
          body?.message || `Collector exchange failed (${response.status})`,
          response.status,
          body?.code,
          [secret],
        );
        logger.warn?.('[collector-auth] exchange rejected', sanitizeCollectorDiagnostic({
          status: error.status,
          code: error.code,
          message: error.message,
        }, [secret]));
        throw error;
      }
      return serializeSessionMutation(async () => {
        await assertStoredCollectorActivation(generationId, incarnation, secret);
        return writeCollectorSession(body?.data || body);
      });
    }

    async function exchangeCollectorTicketWithRetry({
      requestTicket,
      deviceFingerprint,
      extensionVersion,
      generationId,
    } = {}) {
      if (typeof requestTicket !== 'function') {
        throw new TypeError('collector ticket retry requires requestTicket');
      }
      let lastError = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const issued = await requestTicket();
        try {
          return await exchangeCollectorTicket({
            ticket: issued?.ticket,
            deviceFingerprint,
            extensionVersion,
            generationId,
          });
        } catch (error) {
          lastError = error;
          if (error?.code !== 'COLLECTOR_TICKET_EXPIRED' || attempt === 1) throw error;
        }
      }
      throw lastError;
    }

    async function collectorFetch(path, {
      collectorOperation,
      permission,
      ...options
    } = {}) {
      throwIfAborted(options.signal);
      const resolved = await resolveCollectorOperation(collectorOperation);
      throwIfAborted(options.signal);
      const { snapshot } = resolved;
      if (!snapshot.permissions.includes(permission)) {
        throw collectorError('COLLECTOR_PERMISSION_DENIED', 403, 'COLLECTOR_PERMISSION_DENIED');
      }
      const baseUrl = await resolveBackendUrl();
      throwIfAborted(options.signal);
      await assertOperationOwnerIsCurrent(snapshot, options.signal);
      throwIfAborted(options.signal);
      const response = await fetchImpl(`${baseUrl}${String(path || '')}`, {
        ...options,
        headers: safeHeaders(options.headers, snapshot.collectorToken),
      });
      throwIfAborted(options.signal);
      await assertOperationOwnerIsCurrent(snapshot, options.signal);
      throwIfAborted(options.signal);
      if (response.status === 401 || response.status === 403) {
        await clearCollectorSessionIfSnapshotCurrent(snapshot, options.signal);
        throwIfAborted(options.signal);
      }
      return response;
    }

    async function listPendingUploads() {
      const stored = await chromeApi.storage.local.get(PENDING_UPLOADS_STORAGE_KEY);
      const items = stored?.[PENDING_UPLOADS_STORAGE_KEY];
      return Array.isArray(items) ? items.slice() : [];
    }

    async function writePendingUploads(items) {
      await chromeApi.storage.local.set({
        [PENDING_UPLOADS_STORAGE_KEY]: Array.isArray(items) ? items : [],
      });
    }

    async function resolvePendingOwner(collectorOperation) {
      if (collectorOperation) {
        const snapshot = requireOperationSnapshot(collectorOperation);
        return {
          ownerAccountId: accountIdOf(snapshot),
          ownerSessionIdentity: snapshot.sessionIdentity,
        };
      }
      const operation = await beginCollectorOperation();
      if (operation) {
        const snapshot = requireOperationSnapshot(operation);
        return {
          ownerAccountId: accountIdOf(snapshot),
          ownerSessionIdentity: snapshot.sessionIdentity,
        };
      }
      const storedOwner =
        (await chromeApi.storage.local.get(COLLECTOR_LAST_OWNER_KEY))?.[COLLECTOR_LAST_OWNER_KEY];
      return {
        ownerAccountId: String(storedOwner?.accountId || ''),
        ownerSessionIdentity: String(storedOwner?.sessionIdentity || ''),
      };
    }

    async function enqueuePendingUpload(upload, collectorOperation) {
      const owner = await resolvePendingOwner(collectorOperation);
      return serializeQueueMutation(async () => {
        const ownerAccountId = owner.ownerAccountId;
        const ownerSessionIdentity = owner.ownerSessionIdentity;
        if (!ownerAccountId || !ownerSessionIdentity) {
          throw collectorError('COLLECTOR_AUTH_REQUIRED', 401, 'COLLECTOR_AUTH_REQUIRED');
        }
        const requestId = String(upload?.requestId || '');
        if (!requestId) {
          throw collectorError('COLLECT_REQUEST_ID_REQUIRED', 400, 'COLLECT_REQUEST_ID_REQUIRED');
        }
        const path = String(upload?.path || '');
        const body = upload?.body && typeof upload.body === 'object' ? upload.body : {};
        const queue = await listPendingUploads();
        const existing = queue.find((item) =>
          item.requestId === requestId
          && item.ownerAccountId === ownerAccountId
          && item.ownerSessionIdentity === ownerSessionIdentity);
        if (existing) {
          if (existing.path !== path || stableJson(existing.body) !== stableJson(body)) {
            throw collectorError(
              '相同采集请求标识已用于不同内容',
              409,
              'COLLECT_REQUEST_CONFLICT',
            );
          }
          return queue;
        }
        const entry = {
          requestId,
          path,
          body,
          ownerAccountId,
          ownerSessionIdentity,
          queuedAt: new Date(now()).toISOString(),
        };
        queue.push(entry);
        await writePendingUploads(queue);
        return queue;
      });
    }

    async function enqueueRetryablePendingUpload(upload, status, collectorOperation) {
      if (!isRetryableCollectorUploadStatus(status)) return false;
      await enqueuePendingUpload(upload, collectorOperation);
      return true;
    }

    async function flushPendingUploads(upload, collectorOperation) {
      if (typeof upload !== 'function') throw new TypeError('pending upload flush requires uploader');
      const operation = collectorOperation || await beginCollectorOperation();
      return serializeQueueMutation(async () => {
        if (!operation) {
          return {
            uploaded: 0,
            retained: (await listPendingUploads()).length,
            blockedAccountMismatch: 0,
            discarded: 0,
          };
        }
        const snapshot = requireOperationSnapshot(operation);
        const queue = await listPendingUploads();
        const retained = [];
        let uploaded = 0;
        let blockedAccountMismatch = 0;
        let discarded = 0;
        for (const item of queue) {
          if (
            item.ownerAccountId !== accountIdOf(snapshot)
            || item.ownerSessionIdentity !== snapshot.sessionIdentity
          ) {
            blockedAccountMismatch += 1;
            retained.push(item);
            continue;
          }
          try {
            const response = await upload(item, operation);
            await assertOperationOwnerIsCurrent(snapshot);
            if (response?.ok) uploaded += 1;
            else if (isRetryableCollectorUploadStatus(response?.status)) retained.push(item);
            else discarded += 1;
          } catch (error) {
            logger.warn?.(
              '[collector-upload] retained after failure',
              sanitizeCollectorDiagnostic({
                requestId: item.requestId,
                status: error?.status,
                code: sanitizeCollectorErrorCode(
                  error?.code,
                  'COLLECTOR_UPLOAD_FAILED',
                  [snapshot.collectorToken],
                ),
                message: error?.message,
                cause: error?.cause,
              }, [snapshot.collectorToken]),
            );
            retained.push(item);
          }
        }
        await writePendingUploads(retained);
        return {
          uploaded,
          retained: retained.length,
          blockedAccountMismatch,
          discarded,
        };
      });
    }

    return Object.freeze({
      activateCollectorGeneration,
      beginCollectorOperation,
      clearCollectorGeneration,
      clearCollectorSession,
      collectorFetch,
      enqueuePendingUpload,
      enqueueRetryablePendingUpload,
      exchangeCollectorTicket,
      exchangeCollectorTicketWithRetry,
      flushPendingUploads,
      getCollectorSession,
      listPendingUploads,
      logoutCollectorSession,
      setCollectorSession,
    });
  }

  const api = Object.freeze({
    COLLECTOR_AUTH_GENERATION_STORAGE_KEY,
    COLLECTOR_AUTH_INCARNATION_STORAGE_KEY,
    COLLECTOR_PERMISSIONS,
    COLLECTOR_LAST_OWNER_KEY,
    COLLECTOR_SESSION_STORAGE_KEY,
    PENDING_UPLOADS_STORAGE_KEY,
    createCollectorSessionManager,
    isRetryableCollectorUploadStatus,
    redactCollectorSecrets,
    sanitizeCollectorDiagnostic,
    sanitizeCollectorErrorCode,
    withoutCollectorScope,
  });
  root.JzCollectorSession = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
