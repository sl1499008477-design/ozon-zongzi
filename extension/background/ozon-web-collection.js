(function (root) {
  'use strict';

  const STORAGE_KEY = 'jzOzonWebCollectionByAccount';
  const ALARM = 'jz-ozon-web-collection';
  const EVENT = 'ozonWebCollectionEvent';
  const PERMISSION = 'collector.upload';
  const staleClaim = error => ['WEB_COLLECTION_CLAIM_LOST', 'WEB_COLLECTION_NOT_FOUND', 'COLLECTOR_SESSION_CHANGED'].includes(error.code);
  const cleanMessage = value => (root.JzCollectorSession?.redactCollectorSecrets
    ? root.JzCollectorSession.redactCollectorSecrets(value)
    : String(value || '').replace(/(?:ctt|cst|csess)_[A-Za-z0-9_-]+|bearer\s+\S+/gi, '[REDACTED]')).slice(0, 300);
  const ozonUrl = value => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && ['www.ozon.ru', 'ozon.ru', 'www.ozon.kz', 'ozon.kz'].includes(url.hostname) ? url : null;
    } catch { return null; }
  };
  const productUrlMatches = (value, sku) => {
    const url = ozonUrl(value);
    return !!url && url.pathname.match(/^\/product\/(?:[^/]*-)?(\d+)\/?$/)?.[1] === String(sku);
  };

  function create({ chromeApi, sessionManager, beforeClaim = async () => {}, beforeResume = async () => {}, now = () => Date.now(),
    setInterval = (...args) => root.setInterval(...args),
    clearInterval = timer => root.clearInterval(timer),
  }) {
    let records, accountId = '', operation = null, operationKey = '', active = null, timer = null, started = false;
    let tail = Promise.resolve();
    const serialize = fn => {
      const run = tail.then(fn);
      tail = run.catch(() => {});
      return run;
    };
    const save = async () => {
      if (active) records[accountId] = active;
      else delete records[accountId];
      await chromeApi.storage.local.set({ [STORAGE_KEY]: records });
    };
    const pageJob = () => ({ ...active.job, accountId });
    const stopPage = async () => {
      if (active?.tabId != null) await chromeApi.tabs.sendMessage(active.tabId, {
        action: 'stopOzonWebCollection', job: pageJob(),
      }).catch(() => {});
    };
    const syncOwner = async () => {
      records ||= (await chromeApi.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || {};
      const current = await sessionManager.beginCollectorOperation();
      const auth = await sessionManager.getCollectorAuthSnapshot();
      const sessionKey = `${auth?.generationId || ''}|${current?.expiresAt || ''}`;
      const owner = current?.permissions?.includes(PERMISSION) ? String(current.accountId || '') : '';
      if (owner !== accountId) {
        await stopPage();
        accountId = owner;
        active = records[owner] || null;
        operation = current;
      } else if (!operation || operationKey !== sessionKey || Date.parse(operation.expiresAt) <= now()) operation = current;
      operationKey = sessionKey;
      if (owner && active && active.sessionKey !== sessionKey && !['waiting', 'reclaim', 'route'].includes(active.phase)) {
        await stopPage();
        active.phase = 'reclaim';
        await save();
      }
      return !!owner;
    };
    const request = async (suffix, body) => {
      const path = suffix === 'next' ? '/collector/ozon/web-jobs/next'
        : `/collector/ozon/web-jobs/${encodeURIComponent(active.job.id)}/${suffix}`;
      const response = await sessionManager.collectorFetch(path, {
        collectorOperation: operation, permission: PERMISSION, method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        signal: root.AbortSignal?.timeout?.(20_000),
      });
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch { /* Surface a retryable upstream error. */ }
      if (!response.ok || data?.ok !== true) throw Object.assign(new Error(cleanMessage(data?.message || '网页采集请求暂时失败')), {
        status: response.status, code: data?.code || 'WEB_COLLECT_REQUEST_FAILED',
      });
      return data.data;
    };
    const closeOwnedTab = async () => {
      if (active?.tabId == null) return;
      const tab = await chromeApi.tabs.get(active.tabId).catch(() => null);
      if (tab && productUrlMatches(tab.url, active.job.sku)) await chromeApi.tabs.remove(tab.id).catch(() => {});
    };
    const finish = async () => {
      await stopPage();
      await closeOwnedTab();
      active = null;
      await save();
    };
    const fail = async (code, message, waiting = false) => {
      active.failure = { code, message: cleanMessage(message), waiting };
      active.phase = 'failure';
      delete active.payload;
      await save();
    };
    const claim = async () => {
      let sellerRoute = active ? await beforeResume(active.sellerRoute) : await beforeClaim();
      const claimed = await request('next', {});
      if (!claimed) return false;
      if (!claimed.id || !claimed.claimFence || !/^\d+$/.test(claimed.sku)
        || !['ALL', 'CURRENT'].includes(claimed.scope) || !productUrlMatches(claimed.sourceUrl, claimed.sku)) {
        throw new Error('网页采集任务格式无效');
      }
      const sameJob = active?.job.id === claimed.id;
      const differentJob = active && !sameJob;
      if (differentJob) await finish();
      if (sameJob) await stopPage();
      active = {
        ...(sameJob ? active : {}),
        job: { id: claimed.id, sku: claimed.sku, scope: claimed.scope, sourceUrl: claimed.sourceUrl, claimFence: claimed.claimFence },
        sellerRoute: sameJob ? active.sellerRoute || sellerRoute : differentJob ? undefined : sellerRoute,
        sessionKey: operationKey, phase: differentJob ? 'route' : 'capturing', message: '扩展已领取，正在读取商品', startedAt: now(), progressAt: now(),
      };
      delete active.failure;
      await save();
      if (differentJob) {
        // A reclaim can return a different job. Persist it before route sync so
        // an offline retry cannot recapture it using the previous job's route.
        active.sellerRoute = await beforeClaim();
        active.phase = 'capturing';
        await save();
      }
      await beforeResume(active.sellerRoute);
      return true;
    };
    const flush = async () => {
      try {
        if (active.payload) {
          await request('result', { claimFence: active.job.claimFence, payload: active.payload, capturedAt: active.capturedAt });
          await finish();
          return true;
        } else if (active.failure) {
          await request('fail', { claimFence: active.job.claimFence, ...active.failure });
          if (active.failure.waiting) {
            active.phase = 'waiting';
            delete active.failure;
            await stopPage();
            await save();
            if (active.tabId != null) await chromeApi.tabs.update(active.tabId, { active: true }).catch(() => {});
          } else await finish();
        }
      } catch (error) {
        if (error.status === 401 || error.status === 403) operation = null;
        if (staleClaim(error)) {
          operation = null;
          active.phase = 'reclaim';
          await stopPage();
          await save();
        } else if ([400, 409, 422].includes(error.status) && active.payload) {
          await fail(error.code || 'COLLECT_RESULT_INVALID', error.message);
        }
        // Unknown result delivery is kept locally; the next wake retries the same fence and payload.
      }
    };
    const capture = async () => {
      let tab = active.tabId == null ? null : await chromeApi.tabs.get(active.tabId).catch(() => null);
      if (!tab) {
        tab = await chromeApi.tabs.create({ url: active.job.sourceUrl, active: false });
        active.tabId = tab.id;
        active.startedAt = now();
        await save();
      }
      if (!productUrlMatches(tab.url || tab.pendingUrl, active.job.sku)) {
        const url = ozonUrl(tab.url || tab.pendingUrl);
        const login = !!url && /\/(?:login|auth|signin)\b/.test(url.pathname);
        await fail(login ? 'ZONGZI_LOGIN_REQUIRED' : 'COLLECT_PAGE_CHANGED',
          login ? '请在已打开的 Ozon 页面完成登录，然后在网页任务中点击继续' : '商品标签页已切换，请重试该任务', login);
        return;
      }
      if (tab.status === 'loading') return;
      try {
        const ack = await chromeApi.tabs.sendMessage(tab.id, { action: 'startOzonWebCollection', job: pageJob() });
        if (ack?.ok === false) await fail(ack.code || 'COLLECT_PAGE_UNAVAILABLE', ack.message || '商品页面无法开始采集', ack.waiting === true);
      } catch {
        if (now() - active.startedAt > 60_000) await fail('COLLECT_PAGE_UNAVAILABLE', '商品页面未响应，请刷新后重试');
      }
    };
    const updateTimer = () => {
      const needed = accountId && active && !['waiting', 'reclaim'].includes(active.phase);
      if (needed && !timer) timer = setInterval(() => wake(), 15_000);
      if (!needed && timer) { clearInterval(timer); timer = null; }
    };
    const wake = () => serialize(async () => {
      try {
        if (!await syncOwner()) return;
        if (active?.phase === 'route') {
          active.sellerRoute = await beforeClaim();
          active.phase = 'capturing';
          await save();
        } else if (active && !['waiting','reclaim'].includes(active.phase)) {
          const sellerRoute = await beforeResume(active.sellerRoute);
          if (!active.sellerRoute && sellerRoute) {active.sellerRoute = sellerRoute;await save();}
        }
        if (!active || ['waiting', 'reclaim'].includes(active.phase)) {
          const previousTab = active?.tabId;
          const wasWaiting = active?.phase === 'waiting';
          if (!await claim()) return;
          if (wasWaiting && previousTab != null && previousTab === active.tabId) {
            const tab = await chromeApi.tabs.get(previousTab).catch(() => null);
            if (tab && ozonUrl(tab.url) && !productUrlMatches(tab.url, active.job.sku)) {
              await chromeApi.tabs.update(tab.id, { url: active.job.sourceUrl });
            }
          }
        }
        if (active.payload || active.failure) {
          // Advance once after a confirmed result; failures and unknown receipts keep the normal wake cadence.
          if (!await flush() || !await syncOwner() || active || !await claim()) return;
        }
        if (now() - (active.progressAt || active.startedAt) > 180_000) {
          await fail('COLLECT_CAPTURE_TIMEOUT', '商品页面超过 3 分钟没有采集进展，请重试该商品');
          await flush();
          return;
        }
        try {
          await request('progress', { claimFence: active.job.claimFence, message: active.message });
        } catch (error) {
          if (error.status === 401 || error.status === 403) operation = null;
          if (staleClaim(error)) {
            operation = null;
            active.phase = 'reclaim';
            await stopPage();
            await save();
          }
          return;
        }
        await capture();
        if (active?.failure) await flush();
      } catch { /* Offline/auth loss leaves the account-bound task available for the next wake. */ }
      finally { updateTimer(); }
    });
    const handleMessage = (message, sender) => serialize(async () => {
      if (message?.action !== EVENT || !await syncOwner() || !active || active.phase !== 'capturing'
        || sender?.id !== chromeApi.runtime.id || sender?.frameId !== 0
        || sender?.tab?.id !== active.tabId || message.accountId !== accountId
        || message.jobId !== active.job.id || message.claimFence !== active.job.claimFence || message.sku !== active.job.sku
        || !productUrlMatches(sender.url, active.job.sku)) return { ok: false };
      const tab = await chromeApi.tabs.get(active.tabId).catch(() => null);
      if (!tab || !productUrlMatches(tab.url, active.job.sku)) return { ok: false };
      if (message.kind === 'result') {
        if (!message.payload || String(message.payload.sku || '') !== active.job.sku) return { ok: false };
        if (!active.payload) {
          active.payload = message.payload;
          active.capturedAt = typeof message.capturedAt === 'string' ? message.capturedAt : new Date(now()).toISOString();
          active.phase = 'result';
        }
      } else if (message.kind === 'fail') {
        await fail(/^[A-Z][A-Z0-9_]{0,80}$/.test(message.code || '') ? message.code : 'COLLECT_CAPTURE_FAILED', message.message, message.waiting === true);
      } else if (message.kind === 'progress') {
        active.message = cleanMessage(message.message || '正在采集商品');
        active.progressAt = now();
      } else return { ok: false };
      await save();
      return { ok: true };
    });
    const start = () => {
      if (started) return;
      started = true;
      const setup = () => { chromeApi.alarms.create(ALARM, { periodInMinutes: 0.5 }); void wake(); };
      chromeApi.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) void wake(); });
      chromeApi.runtime.onStartup.addListener(setup);
      chromeApi.runtime.onInstalled.addListener(setup);
      chromeApi.storage.onChanged.addListener((_changes, area) => { if (area === 'session') void wake(); });
      chromeApi.tabs.onUpdated.addListener((tabId, change) => { if (tabId === active?.tabId && change.status === 'complete') void wake(); });
      chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.action !== EVENT) return false;
        handleMessage(message, sender).then(result => { sendResponse(result); if (result.ok) void wake(); }, () => sendResponse({ ok: false }));
        return true;
      });
      setup();
    };
    const ready = serialize(syncOwner);
    return Object.freeze({ ready, start, wake, handleMessage, isBusy: () => Boolean(active && active.phase !== 'route') });
  }

  root.JzOzonWebCollection = { create };
  if (typeof module !== 'undefined') module.exports = root.JzOzonWebCollection;
})(globalThis);
