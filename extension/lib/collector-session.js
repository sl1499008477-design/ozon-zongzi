(function (root) {
  'use strict';

  const COLLECTOR_SESSION_STORAGE_KEY = 'sonliCollectorSession';
  const PENDING_UPLOADS_STORAGE_KEY = 'sonliCollectorPendingUploads';
  const COLLECTOR_LAST_OWNER_KEY = 'sonliCollectorLastOwner';
  const COLLECTOR_PERMISSIONS = Object.freeze([
    'collector.upload',
    'collector.job.read',
    'collector.config.read',
  ]);
  const SECRET_PATTERN = /(?:ctt|cst)_[A-Za-z0-9_-]{8,}/g;

  const redactCollectorSecrets = (value, secrets = []) => {
    let text = String(value == null ? '' : value);
    for (const secret of secrets) {
      const candidate = String(secret || '');
      if (candidate) text = text.split(candidate).join('[REDACTED]');
    }
    return text.replace(SECRET_PATTERN, '[REDACTED]').slice(0, 500);
  };

  const collectorError = (message, status = 0, code = 'COLLECTOR_REQUEST_FAILED', secrets = []) => {
    const error = new Error(redactCollectorSecrets(message, secrets) || 'Collector request failed');
    error.status = Number(status) || 0;
    error.code = String(code || 'COLLECTOR_REQUEST_FAILED').slice(0, 120);
    return error;
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

  function createCollectorSessionManager({
    chromeApi = root.chrome,
    backendUrl,
    fetchImpl = root.fetch?.bind(root),
    now = () => Date.now(),
    logger = root.console || { warn() {}, error() {} },
  } = {}) {
    if (!chromeApi?.storage?.session || !chromeApi?.storage?.local) {
      throw new TypeError('collector session requires chrome.storage.session and chrome.storage.local');
    }
    if (typeof fetchImpl !== 'function') throw new TypeError('collector session requires fetch');
    const resolveBackendUrl = async () => {
      const value = typeof backendUrl === 'function' ? await backendUrl() : backendUrl;
      return String(value || '').replace(/\/+$/, '');
    };

    async function getCollectorSession() {
      const stored = await chromeApi.storage.session.get(COLLECTOR_SESSION_STORAGE_KEY);
      const session = stored?.[COLLECTOR_SESSION_STORAGE_KEY] || null;
      const expiresAt = Date.parse(session?.expiresAt || '');
      if (
        !session?.collectorToken
        || !accountIdOf(session)
        || !Number.isFinite(expiresAt)
        || expiresAt <= now()
      ) {
        await chromeApi.storage.session.remove(COLLECTOR_SESSION_STORAGE_KEY);
        return null;
      }
      return safeSession(session);
    }

    async function setCollectorSession(session) {
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

    async function clearCollectorSession() {
      await chromeApi.storage.session.remove(COLLECTOR_SESSION_STORAGE_KEY);
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
    } = {}) {
      const secret = String(ticket || '');
      if (!secret) throw collectorError('COLLECTOR_TICKET_REQUIRED', 400, 'COLLECTOR_TICKET_REQUIRED');
      const baseUrl = await resolveBackendUrl();
      let response;
      try {
        response = await fetchImpl(`${baseUrl}/extension/collector-auth/exchange`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
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
          code: error.code,
          message: error.message,
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
        logger.warn?.('[collector-auth] exchange rejected', {
          status: error.status,
          code: error.code,
          message: error.message,
        });
        throw error;
      }
      return setCollectorSession(body?.data || body);
    }

    async function exchangeCollectorTicketWithRetry({
      requestTicket,
      deviceFingerprint,
      extensionVersion,
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
          });
        } catch (error) {
          lastError = error;
          if (error?.code !== 'COLLECTOR_TICKET_EXPIRED' || attempt === 1) throw error;
        }
      }
      throw lastError;
    }

    async function collectorFetch(path, { permission, ...options } = {}) {
      const session = await getCollectorSession();
      if (!session) {
        throw collectorError('COLLECTOR_AUTH_REQUIRED', 401, 'COLLECTOR_AUTH_REQUIRED');
      }
      if (!session.permissions.includes(permission)) {
        throw collectorError('COLLECTOR_PERMISSION_DENIED', 403, 'COLLECTOR_PERMISSION_DENIED');
      }
      const baseUrl = await resolveBackendUrl();
      const response = await fetchImpl(`${baseUrl}${String(path || '')}`, {
        ...options,
        headers: safeHeaders(options.headers, session.collectorToken),
      });
      if (response.status === 401 || response.status === 403) {
        await clearCollectorSession();
      }
      return response;
    }

    async function listPendingUploads() {
      const stored = await chromeApi.storage.local.get(PENDING_UPLOADS_STORAGE_KEY);
      const items = stored?.[PENDING_UPLOADS_STORAGE_KEY];
      return Array.isArray(items) ? items : [];
    }

    async function writePendingUploads(items) {
      await chromeApi.storage.local.set({
        [PENDING_UPLOADS_STORAGE_KEY]: Array.isArray(items) ? items : [],
      });
    }

    async function enqueuePendingUpload(upload) {
      const session = await getCollectorSession();
      const storedOwner = session
        ? null
        : (await chromeApi.storage.local.get(COLLECTOR_LAST_OWNER_KEY))?.[COLLECTOR_LAST_OWNER_KEY];
      const ownerAccountId = accountIdOf(session) || String(storedOwner?.accountId || '');
      const ownerSessionIdentity = sessionIdentityOf(session) || String(storedOwner?.sessionIdentity || '');
      if (!ownerAccountId || !ownerSessionIdentity) {
        throw collectorError('COLLECTOR_AUTH_REQUIRED', 401, 'COLLECTOR_AUTH_REQUIRED');
      }
      const requestId = String(upload?.requestId || '');
      if (!requestId) throw collectorError('COLLECT_REQUEST_ID_REQUIRED', 400, 'COLLECT_REQUEST_ID_REQUIRED');
      const queue = await listPendingUploads();
      if (queue.some((item) => item.requestId === requestId)) return queue;
      const entry = {
        requestId,
        path: String(upload?.path || ''),
        body: upload?.body && typeof upload.body === 'object' ? upload.body : {},
        ownerAccountId,
        ownerSessionIdentity,
        queuedAt: new Date(now()).toISOString(),
      };
      queue.push(entry);
      await writePendingUploads(queue);
      return queue;
    }

    async function flushPendingUploads(upload) {
      if (typeof upload !== 'function') throw new TypeError('pending upload flush requires uploader');
      const session = await getCollectorSession();
      if (!session) return { uploaded: 0, retained: (await listPendingUploads()).length, blockedAccountMismatch: 0 };
      const queue = await listPendingUploads();
      const retained = [];
      let uploaded = 0;
      let blockedAccountMismatch = 0;
      for (const item of queue) {
        if (
          item.ownerAccountId !== accountIdOf(session)
          || item.ownerSessionIdentity !== sessionIdentityOf(session)
        ) {
          blockedAccountMismatch += 1;
          retained.push(item);
          continue;
        }
        try {
          const response = await upload(item, session);
          if (response?.ok) uploaded += 1;
          else retained.push(item);
        } catch (error) {
          logger.warn?.('[collector-upload] retained after failure', {
            requestId: item.requestId,
            code: String(error?.code || 'COLLECTOR_UPLOAD_FAILED'),
            message: redactCollectorSecrets(error?.message, [session.collectorToken]),
          });
          retained.push(item);
        }
      }
      await writePendingUploads(retained);
      return { uploaded, retained: retained.length, blockedAccountMismatch };
    }

    return Object.freeze({
      clearCollectorSession,
      collectorFetch,
      enqueuePendingUpload,
      exchangeCollectorTicket,
      exchangeCollectorTicketWithRetry,
      flushPendingUploads,
      getCollectorSession,
      listPendingUploads,
      setCollectorSession,
    });
  }

  const api = Object.freeze({
    COLLECTOR_PERMISSIONS,
    COLLECTOR_LAST_OWNER_KEY,
    COLLECTOR_SESSION_STORAGE_KEY,
    PENDING_UPLOADS_STORAGE_KEY,
    createCollectorSessionManager,
    redactCollectorSecrets,
  });
  root.JzCollectorSession = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
