/**
 * Local Browser Agent runtime.
 *
 * This module keeps the extension registered as an online browser executor,
 * claims one queued job at a time, runs a local allow-listed action, and posts
 * progress/result/failure back to the backend.
 */
(() => {
  const STORAGE_KEY = 'jzBrowserAgent:device';
  const STATE_KEY = 'jzBrowserAgent:state';
  const DEFAULT_DEVICE_NAME = 'Chrome Browser Agent';
  // register 被 4xx 拒后的冷却时长。生产实测(18.5h 窗口)register 被调 9.1 万次、
  // 99.5% 返回 403(子账号无 settings.write 权限被 PermissionsGuard 拒),旧逻辑
  // 每分钟无退避重试。冷却 1h:无权限机器从 60 req/h 降到 ~1 req/h,权限/套餐
  // 修复后最迟 1h 自动恢复。
  const REGISTER_COOLDOWN_MS = 60 * 60 * 1000;
  let ctx = null;
  let running = false;
  let activeJob = null;
  let activeDeviceId = null;
  let cancelRequested = false;

  async function getStorage(keys) {
    return chrome.storage.local.get(keys);
  }

  async function setStorage(values) {
    return chrome.storage.local.set(values);
  }

  function setContext(next) {
    ctx = next;
  }

  function ensureContext() {
    if (!ctx) throw new Error('JzBrowserAgentRuntime not initialized');
    if (!globalThis.JzBackendClient) throw new Error('JzBackendClient not available');
    if (!globalThis.JzBrowserAgentActions) {
      throw new Error('JzBrowserAgentActions not available');
    }
  }

  // 能力快照:优先用 capabilitiesAsync(含动态能力位,如"已登录 seller.ozon.ru"
  // 的 ozon.seller_collect),不可用时回退静态 capabilities()。失败绝不阻塞心跳。
  async function currentCapabilities() {
    const actions = globalThis.JzBrowserAgentActions;
    if (actions?.capabilitiesAsync) {
      try {
        return await actions.capabilitiesAsync();
      } catch {
        // ignore — 回退静态能力
      }
    }
    return actions?.capabilities ? actions.capabilities() : [];
  }

  function capsKeyOf(list) {
    return [...new Set(list || [])].sort().join(',');
  }

  async function devicePayload() {
    const manifest = chrome.runtime.getManifest() || {};
    const deviceKey = await ctx.getDeviceKey();
    return {
      deviceKey,
      deviceName: ctx.getDeviceName ? await ctx.getDeviceName() : DEFAULT_DEVICE_NAME,
      extensionId: chrome.runtime.id,
      extensionVersion: String(manifest.version || ''),
      capabilities: await currentCapabilities(),
    };
  }

  async function ensureRegistered() {
    ensureContext();
    const manifestVersion = String(chrome.runtime.getManifest()?.version || '');
    const stored = await getStorage([STORAGE_KEY]);
    const current = stored[STORAGE_KEY] || {};
    if (current.deviceId) {
      try {
        const caps = await currentCapabilities();
        const heartbeat = await globalThis.JzBackendClient.heartbeatBrowserAgent({
          deviceId: current.deviceId,
          extensionVersion: manifestVersion,
          capabilities: caps,
        });
        const deviceId = heartbeat?.id || current.deviceId;
        // 记下已上报的版本号 + 能力指纹 → tick 快路径据此跳过冗余心跳;能力位变化
        // (如登入/登出 seller.ozon.ru 致 ozon.seller_collect 增减)会触发重新心跳。
        // 显式建对象(不 spread current):心跳成功即清掉历史 registerBlockedUntil。
        await setStorage({
          [STORAGE_KEY]: {
            deviceId,
            heartbeatVersion: manifestVersion,
            capsKey: capsKeyOf(caps),
            at: current.at,
          },
        });
        return deviceId;
      } catch (e) {
        // Device may have been revoked or dropped during local development.
        console.warn('[browser-agent] heartbeat failed, re-registering:', e?.message || e);
      }
    }

    let registered;
    try {
      registered = await globalThis.JzBackendClient.registerBrowserAgent(
        await devicePayload(),
      );
    } catch (e) {
      // 4xx(典型:无 settings.write 权限 403 / 登录态失效 401)→ 落冷却标记,
      // tick 在冷却期内完全静默,杜绝每分钟重试的热循环。5xx/网络错不冷却,
      // 下一 tick 照常重试(生产里仅零星 502)。
      if (e?.status === 401 || e?.status === 403) {
        await setStorage({
          [STORAGE_KEY]: { registerBlockedUntil: Date.now() + REGISTER_COOLDOWN_MS },
        });
      }
      throw e;
    }
    await setStorage({
      [STORAGE_KEY]: {
        deviceId: registered.id,
        heartbeatVersion: manifestVersion,
        capsKey: capsKeyOf(registered.capabilities || []),
        at: Date.now(),
      },
    });
    return registered.id;
  }

  async function setState(patch) {
    const current = (await getStorage([STATE_KEY]))[STATE_KEY] || {};
    await setStorage({
      [STATE_KEY]: {
        ...current,
        ...patch,
        updatedAt: Date.now(),
      },
    });
  }

  async function clearState() {
    await setStorage({
      [STATE_KEY]: {
        running: false,
        jobId: null,
        type: null,
        stage: null,
        message: null,
        percent: null,
        cancelRequested: false,
        updatedAt: Date.now(),
      },
    });
  }

  async function getState() {
    const stored = await getStorage([STATE_KEY]);
    return stored[STATE_KEY] || { running: false };
  }

  async function requestCancel(jobId) {
    if (!activeJob || (jobId && activeJob.id !== jobId)) {
      return { ok: false, error: 'No matching browser-agent job is running' };
    }
    cancelRequested = true;
    await setState({ cancelRequested: true, message: 'Cancellation requested' });
    return { ok: true, jobId: activeJob.id };
  }

  function cancellationError() {
    const err = new Error('Browser agent job cancelled by user');
    err.code = 'USER_CANCELLED';
    return err;
  }

  async function tick() {
    ensureContext();
    if (running) return;
    running = true;
    activeJob = null;
    activeDeviceId = null;
    cancelRequested = false;
    try {
      // 快路径:已注册且扩展版本没变 → 跳过独立心跳 POST,直接 claim。
      // backend claimNextJob 内部本来就会 heartbeat 续活(browser-agent.service.ts:314),
      // 独立心跳对活性完全冗余 —— 生产实测它占 browser-agents 流量一半(~7 req/s,
      // 与 jobs/next 次数 1:1)。版本变更(扩展升级)或从未注册才走 ensureRegistered
      // 完整心跳,把 extensionVersion/capabilities 推给后端(兼容性派发依赖它们)。
      const manifestVersion = String(chrome.runtime.getManifest()?.version || '');
      const cached = (await getStorage([STORAGE_KEY]))[STORAGE_KEY] || {};
      // 注册曾被 401/403 拒(无权限/登录态失效)→ 冷却期内零请求静默退出
      if (
        !cached.deviceId &&
        cached.registerBlockedUntil &&
        Date.now() < cached.registerBlockedUntil
      ) {
        return;
      }
      // 能力指纹漂移(典型:用户刚登入/登出 seller.ozon.ru)→ 必须先把新能力位
      // 心跳上报,否则后端按旧能力派发,代采任务会派错或派不出去。
      const capsKey = capsKeyOf(await currentCapabilities());
      let deviceId;
      let next;
      if (
        cached.deviceId &&
        cached.heartbeatVersion === manifestVersion &&
        cached.capsKey === capsKey
      ) {
        deviceId = cached.deviceId;
        activeDeviceId = deviceId;
        try {
          next = await globalThis.JzBackendClient.claimNextBrowserAgentJob(deviceId);
        } catch (e) {
          // 设备行可能被撤销/丢失 → 走完整 ensureRegistered(心跳失败自动重注册)再试一次
          deviceId = await ensureRegistered();
          activeDeviceId = deviceId;
          next = await globalThis.JzBackendClient.claimNextBrowserAgentJob(deviceId);
        }
      } else {
        deviceId = await ensureRegistered();
        activeDeviceId = deviceId;
        next = await globalThis.JzBackendClient.claimNextBrowserAgentJob(deviceId);
      }
      const job = next?.job;
      if (!job) return;
      activeJob = job;
      await setState({
        running: true,
        jobId: job.id,
        type: job.type,
        stage: 'claimed',
        message: `Claimed ${job.type}`,
        percent: 0,
        cancelRequested: false,
        startedAt: Date.now(),
      });

      await globalThis.JzBackendClient.reportBrowserAgentJobProgress(job.id, {
        deviceId,
        stage: 'running',
        message: `Running ${job.type}`,
        percent: 1,
      });
      await setState({ stage: 'running', message: `Running ${job.type}`, percent: 1 });

      const reportProgress = async (progress) => {
        await setState({
          stage: progress?.stage || 'running',
          message: progress?.message || null,
          percent: progress?.percent ?? null,
          payload: progress?.payload || null,
        });
        return globalThis.JzBackendClient.reportBrowserAgentJobProgress(job.id, {
          deviceId,
          ...(progress || {}),
        });
      };

      const result = await globalThis.JzBrowserAgentActions.run(job, {
        deviceId,
        reportProgress,
        isCancelled: () => cancelRequested,
        throwIfCancelled: () => {
          if (cancelRequested) throw cancellationError();
        },
      });
      if (cancelRequested) throw cancellationError();
      await globalThis.JzBackendClient.completeBrowserAgentJob(job.id, {
        deviceId,
        result: result && typeof result === 'object' ? result : { value: result },
      });
    } catch (e) {
      if (activeJob && activeDeviceId) {
        try {
          await globalThis.JzBackendClient.failBrowserAgentJob(activeJob.id, {
            deviceId: activeDeviceId,
            code: e?.code || 'BROWSER_AGENT_RUNTIME_ERROR',
            message: e?.message || String(e),
            data: { type: activeJob.type },
          });
        } catch (reportError) {
          console.warn('[browser-agent] fail report failed:', reportError?.message || reportError);
        }
      }
      console.warn('[browser-agent] tick failed:', e?.message || e);
    } finally {
      activeJob = null;
      activeDeviceId = null;
      cancelRequested = false;
      await clearState().catch(() => {});
      running = false;
    }
  }

  globalThis.JzBrowserAgentRuntime = {
    setContext,
    ensureRegistered,
    getState,
    requestCancel,
    tick,
  };
})();
