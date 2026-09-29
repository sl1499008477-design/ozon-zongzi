// The API owns admission, background work and the shared database, in that order.
export function createApiLifecycle({ server, stopScheduling, drainBackground, closeResources,
  signals = process, logger = console }) {
  let stopping = false, shutdownPromise;
  const requests = new Set(), runtimes = new Set();
  const invoke = operation => { try { return Promise.resolve(operation()); } catch (error) { return Promise.reject(error); } };

  function trackRequest(operation) {
    const request = invoke(operation);
    requests.add(request);
    request.then(() => requests.delete(request), () => requests.delete(request));
    return request;
  }

  function start(runtime, ...args) {
    if (stopping) return Promise.resolve();
    const record = { runtime, starting: invoke(() => runtime.start(...args)) };
    runtimes.add(record);
    const starting = record.starting;
    starting.then(() => { record.starting = null; }, () => { record.starting = null; });
    return starting;
  }

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    // An unresolved promise alone does not keep Node alive. Never exit 0 while
    // a drain is outstanding, even if its remaining operation has no handles.
    signals.exitCode = 1;
    const keepAlive = setInterval(() => {}, 1000);
    const closed = new Promise((resolve, reject) => {
      server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
      server.closeIdleConnections?.();
    });
    const scheduling = invoke(stopScheduling);
    const workers = [...runtimes].flatMap(({ runtime, starting }) => {
      const stopped = invoke(() => runtime.stop());
      // Some existing runtimes initialize asynchronously before setting their
      // running flag. Stop again in that same microtask, before any timer fires.
      return starting ? [stopped, starting.then(() => runtime.stop())] : [stopped];
    });
    shutdownPromise = (async () => {
      try {
        const results = await Promise.allSettled([closed, scheduling, ...requests, ...workers, invoke(drainBackground)]);
        if (results.some(result => result.status === 'rejected')) throw new Error('API drain failed');
        await closeResources();
        signals.exitCode = 0;
      } catch {
        logger.error('[api] graceful shutdown failed; clean shutdown was not completed');
      } finally {
        clearInterval(keepAlive);
      }
    })();
    return shutdownPromise;
  }

  signals.on('SIGTERM', shutdown);
  signals.on('SIGINT', shutdown);
  return { start, trackRequest, shutdown, get stopping() { return stopping; } };
}
