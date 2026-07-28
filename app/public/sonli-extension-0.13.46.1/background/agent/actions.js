/**
 * Browser Agent action registry.
 *
 * Only actions registered here can be executed from server jobs. The server
 * never sends executable JavaScript; it sends a typed job that resolves to one
 * of these local handlers.
 */
(() => {
  const handlers = new Map();
  // 动态能力位:不对应可执行 handler,而是运行期条件(如"已登录 seller.ozon.ru")。
  // 每个 probe 返回 boolean(可 async);仅当 probe 为真时该能力位才上报给后端,
  // 用于 claimNextJob 的 requiredCapabilities 过滤(让未登录设备领不到代采任务)。
  const dynamicCapabilities = new Map();

  function register(type, handler) {
    if (!type || typeof handler !== 'function') {
      throw new Error('Invalid browser-agent action registration');
    }
    handlers.set(type, handler);
  }

  function registerDynamicCapability(name, probe) {
    if (!name || typeof probe !== 'function') {
      throw new Error('Invalid browser-agent dynamic capability registration');
    }
    dynamicCapabilities.set(name, probe);
  }

  function capabilities() {
    return Array.from(handlers.keys());
  }

  // 异步能力快照:静态 handler 能力 + 当前为真的动态能力位。runtime 据此上报,
  // 任一 probe 失败按"不具备"处理,绝不阻塞心跳。
  async function capabilitiesAsync() {
    const base = Array.from(handlers.keys());
    const dynamic = [];
    for (const [name, probe] of dynamicCapabilities.entries()) {
      try {
        if (await probe()) dynamic.push(name);
      } catch {
        // probe 失败 → 视为不具备该能力
      }
    }
    return [...base, ...dynamic];
  }

  async function run(job, context = {}) {
    const handler = handlers.get(job?.type);
    if (!handler) {
      const err = new Error(`Unsupported browser-agent action: ${job?.type || ''}`);
      err.code = 'UNSUPPORTED_ACTION';
      throw err;
    }
    return handler(job, context);
  }

  register('agent.ping', async (job) => ({
    pong: true,
    params: job?.params || {},
    at: new Date().toISOString(),
  }));

  globalThis.JzBrowserAgentActions = {
    register,
    registerDynamicCapability,
    capabilities,
    capabilitiesAsync,
    run,
  };
})();
