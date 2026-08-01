const assert = require('node:assert/strict');
const test = require('node:test');

require('../lib/ozon-enrichment-contract.js');
const { create: createAgentFactory } = require('../background/collector-ozon-enrichment-agent.js');
const { create: createClient } = require('../background/collector-ozon-enrichment-client.js');

const READ_PERMISSION = 'collector.ozon.read';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body); },
  };
}

function completeVariantData(sku, overrides = {}) {
  return {
    description_category_id: 123,
    type_id: 456,
    attributes: [
      { key: '4497', value: '500' },
      { key: '9454', value: '300' },
      { key: '9455', value: '200' },
      { key: '9456', value: '100' },
    ],
    _searchMeta: { skus: [{ sku }] },
    ...overrides,
  };
}

function projectedVariantData(variantData) {
  return {
    description_category_id: variantData.description_category_id,
    type_id: variantData.type_id,
    weight: Number(variantData.attributes.find(({ key }) => key === '4497').value),
    depth: Number(variantData.attributes.find(({ key }) => key === '9454').value),
    width: Number(variantData.attributes.find(({ key }) => key === '9455').value),
    height: Number(variantData.attributes.find(({ key }) => key === '9456').value),
    attributes: variantData.attributes,
  };
}

function captureContext() {
  return {
    sellerCompanyId: '2681910',
    revision: 4,
    observedAt: '2026-08-01T08:00:00.000Z',
  };
}

function completeResult(sku) {
  const variantData = completeVariantData(sku);
  return {
    status: 'COMPLETE',
    contractVersion: 'collector.ozon.enrichment.v1',
    sku,
    descriptionCategoryId: 123,
    typeId: 456,
    logistics: { weightG: 500, lengthMm: 300, widthMm: 200, heightMm: 100 },
    variantData,
    source: 'BACKEND_FLEET',
    capturedAt: '2026-07-31T00:00:00.000Z',
    cache: { hit: false, expiresAt: '2026-07-31T06:00:00.000Z' },
  };
}

function operation(permissions = [READ_PERMISSION]) {
  return Object.freeze({ permissions: Object.freeze([...permissions]) });
}

function createAgent(options = {}) {
  const sellerContextRuntime = options.sellerContextRuntime || {
    async resolveCurrentWithRecovery() {
      return {
        status: 'READY',
        companyId: '2681910',
        revision: 4,
        observedAt: Date.parse('2026-08-01T08:00:00.000Z'),
        sellerTabId: 9,
      };
    },
    async isSnapshotCurrent() { return true; },
  };
  return createAgentFactory({ ...options, sellerContextRuntime });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function leaseHandle(promise, releaseToken = Object.freeze({})) {
  const handle = Promise.resolve(promise).then((value) => value);
  Object.defineProperty(handle, 'releaseToken', {
    value: releaseToken,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return handle;
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function settleWithin(promise, milliseconds = 150) {
  return Promise.race([
    promise.then(() => 'settled'),
    new Promise((resolve) => setTimeout(() => resolve('timed-out'), milliseconds)),
  ]);
}

test('single client request requires read permission and drains concurrently on fixed routes', async () => {
  const publicResponse = deferred();
  const calls = [];
  const drain = deferred();
  const releaseToken = Object.freeze({ client: 'request-one' });
  const agent = {
    drainUntil(input) {
      calls.push(['drain', input]);
      return leaseHandle(drain.promise, releaseToken);
    },
    stop(requestId, token) {
      calls.push(['stop', requestId, token]);
      drain.resolve();
    },
  };
  const sessionManager = {
    async beginCollectorOperation() {
      calls.push(['begin']);
      return operation();
    },
    collectorFetch(path, options) {
      calls.push(['fetch', path, options]);
      return publicResponse.promise;
    },
  };
  let backendLookup = 0;
  const client = createClient({
    sessionManager,
    agent,
    getBackendUrl: async () => {
      backendLookup += 1;
      return 'https://attacker.invalid/ozon/sync';
    },
  });

  const pending = client.enrich({ requestId: 'request-one', sku: '4862904234' });
  await nextTurn();

  const fetchCall = calls.find(([kind]) => kind === 'fetch');
  assert.ok(fetchCall, 'public request must start before its response resolves');
  assert.ok(calls.some(([kind]) => kind === 'drain'), 'executor drain must start concurrently');
  assert.equal(fetchCall[1], '/collector/ozon/enrich');
  assert.equal(fetchCall[2].permission, READ_PERMISSION);
  assert.deepEqual(JSON.parse(fetchCall[2].body), {
    requestId: 'request-one',
    sku: '4862904234',
  });
  assert.equal(backendLookup, 0, 'client must not construct an arbitrary backend URL');

  publicResponse.resolve(jsonResponse(200, { ok: true, data: completeResult('4862904234') }));
  const result = await pending;
  assert.equal(result.sku, '4862904234');
  assert.deepEqual(
    calls.find(([kind]) => kind === 'stop'),
    ['stop', 'request-one', releaseToken],
  );
});

test('client aborts a held public request at twenty seconds with a stable retryable error', async () => {
  const never = new Promise(() => {});
  const timers = [];
  let aborted = false;
  const releaseToken = Object.freeze({ client: 'request-deadline' });
  const releases = [];
  const client = createClient({
    sessionManager: {
      async beginCollectorOperation() { return operation(); },
      async collectorFetch(_path, options) {
        options.signal?.addEventListener('abort', () => { aborted = true; });
        return never;
      },
    },
    agent: {
      drainUntil() { return leaseHandle(never, releaseToken); },
      stop(requestId, token) { releases.push([requestId, token]); },
    },
    getBackendUrl: async () => '',
    now: () => 1_000,
    setTimer(callback, milliseconds) {
      timers.push(milliseconds);
      queueMicrotask(callback);
      return 1;
    },
    clearTimer() {},
  });

  const outcome = await Promise.race([
    assert.rejects(
      client.enrich({ requestId: 'request-deadline', sku: '4862904234' }),
      (error) => error?.status === 504
        && error?.code === 'OZON_ENRICH_UPSTREAM_FAILED'
        && error?.retryable === true,
    ).then(() => 'settled'),
    new Promise((resolve) => setTimeout(() => resolve('timed-out'), 150)),
  ]);
  assert.equal(outcome, 'settled');
  assert.deepEqual(timers, [20_000]);
  assert.equal(aborted, true);
  assert.deepEqual(releases, [['request-deadline', releaseToken]]);
});

test('client releases its opaque lease when drain startup or the public response rejects', async (t) => {
  await t.test('rejected drain handle', async () => {
    const releaseToken = Object.freeze({ client: 'drain-reject' });
    const releases = [];
    const client = createClient({
      sessionManager: {
        async beginCollectorOperation() { return operation(); },
        async collectorFetch() {
          return jsonResponse(200, { ok: true, data: completeResult('4862904234') });
        },
      },
      agent: {
        drainUntil() { return leaseHandle(Promise.reject(new Error('drain failed')), releaseToken); },
        stop(requestId, token) { releases.push([requestId, token]); },
      },
      getBackendUrl: async () => '',
    });

    const result = await client.enrich({ requestId: 'request-drain-reject', sku: '4862904234' });
    assert.equal(result.sku, '4862904234');
    assert.deepEqual(releases, [['request-drain-reject', releaseToken]]);
  });

  await t.test('rejected public response', async () => {
    const releaseToken = Object.freeze({ client: 'response-reject' });
    const releases = [];
    const drain = deferred();
    const client = createClient({
      sessionManager: {
        async beginCollectorOperation() { return operation(); },
        async collectorFetch() { throw new Error('network failed'); },
      },
      agent: {
        drainUntil() { return leaseHandle(drain.promise, releaseToken); },
        stop(requestId, token) {
          releases.push([requestId, token]);
          drain.resolve();
        },
      },
      getBackendUrl: async () => '',
    });

    await assert.rejects(
      client.enrich({ requestId: 'request-response-reject', sku: '4862904234' }),
      /network failed/,
    );
    assert.deepEqual(releases, [['request-response-reject', releaseToken]]);
  });
});

test('client rejects missing permission and arbitrary single-request fields before any fetch or claim', async () => {
  let fetches = 0;
  let drains = 0;
  const sessionManager = {
    async beginCollectorOperation() { return operation(['collector.upload']); },
    async collectorFetch() { fetches += 1; },
  };
  const agent = {
    async drainUntil() { drains += 1; },
    stop() {},
  };
  const client = createClient({ sessionManager, agent, getBackendUrl: async () => '' });

  await assert.rejects(
    client.enrich({ requestId: 'request-no-permission', sku: '4862904234' }),
    (error) => error?.status === 403 && error?.code === 'COLLECTOR_PERMISSION_DENIED',
  );
  for (const extra of [
    { storeId: 'store-attacker' },
    { companyId: 'company-attacker' },
    { action: 'sync' },
    { url: 'https://attacker.invalid' },
    { script: 'steal()' },
    { headers: { Authorization: 'Bearer secret' } },
    { cookie: 'secret=1' },
  ]) {
    await assert.rejects(
      client.enrich({ requestId: 'request-invalid', sku: '4862904234', ...extra }),
      (error) => error?.status === 400 && error?.code === 'OZON_ENRICH_REQUEST_INVALID',
    );
  }
  assert.equal(fetches, 0);
  assert.equal(drains, 0);
});

test('client rejects non-string request IDs and SKUs before Collector fetch', async () => {
  let fetches = 0;
  const client = createClient({
    sessionManager: {
      async beginCollectorOperation() { return operation(); },
      async collectorFetch() { fetches += 1; },
    },
    agent: { async drainUntil() {}, stop() {} },
    getBackendUrl: async () => '',
  });

  for (const input of [
    { requestId: { arbitrary: true }, sku: '4862904234' },
    { requestId: 'request-type', sku: 4862904234 },
  ]) {
    await assert.rejects(
      client.enrich(input),
      (error) => error?.status === 400 && /^OZON_ENRICH_/.test(error?.code || ''),
    );
  }
  await assert.rejects(
    client.enrichBatch({ requestId: 'batch-type', skus: ['4862904234', { sku: 'bad' }] }),
    (error) => error?.status === 400 && error?.code === 'OZON_ENRICH_SKU_REQUIRED',
  );
  assert.equal(fetches, 0);
});

test('agent does not claim while trusted Seller context is unavailable and sleeps at 250ms', async () => {
  const fetches = [];
  const sleeps = [];
  let agent;
  agent = createAgent({
    sessionManager: {
      async beginCollectorOperation() { return operation(); },
      async collectorFetch(path) { fetches.push(path); },
    },
    async canCapture() { return false; },
    async captureVariant() { throw new Error('capture must not run'); },
    async sleep(milliseconds) {
      sleeps.push(milliseconds);
      agent.stop('request-no-context');
    },
  });

  await agent.drainUntil({
    requestId: 'request-no-context',
    deadlineAt: Date.now() + 1_000,
  });

  assert.deepEqual(fetches, []);
  assert.deepEqual(sleeps, [250]);
});

test('agent releases a resolved Seller lease when snapshot normalization fails', async () => {
  const malformedSnapshot = {
    status: 'READY',
    companyId: '',
    revision: 4,
    observedAt: Date.parse('2026-08-01T08:00:00.000Z'),
    sellerTabId: 9,
  };
  const released = [];
  let agent;
  agent = createAgent({
    sessionManager: {
      async beginCollectorOperation() { return operation(); },
      async collectorFetch() { throw new Error('an invalid snapshot must not claim'); },
    },
    sellerContextRuntime: {
      async resolveCurrentWithRecovery() { return malformedSnapshot; },
      async isSnapshotCurrent() { return false; },
      async releaseSnapshot(snapshot) { released.push(snapshot); return true; },
    },
    async canCapture() { return true; },
    async captureVariant() { throw new Error('capture must not run'); },
    async sleep() { agent.stop('request-invalid-snapshot'); },
  });

  await agent.drainUntil({
    requestId: 'request-invalid-snapshot',
    deadlineAt: Date.now() + 1_000,
  });

  assert.deepEqual(released, [malformedSnapshot]);
});

test('agent releases a Seller lease that resolves after its drain is cancelled', async () => {
  const resolution = deferred();
  const snapshot = {
    status: 'READY',
    companyId: '2681910',
    revision: 4,
    observedAt: Date.parse('2026-08-01T08:00:00.000Z'),
    sellerTabId: 9,
  };
  const released = [];
  let resolving = false;
  const agent = createAgent({
    sessionManager: {
      async beginCollectorOperation() { return operation(); },
      async collectorFetch() { throw new Error('a cancelled drain must not claim'); },
    },
    sellerContextRuntime: {
      async resolveCurrentWithRecovery() { resolving = true; return resolution.promise; },
      async isSnapshotCurrent() { return false; },
      async releaseSnapshot(value) { released.push(value); return true; },
    },
    async canCapture() { return true; },
    async captureVariant() { throw new Error('capture must not run'); },
    async sleep() {},
  });
  const drain = agent.drainUntil({
    requestId: 'request-late-snapshot',
    deadlineAt: Date.now() + 1_000,
  });
  while (!resolving) await nextTurn();

  agent.stop('request-late-snapshot');
  assert.equal(await settleWithin(drain), 'settled');
  resolution.resolve(snapshot);
  await nextTurn();

  assert.deepEqual(released, [snapshot]);
});

test('autonomous drain discards a result after Seller revision changes and reports the stable retryable failure', async () => {
  const requests = [];
  const captures = [];
  let nextCalls = 0;
  let revision = 4;
  const agent = createAgent({
    sessionManager: {
      async beginCollectorOperation() { return operation(); },
      async collectorFetch(path, options) {
        requests.push({ path, options });
        if (path.endsWith('/next')) {
          nextCalls += 1;
          return jsonResponse(200, nextCalls === 1 ? {
            ok: true,
            job: {
              id: 'job-context-switch',
              requestId: 'request-context-switch',
              sku: '4862904234',
              refreshBundle: false,
              claimFence: 'claim-context-switch',
            },
          } : { ok: true, job: null });
        }
        return jsonResponse(200, { ok: true });
      },
    },
    sellerContextRuntime: {
      async resolveCurrentWithRecovery() {
        return {
          status: 'READY', companyId: '2681910', revision, observedAt: Date.parse('2026-08-01T08:00:00.000Z'), sellerTabId: 9,
        };
      },
      async isSnapshotCurrent(snapshot) {
        return snapshot.companyId === '2681910' && snapshot.revision === revision;
      },
    },
    async canCapture() { return true; },
    async captureVariant(input) {
      captures.push(input);
      revision = 5;
      return { ok: true, data: { items: [completeVariantData('4862904234')] } };
    },
    async sleep() {},
  });

  await agent.drainAvailable({ deadlineAt: Date.now() + 2_000 });

  assert.equal(captures.length, 1);
  assert.equal(captures[0].sellerContext.companyId, '2681910');
  assert.equal(captures[0].sellerContext.revision, 4);
  assert.equal(requests.some(({ path }) => path.endsWith('/result')), false);
  const failure = requests.find(({ path }) => path.endsWith('/fail'));
  assert.ok(failure);
  assert.deepEqual(JSON.parse(failure.options.body), {
    code: 'SELLER_CONTEXT_CHANGED',
    message: 'Seller 店铺上下文已变化',
    captureContext: {
      sellerCompanyId: '2681910',
      revision: 4,
      observedAt: '2026-08-01T08:00:00.000Z',
    },
    claimFence: 'claim-context-switch',
  });
});

test('agent preserves a server Seller-context rejection and reports CHANGED without retrying result', async () => {
  const requests = [];
  const events = [];
  let nextCalls = 0;
  const snapshot = {
    status: 'READY',
    companyId: '2681910',
    revision: 4,
    observedAt: Date.parse('2026-08-01T08:00:00.000Z'),
    sellerTabId: 9,
  };
  const agent = createAgent({
    sessionManager: {
      async beginCollectorOperation() { return operation(); },
      async collectorFetch(path, options) {
        requests.push({ path, options });
        if (path.endsWith('/next')) {
          nextCalls += 1;
          return jsonResponse(200, nextCalls === 1 ? {
            ok: true,
            job: {
              id: 'job-server-context-change',
              requestId: 'request-server-context-change',
              sku: '4862904234',
              refreshBundle: false,
              claimFence: 'claim-server-context-change',
            },
          } : { ok: true, job: null });
        }
        if (path.endsWith('/result')) {
          events.push('result');
          return jsonResponse(409, { ok: false, code: 'SELLER_CONTEXT_CHANGED' });
        }
        events.push('fail');
        return jsonResponse(200, { ok: true });
      },
    },
    sellerContextRuntime: {
      async resolveCurrentWithRecovery() { return snapshot; },
      async isSnapshotCurrent() { events.push('check'); return true; },
      async releaseSnapshot() { events.push('release'); },
    },
    async canCapture() { return true; },
    async captureVariant() {
      events.push('capture');
      return { ok: true, data: { items: [completeVariantData('4862904234')] } };
    },
    async sleep() {},
  });

  await agent.drainAvailable({ deadlineAt: Date.now() + 2_000 });

  assert.deepEqual(events.slice(0, 4), ['capture', 'check', 'result', 'fail']);
  assert.equal(requests.filter(({ path }) => path.endsWith('/result')).length, 1);
  const failure = requests.find(({ path }) => path.endsWith('/fail'));
  assert.deepEqual(JSON.parse(failure.options.body), {
    code: 'SELLER_CONTEXT_CHANGED',
    message: 'Seller 店铺上下文已变化',
    captureContext: {
      sellerCompanyId: '2681910',
      revision: 4,
      observedAt: '2026-08-01T08:00:00.000Z',
    },
    claimFence: 'claim-server-context-change',
  });
});

test('autonomous drain queues one empty-stop rerun when a kick arrives during an active claim', async () => {
  const firstClaim = deferred();
  let nextCalls = 0;
  let activeClaims = 0;
  let maxActiveClaims = 0;
  const agent = createAgent({
    sessionManager: {
      async beginCollectorOperation() { return operation(); },
      async collectorFetch(path) {
        assert.equal(path, '/collector/ozon/enrichment-jobs/next');
        nextCalls += 1;
        activeClaims += 1;
        maxActiveClaims = Math.max(maxActiveClaims, activeClaims);
        try {
          if (nextCalls === 1) await firstClaim.promise;
          return jsonResponse(200, { ok: true, job: null });
        } finally {
          activeClaims -= 1;
        }
      },
    },
    async canCapture() { return true; },
    async captureVariant() { throw new Error('empty drains must not capture'); },
    async sleep() {},
  });

  const firstKick = agent.drainAvailable({ deadlineAt: Date.now() + 2_000 });
  await nextTurn();
  assert.equal(nextCalls, 1);
  const secondKick = agent.drainAvailable({ deadlineAt: Date.now() + 2_000 });
  assert.strictEqual(secondKick, firstKick, 'overlapping kicks must share one outward promise');

  firstClaim.resolve();
  await Promise.all([firstKick, secondKick]);

  assert.equal(nextCalls, 2, 'the kick observed during the first round must run one more claim');
  assert.equal(maxActiveClaims, 1, 'available drain rounds must remain single-concurrency');
});

test('autonomous drain serially consumes a finite stream of kicks and then settles', async () => {
  const claimGates = [deferred(), deferred()];
  let claims = 0;
  let activeClaims = 0;
  let maxActiveClaims = 0;
  const agent = createAgent({
    sessionManager: {
      async beginCollectorOperation() { return operation(); },
      async collectorFetch(path) {
        assert.equal(path, '/collector/ozon/enrichment-jobs/next');
        const claimIndex = claims;
        claims += 1;
        activeClaims += 1;
        maxActiveClaims = Math.max(maxActiveClaims, activeClaims);
        try {
          if (claimGates[claimIndex]) await claimGates[claimIndex].promise;
          return jsonResponse(200, { ok: true, job: null });
        } finally {
          activeClaims -= 1;
        }
      },
    },
    async canCapture() { return true; },
    async captureVariant() { throw new Error('empty drains must not capture'); },
    async sleep() {},
  });

  const firstKick = agent.drainAvailable({ deadlineAt: Date.now() + 2_000 });
  await nextTurn();
  const secondKick = agent.drainAvailable({ deadlineAt: Date.now() + 2_000 });
  claimGates[0].resolve();
  while (claims < 2) await nextTurn();
  const thirdKick = agent.drainAvailable({ deadlineAt: Date.now() + 2_000 });
  claimGates[1].resolve();

  assert.strictEqual(secondKick, firstKick);
  assert.strictEqual(thirdKick, firstKick);
  await Promise.all([firstKick, secondKick, thirdKick]);
  assert.equal(claims, 3, 'each finite active-window kick must be covered exactly once');
  assert.equal(maxActiveClaims, 1, 'continuous kicks must never overlap claims');
});

test('autonomous drain parks operation-start failures until a later kick retries them', async (t) => {
  for (const scenario of [
    { name: 'rejected operation', firstOperation: async () => { throw new Error('session unavailable'); } },
    { name: 'missing permission', firstOperation: async () => operation([]) },
  ]) {
    await t.test(scenario.name, async () => {
      let operationStarts = 0;
      let claims = 0;
      const agent = createAgent({
        sessionManager: {
          async beginCollectorOperation() {
            operationStarts += 1;
            return operationStarts === 1 ? scenario.firstOperation() : operation();
          },
          async collectorFetch(path) {
            assert.equal(path, '/collector/ozon/enrichment-jobs/next');
            claims += 1;
            return jsonResponse(200, { ok: true, job: null });
          },
        },
        async canCapture() { return true; },
        async captureVariant() { throw new Error('empty drains must not capture'); },
        async sleep() {},
      });

      await agent.drainAvailable({ deadlineAt: Date.now() + 2_000 });
      assert.equal(operationStarts, 1, 'a finite kick must not spin on a non-lifecycle failure');
      assert.equal(claims, 0);

      await agent.drainAvailable({ deadlineAt: Date.now() + 2_000 });
      assert.equal(operationStarts, 2, 'the next external kick must retry the parked generation');
      assert.equal(claims, 1);
    });
  }
});

test('autonomous drain retries an operation failure when a newer kick arrived during the attempt', async () => {
  const firstOperation = deferred();
  let operationStarts = 0;
  let claims = 0;
  const agent = createAgent({
    sessionManager: {
      async beginCollectorOperation() {
        operationStarts += 1;
        if (operationStarts === 1) {
          await firstOperation.promise;
          throw new Error('session unavailable');
        }
        return operation();
      },
      async collectorFetch(path) {
        assert.equal(path, '/collector/ozon/enrichment-jobs/next');
        claims += 1;
        return jsonResponse(200, { ok: true, job: null });
      },
    },
    async canCapture() { return true; },
    async captureVariant() { throw new Error('empty drains must not capture'); },
    async sleep() {},
  });

  const firstKick = agent.drainAvailable({ deadlineAt: Date.now() + 2_000 });
  await nextTurn();
  const activeKick = agent.drainAvailable({ deadlineAt: Date.now() + 2_000 });
  assert.strictEqual(activeKick, firstKick);

  firstOperation.resolve();
  await Promise.all([firstKick, activeKick]);

  assert.equal(operationStarts, 2, 'the newer generation must authorize one successor attempt');
  assert.equal(claims, 1);
});

test('autonomous drain consumes a kick from the promise ownership cleanup window', async () => {
  let claims = 0;
  let activeClaims = 0;
  let maxActiveClaims = 0;
  const agent = createAgent({
    sessionManager: {
      async beginCollectorOperation() { return operation(); },
      async collectorFetch(path) {
        assert.equal(path, '/collector/ozon/enrichment-jobs/next');
        claims += 1;
        activeClaims += 1;
        maxActiveClaims = Math.max(maxActiveClaims, activeClaims);
        try {
          return jsonResponse(200, { ok: true, job: null });
        } finally {
          activeClaims -= 1;
        }
      },
    },
    async canCapture() { return true; },
    async captureVariant() { throw new Error('empty drains must not capture'); },
    async sleep() {},
  });

  const nativeFinally = Promise.prototype.finally;
  let finallyCalls = 0;
  let injected = false;
  let cleanupKick;
  Promise.prototype.finally = function interceptAvailableCleanup(onFinally) {
    finallyCalls += 1;
    if (finallyCalls !== 2) return nativeFinally.call(this, onFinally);
    return nativeFinally.call(this, () => {
      injected = true;
      cleanupKick = agent.drainAvailable({ deadlineAt: Date.now() + 2_000 });
      return onFinally();
    });
  };

  let firstKick;
  try {
    firstKick = agent.drainAvailable({ deadlineAt: Date.now() + 2_000 });
  } finally {
    Promise.prototype.finally = nativeFinally;
  }
  await firstKick;
  await cleanupKick;

  assert.equal(injected, true, 'test must inject the kick before availablePromise ownership clears');
  assert.equal(claims, 2, 'the cleanup-window kick must trigger a following empty-stop round');
  assert.equal(maxActiveClaims, 1, 'cleanup recovery must remain single-concurrency');
});

test('autonomous drain lets a cleanup-window kick retry a parked operation failure', async () => {
  let operationStarts = 0;
  let claims = 0;
  const agent = createAgent({
    sessionManager: {
      async beginCollectorOperation() {
        operationStarts += 1;
        return operationStarts === 1 ? operation([]) : operation();
      },
      async collectorFetch(path) {
        assert.equal(path, '/collector/ozon/enrichment-jobs/next');
        claims += 1;
        return jsonResponse(200, { ok: true, job: null });
      },
    },
    async canCapture() { return true; },
    async captureVariant() { throw new Error('empty drains must not capture'); },
    async sleep() {},
  });

  const nativeFinally = Promise.prototype.finally;
  let finallyCalls = 0;
  let injected = false;
  let cleanupKick;
  Promise.prototype.finally = function interceptAvailableCleanup(onFinally) {
    finallyCalls += 1;
    if (finallyCalls !== 2) return nativeFinally.call(this, onFinally);
    return nativeFinally.call(this, () => {
      injected = true;
      cleanupKick = agent.drainAvailable({ deadlineAt: Date.now() + 2_000 });
      return onFinally();
    });
  };

  let firstKick;
  try {
    firstKick = agent.drainAvailable({ deadlineAt: Date.now() + 2_000 });
  } finally {
    Promise.prototype.finally = nativeFinally;
  }
  await firstKick;
  await cleanupKick;

  assert.equal(injected, true);
  assert.equal(operationStarts, 2, 'the cleanup generation must authorize one retry');
  assert.equal(claims, 1);
});

test('autonomous drain starts a successor for a live kick beyond the active owner deadline', async () => {
  const firstClaim = deferred();
  const claims = [];
  let clock = 1_000;
  let activeClaims = 0;
  let maxActiveClaims = 0;
  const timerDelays = [];
  const agent = createAgent({
    now: () => clock,
    setTimer(_callback, delay) {
      timerDelays.push(delay);
      return timerDelays.length;
    },
    clearTimer() {},
    sessionManager: {
      async beginCollectorOperation() { return operation(); },
      async collectorFetch(path, options) {
        assert.equal(path, '/collector/ozon/enrichment-jobs/next');
        const claim = { at: clock, signal: options.signal };
        claims.push(claim);
        activeClaims += 1;
        maxActiveClaims = Math.max(maxActiveClaims, activeClaims);
        try {
          if (claims.length === 1) await firstClaim.promise;
          return jsonResponse(200, { ok: true, job: null });
        } finally {
          activeClaims -= 1;
        }
      },
    },
    async canCapture() { return true; },
    async captureVariant() { throw new Error('empty drains must not capture'); },
    async sleep() {},
  });

  const firstKick = agent.drainAvailable({ deadlineAt: 1_100 });
  await nextTurn();
  assert.equal(claims.length, 1);
  const expiredKick = agent.drainAvailable({ deadlineAt: 1_050 });
  const shorterLiveKick = agent.drainAvailable({ deadlineAt: 1_800 });
  const lateKick = agent.drainAvailable({ deadlineAt: 2_000 });

  clock = 1_100;
  firstClaim.resolve();
  await Promise.all([firstKick, expiredKick, shorterLiveKick, lateKick]);

  assert.equal(claims.length, 2, 'the live late kick must run under a successor owner');
  assert.equal(maxActiveClaims, 1, 'the successor must wait for the old owner to release');
  assert.deepEqual(claims.map(({ at }) => at), [1_000, 1_100]);
  assert.equal(
    timerDelays.includes(900),
    true,
    'the successor must merge live pending kicks using their latest deadline',
  );
  assert.notStrictEqual(claims[1].signal, claims[0].signal, 'the successor needs its own lifecycle');
  assert.equal(claims[0].signal.aborted, true, 'the old lifecycle must end at its own deadline');
});

test('autonomous drain hands a late kick to a successor when its supplemental round hits the old deadline', async () => {
  const firstClaim = deferred();
  const supplementalClaim = deferred();
  const claims = [];
  let clock = 1_000;
  let activeClaims = 0;
  let maxActiveClaims = 0;
  const timerDelays = [];
  const agent = createAgent({
    now: () => clock,
    setTimer(_callback, delay) {
      timerDelays.push(delay);
      return timerDelays.length;
    },
    clearTimer() {},
    sessionManager: {
      async beginCollectorOperation() { return operation(); },
      async collectorFetch(path, options) {
        assert.equal(path, '/collector/ozon/enrichment-jobs/next');
        claims.push({ at: clock, signal: options.signal });
        activeClaims += 1;
        maxActiveClaims = Math.max(maxActiveClaims, activeClaims);
        try {
          if (claims.length === 1) await firstClaim.promise;
          if (claims.length === 2) await supplementalClaim.promise;
          return jsonResponse(200, { ok: true, job: null });
        } finally {
          activeClaims -= 1;
        }
      },
    },
    async canCapture() { return true; },
    async captureVariant() { throw new Error('empty drains must not capture'); },
    async sleep() {},
  });

  const firstKick = agent.drainAvailable({ deadlineAt: 1_100 });
  await nextTurn();
  assert.equal(claims.length, 1);
  const lateKick = agent.drainAvailable({ deadlineAt: 2_000 });

  clock = 1_050;
  firstClaim.resolve();
  while (claims.length < 2) await nextTurn();
  assert.equal(claims[1].at, 1_050, 'the old owner may start its required supplemental round');

  clock = 1_100;
  supplementalClaim.resolve();
  await Promise.all([firstKick, lateKick]);

  assert.deepEqual(claims.map(({ at }) => at), [1_000, 1_050, 1_100]);
  assert.equal(maxActiveClaims, 1, 'the successor must wait for the old owner to release');
  assert.equal(timerDelays.includes(900), true, 'the successor must retain the late kick deadline');
  assert.equal(claims[1].signal.aborted, true, 'the supplemental old-owner claim must be cancelled');
  assert.notStrictEqual(claims[2].signal, claims[1].signal, 'the successor needs a fresh lifecycle');
});

test('autonomous drain preserves a live late-deadline kick injected at owner cleanup', async () => {
  const claims = [];
  let clock = 1_000;
  let activeClaims = 0;
  let maxActiveClaims = 0;
  const agent = createAgent({
    now: () => clock,
    sessionManager: {
      async beginCollectorOperation() { return operation(); },
      async collectorFetch(path, options) {
        assert.equal(path, '/collector/ozon/enrichment-jobs/next');
        claims.push({ at: clock, signal: options.signal });
        activeClaims += 1;
        maxActiveClaims = Math.max(maxActiveClaims, activeClaims);
        try {
          return jsonResponse(200, { ok: true, job: null });
        } finally {
          activeClaims -= 1;
        }
      },
    },
    async canCapture() { return true; },
    async captureVariant() { throw new Error('empty drains must not capture'); },
    async sleep() {},
  });

  const nativeFinally = Promise.prototype.finally;
  let finallyCalls = 0;
  let injected = false;
  let cleanupKick;
  Promise.prototype.finally = function interceptAvailableCleanup(onFinally) {
    finallyCalls += 1;
    if (finallyCalls !== 2) return nativeFinally.call(this, onFinally);
    return nativeFinally.call(this, () => {
      clock = 1_100;
      injected = true;
      cleanupKick = agent.drainAvailable({ deadlineAt: 2_000 });
      return onFinally();
    });
  };

  let firstKick;
  try {
    firstKick = agent.drainAvailable({ deadlineAt: 1_100 });
  } finally {
    Promise.prototype.finally = nativeFinally;
  }
  await firstKick;
  await cleanupKick;

  assert.equal(injected, true, 'test must inject the kick at the old owner deadline');
  assert.equal(claims.length, 2, 'cleanup must launch a successor using the late kick deadline');
  assert.equal(maxActiveClaims, 1, 'cleanup recovery must remain single-concurrency');
  assert.deepEqual(claims.map(({ at }) => at), [1_000, 1_100]);
  assert.notStrictEqual(claims[1].signal, claims[0].signal, 'cleanup must create a new owner');
  assert.equal(claims[0].signal.aborted, true, 'the old lifecycle must be released before successor work');
});

test('autonomous drain never claims without a ready Seller snapshot', async () => {
  for (const status of ['LOGIN_REQUIRED', 'RECOVERING']) {
    const requests = [];
    let nextCalls = 0;
    const agent = createAgent({
      sessionManager: {
        async beginCollectorOperation() { return operation(); },
        async collectorFetch(path, options) {
          requests.push({ path, options });
          if (path.endsWith('/next')) {
            nextCalls += 1;
            return jsonResponse(200, nextCalls === 1 ? {
              ok: true,
              job: {
                id: `job-${status.toLowerCase()}`,
                requestId: `request-${status.toLowerCase()}`,
                sku: '4862904234',
                refreshBundle: false,
              },
            } : { ok: true, job: null });
          }
          return jsonResponse(200, { ok: true });
        },
      },
      sellerContextRuntime: {
        async resolveCurrentWithRecovery() { return { status }; },
        async isSnapshotCurrent() { return false; },
      },
      async canCapture() { return false; },
      async captureVariant() { throw new Error('capture must not run'); },
      async sleep() {},
    });

    await agent.drainAvailable({ deadlineAt: Date.now() + 2_000 });

    const failure = requests.find(({ path }) => path.endsWith('/fail'));
    assert.equal(failure, undefined, status);
    assert.equal(requests.some(({ path }) => path.endsWith('/result')), false);
    assert.equal(nextCalls, 0, 'a job cannot be claimed without a server-bound Seller snapshot');
  }
});

test('agent accepts only the minimal job, captures fixed searchVariants input, and posts exact matched variantData', async () => {
  const requests = [];
  const captures = [];
  const wrongVariant = completeVariantData('1111111111');
  const matchedVariant = completeVariantData('4862904234');
  let nextCalls = 0;
  let agent;
  const sessionManager = {
    async beginCollectorOperation() { return operation(); },
    async collectorFetch(path, options) {
      requests.push({ path, options });
      if (path.endsWith('/next')) {
        nextCalls += 1;
        return jsonResponse(200, nextCalls === 1
          ? {
              ok: true,
              job: {
                id: 'job-one',
                requestId: 'request-one',
                sku: '4862904234',
                refreshBundle: true,
                claimFence: 'claim-fence-one',
              },
            }
          : { ok: true, job: null });
      }
      return jsonResponse(200, { ok: true });
    },
  };
  agent = createAgent({
    sessionManager,
    async canCapture() { return true; },
    async captureVariant(input) {
      captures.push(input);
      return { ok: true, data: { items: [wrongVariant, matchedVariant] } };
    },
    async sleep(milliseconds) {
      assert.equal(milliseconds, 250);
      agent.stop('request-one');
    },
  });

  await agent.drainUntil({ requestId: 'request-one', deadlineAt: Date.now() + 2_000 });

  assert.equal(captures.length, 1);
  assert.equal(captures[0].sku, '4862904234');
  assert.equal(captures[0].noProxy, true);
  assert.equal(captures[0].forceRefresh, true);
  assert.equal(captures[0].readOnly, true);
  assert.equal(Number.isFinite(captures[0].deadlineAt), true);
  assert.equal(captures[0].deadlineAt > Date.now(), true);
  assert.deepEqual(requests.map(({ path }) => path), [
    '/collector/ozon/enrichment-jobs/next',
    '/collector/ozon/enrichment-jobs/job-one/result',
    '/collector/ozon/enrichment-jobs/next',
  ]);
  const resultRequest = requests[1];
  const claimRequest = requests[0];
  assert.equal(claimRequest.options.method, 'POST');
  assert.deepEqual(JSON.parse(claimRequest.options.body), {
    captureContext: captureContext(),
  });
  assert.equal(resultRequest.options.permission, READ_PERMISSION);
  assert.deepEqual(Object.keys(JSON.parse(resultRequest.options.body)), [
    'variantData',
    'captureContext',
    'claimFence',
  ]);
  assert.deepEqual(JSON.parse(resultRequest.options.body), {
    variantData: projectedVariantData(matchedVariant),
    captureContext: captureContext(),
    claimFence: 'claim-fence-one',
  });
});

test('agent uploads an allowlisted product projection and ignores portal URL metadata', async () => {
  const requests = [];
  let nextCalls = 0;
  let agent;
  const variantData = completeVariantData('4862904234', {
    sourceUrl: 'https://www.ozon.ru/product/4862904234',
    _bundleItem: {
      primary_image_url: 'https://cdn.ozon.ru/product.jpg',
      action: 'create-draft',
      sellerCompanyId: 'portal-only-context',
    },
  });
  agent = createAgent({
    sessionManager: {
      async beginCollectorOperation() { return operation(); },
      async collectorFetch(path, options) {
        requests.push({ path, options });
        if (path.endsWith('/next')) {
          nextCalls += 1;
          return jsonResponse(200, nextCalls === 1
            ? {
                ok: true,
                job: {
                  id: 'job-realistic-portal-data',
                  requestId: 'request-realistic-portal-data',
                  sku: '4862904234',
                  refreshBundle: true,
                  claimFence: 'claim-realistic-portal-data',
                },
              }
            : { ok: true, job: null });
        }
        return jsonResponse(200, { ok: true });
      },
    },
    async canCapture() { return true; },
    async captureVariant() { return { ok: true, data: { items: [variantData] } }; },
    async sleep() { agent.stop('request-realistic-portal-data'); },
  });

  await agent.drainUntil({
    requestId: 'request-realistic-portal-data',
    deadlineAt: Date.now() + 2_000,
  });

  const result = requests.find(({ path }) => path.endsWith('/result'));
  assert.ok(result);
  assert.deepEqual(JSON.parse(result.options.body), {
    variantData: projectedVariantData(variantData),
    captureContext: captureContext(),
    claimFence: 'claim-realistic-portal-data',
  });
  assert.doesNotMatch(JSON.stringify(result), /sourceUrl|primary_image_url|create-draft|portal-only-context/);
});

test('agent projects the real Seller search shape without guessing a top-level type_id', async () => {
  const requests = [];
  let nextCalls = 0;
  const variantData = completeVariantData('4862904234');
  delete variantData.type_id;
  variantData.attributes.unshift({
    key: '8229',
    value: 'Заварочный чайник',
    dictionary_value_id: 123456,
  });
  const agent = createAgent({
    sessionManager: {
      async beginCollectorOperation() { return operation(); },
      async collectorFetch(path, options) {
        requests.push({ path, options });
        if (path.endsWith('/next')) {
          nextCalls += 1;
          return jsonResponse(200, nextCalls === 1 ? {
            ok: true,
            job: {
              id: 'job-real-search-shape',
              requestId: 'request-real-search-shape',
              sku: '4862904234',
              refreshBundle: false,
              claimFence: 'claim-real-search-shape',
            },
          } : { ok: true, job: null });
        }
        return jsonResponse(200, { ok: true });
      },
    },
    async canCapture() { return true; },
    async captureVariant() { return { ok: true, data: { items: [variantData] } }; },
    async sleep() {},
  });

  await agent.drainAvailable({ deadlineAt: Date.now() + 2_000 });

  const result = requests.find(({ path }) => path.endsWith('/result'));
  assert.ok(result);
  const body = JSON.parse(result.options.body);
  assert.equal(Object.hasOwn(body.variantData, 'type_id'), false);
  assert.deepEqual(body.variantData.attributes[0], {
    key: '8229',
    value: 'Заварочный чайник',
    dictionary_value_id: 123456,
  });
  assert.deepEqual(body.captureContext, captureContext());
  assert.equal(body.claimFence, 'claim-real-search-shape');
});

test('agent settles at its deadline and never posts a late capture result', async () => {
  const requests = [];
  const never = new Promise(() => {});
  const agent = createAgent({
    sessionManager: {
      async beginCollectorOperation() { return operation(); },
      async collectorFetch(path, options) {
        requests.push({ path, options });
        return jsonResponse(200, {
          ok: true,
          job: {
            id: 'job-deadline',
            requestId: 'request-deadline',
            sku: '4862904234',
            refreshBundle: true,
            claimFence: 'claim-deadline',
          },
        });
      },
    },
    async canCapture() { return true; },
    async captureVariant() { return never; },
    async sleep() {},
  });

  const drain = agent.drainUntil({
    requestId: 'request-deadline',
    deadlineAt: Date.now() + 30,
  });
  const outcome = await Promise.race([
    drain.then(() => 'settled'),
    new Promise((resolve) => setTimeout(() => resolve('timed-out'), 150)),
  ]);
  assert.equal(outcome, 'settled');
  assert.deepEqual(requests.map(({ path }) => path), [
    '/collector/ozon/enrichment-jobs/next',
  ]);
});

test('stopping a drain while canCapture is pending prevents every later side effect', async () => {
  const gate = deferred();
  const requests = [];
  let captures = 0;
  const agent = createAgent({
    sessionManager: {
      async beginCollectorOperation() { return operation(); },
      async collectorFetch(path) {
        requests.push(path);
        return jsonResponse(200, { ok: true, job: null });
      },
    },
    canCapture() { return gate.promise; },
    async captureVariant() { captures += 1; },
    async sleep() {},
  });

  const drain = agent.drainUntil({
    requestId: 'request-stop-can-capture',
    deadlineAt: Date.now() + 2_000,
  });
  await nextTurn();
  agent.stop('request-stop-can-capture');
  gate.resolve(true);

  assert.equal(await settleWithin(drain), 'settled');
  assert.deepEqual(requests, []);
  assert.equal(captures, 0);
});

test('last stop aborts a pending claim and a late claimed job cannot capture or report', async () => {
  const claim = deferred();
  const requests = [];
  let claimAborted = false;
  let captures = 0;
  const agent = createAgent({
    sessionManager: {
      async beginCollectorOperation() { return operation(); },
      collectorFetch(path, options) {
        requests.push(path);
        if (path.endsWith('/next')) {
          options.signal?.addEventListener('abort', () => { claimAborted = true; });
          return claim.promise;
        }
        return jsonResponse(200, { ok: true });
      },
    },
    async canCapture() { return true; },
    async captureVariant() { captures += 1; },
    async sleep() {},
  });

  const drain = agent.drainUntil({
    requestId: 'request-stop-claim',
    deadlineAt: Date.now() + 2_000,
  });
  await nextTurn();
  agent.stop('request-stop-claim');
  assert.equal(claimAborted, true);
  claim.resolve(jsonResponse(200, {
    ok: true,
    job: {
      id: 'job-late-claim',
      requestId: 'request-stop-claim',
      sku: '4862904234',
      refreshBundle: false,
      claimFence: 'claim-late-claim',
    },
  }));

  assert.equal(await settleWithin(drain), 'settled');
  assert.equal(captures, 0);
  assert.deepEqual(requests, ['/collector/ozon/enrichment-jobs/next']);
});

test('stopping a drain while capture is pending prevents late result and failure posts', async () => {
  const capture = deferred();
  const requests = [];
  const agent = createAgent({
    sessionManager: {
      async beginCollectorOperation() { return operation(); },
      async collectorFetch(path) {
        requests.push(path);
        return jsonResponse(200, {
          ok: true,
          job: {
            id: 'job-late-capture',
            requestId: 'request-stop-capture',
            sku: '4862904234',
            refreshBundle: false,
            claimFence: 'claim-late-capture',
          },
        });
      },
    },
    async canCapture() { return true; },
    captureVariant() { return capture.promise; },
    async sleep() {},
  });

  const drain = agent.drainUntil({
    requestId: 'request-stop-capture',
    deadlineAt: Date.now() + 2_000,
  });
  while (!requests.length) await nextTurn();
  await nextTurn();
  agent.stop('request-stop-capture');
  capture.resolve({
    ok: true,
    data: { items: [completeVariantData('4862904234')] },
  });

  assert.equal(await settleWithin(drain), 'settled');
  assert.deepEqual(requests, ['/collector/ozon/enrichment-jobs/next']);
});

test('last stop immediately aborts a pending result Collector request without a fail post', async () => {
  const resultResponse = deferred();
  const requests = [];
  let resultStarted = false;
  let resultAborted = false;
  const agent = createAgent({
    sessionManager: {
      async beginCollectorOperation() { return operation(); },
      collectorFetch(path, options) {
        requests.push(path);
        if (path.endsWith('/next')) {
          return jsonResponse(200, {
            ok: true,
            job: {
              id: 'job-stop-result',
              requestId: 'request-stop-result',
              sku: '4862904234',
              refreshBundle: false,
              claimFence: 'claim-stop-result',
            },
          });
        }
        if (path.endsWith('/result')) {
          resultStarted = true;
          options.signal?.addEventListener('abort', () => { resultAborted = true; });
          return resultResponse.promise;
        }
        throw new Error(`unexpected path: ${path}`);
      },
    },
    async canCapture() { return true; },
    async captureVariant() {
      return { ok: true, data: { items: [completeVariantData('4862904234')] } };
    },
    async sleep() {},
  });

  const drain = agent.drainUntil({
    requestId: 'request-stop-result',
    deadlineAt: Date.now() + 2_000,
  });
  while (!resultStarted) await nextTurn();
  agent.stop('request-stop-result');

  assert.equal(resultAborted, true);
  assert.equal(await settleWithin(drain), 'settled');
  assert.deepEqual(requests, [
    '/collector/ozon/enrichment-jobs/next',
    '/collector/ozon/enrichment-jobs/job-stop-result/result',
  ]);
  resultResponse.resolve(jsonResponse(200, { ok: true }));
});

test('last stop immediately aborts a pending fixed failure Collector request', async () => {
  const failResponse = deferred();
  const requests = [];
  let failStarted = false;
  let failAborted = false;
  const agent = createAgent({
    sessionManager: {
      async beginCollectorOperation() { return operation(); },
      collectorFetch(path, options) {
        requests.push(path);
        if (path.endsWith('/next')) {
          return jsonResponse(200, {
            ok: true,
            job: {
              id: 'job-stop-fail',
              requestId: 'request-stop-fail',
              sku: '4862904234',
              refreshBundle: false,
              claimFence: 'claim-stop-fail',
            },
          });
        }
        if (path.endsWith('/fail')) {
          failStarted = true;
          options.signal?.addEventListener('abort', () => { failAborted = true; });
          return failResponse.promise;
        }
        throw new Error(`unexpected path: ${path}`);
      },
    },
    async canCapture() { return true; },
    async captureVariant() { throw new Error('capture failed'); },
    async sleep() {},
  });

  const drain = agent.drainUntil({
    requestId: 'request-stop-fail',
    deadlineAt: Date.now() + 2_000,
  });
  while (!failStarted) await nextTurn();
  agent.stop('request-stop-fail');

  assert.equal(failAborted, true);
  assert.equal(await settleWithin(drain), 'settled');
  assert.deepEqual(requests, [
    '/collector/ozon/enrichment-jobs/next',
    '/collector/ozon/enrichment-jobs/job-stop-fail/fail',
  ]);
  failResponse.resolve(jsonResponse(200, { ok: true }));
});

test('same request ID keeps one drain lease active when the first client completes', async () => {
  const publicResponses = [deferred(), deferred()];
  const claim = deferred();
  let publicCalls = 0;
  let claimStarted = false;
  let claimAborted = false;
  const sessionManager = {
    async beginCollectorOperation() { return operation(); },
    collectorFetch(path, options) {
      if (path === '/collector/ozon/enrich') {
        const response = publicResponses[publicCalls];
        publicCalls += 1;
        return response.promise;
      }
      if (path.endsWith('/next')) {
        claimStarted = true;
        options.signal?.addEventListener('abort', () => { claimAborted = true; });
        return claim.promise;
      }
      return jsonResponse(200, { ok: true });
    },
  };
  const agent = createAgent({
    sessionManager,
    async canCapture() { return true; },
    async captureVariant() { throw new Error('capture must not run'); },
    async sleep() {},
  });
  const client = createClient({ sessionManager, agent, getBackendUrl: async () => '' });

  const first = client.enrich({ requestId: 'request-shared', sku: '4862904234' });
  const second = client.enrich({ requestId: 'request-shared', sku: '4862904234' });
  while (!claimStarted || publicCalls < 2) await nextTurn();

  publicResponses[0].resolve(jsonResponse(200, {
    ok: true,
    data: completeResult('4862904234'),
  }));
  const firstOutcome = await settleWithin(first);
  const abortedAfterFirst = claimAborted;

  publicResponses[1].resolve(jsonResponse(200, {
    ok: true,
    data: completeResult('4862904234'),
  }));
  const secondOutcome = await settleWithin(second);
  const abortedAfterSecond = claimAborted;
  claim.resolve(jsonResponse(200, { ok: true, job: null }));

  assert.equal(firstOutcome, 'settled');
  assert.equal(abortedAfterFirst, false);
  assert.equal(secondOutcome, 'settled');
  assert.equal(abortedAfterSecond, true);
});

test('same-generation lease tokens are unique and idempotent so only the last valid token aborts', async () => {
  const claim = deferred();
  let claimStarted = false;
  let claimAborted = false;
  const agent = createAgent({
    sessionManager: {
      async beginCollectorOperation() { return operation(); },
      collectorFetch(path, options) {
        if (!path.endsWith('/next')) return jsonResponse(200, { ok: true });
        claimStarted = true;
        options.signal?.addEventListener('abort', () => { claimAborted = true; });
        return claim.promise;
      },
    },
    async canCapture() { return true; },
    async captureVariant() { throw new Error('capture must not run'); },
    async sleep() {},
  });

  const first = agent.drainUntil({
    requestId: 'request-token-idempotent',
    deadlineAt: Date.now() + 2_000,
  });
  const second = agent.drainUntil({
    requestId: 'request-token-idempotent',
    deadlineAt: Date.now() + 2_000,
  });
  while (!claimStarted) await nextTurn();

  assert.notEqual(first, second);
  assert.ok(first.releaseToken);
  assert.ok(second.releaseToken);
  assert.notEqual(first.releaseToken, second.releaseToken);
  assert.equal(Object.keys(first).includes('releaseToken'), false);
  assert.equal(agent.stop('request-token-idempotent', first.releaseToken), true);
  assert.equal(agent.stop('request-token-idempotent', first.releaseToken), false);
  assert.equal(claimAborted, false);
  assert.equal(agent.stop('request-token-idempotent', second.releaseToken), true);
  assert.equal(claimAborted, true);

  claim.resolve(jsonResponse(200, { ok: true, job: null }));
  assert.equal(await settleWithin(Promise.all([first, second])), 'settled');
});

test('legacy force-stop cannot release a token-aware production lease', async () => {
  const claim = deferred();
  let claimStarted = false;
  let claimAborted = false;
  const agent = createAgent({
    sessionManager: {
      async beginCollectorOperation() { return operation(); },
      collectorFetch(path, options) {
        if (!path.endsWith('/next')) return jsonResponse(200, { ok: true });
        claimStarted = true;
        options.signal?.addEventListener('abort', () => { claimAborted = true; });
        return claim.promise;
      },
    },
    async canCapture() { return true; },
    async captureVariant() { throw new Error('capture must not run'); },
    async sleep() {},
  });

  const handle = agent.drainUntil({
    requestId: 'request-token-aware',
    deadlineAt: Date.now() + 2_000,
  });
  const releaseToken = handle.releaseToken;
  while (!claimStarted) await nextTurn();

  assert.equal(agent.stop('request-token-aware'), false);
  assert.equal(claimAborted, false);
  assert.equal(agent.stop('request-token-aware', releaseToken), true);
  assert.equal(claimAborted, true);
  claim.resolve(jsonResponse(200, { ok: true, job: null }));
  assert.equal(await settleWithin(handle), 'settled');
});

test('stale early-exit generation tokens cannot stop a newer pending claim', async (t) => {
  const cases = [
    {
      name: 'require operation rejection',
      firstDeadline: () => Date.now() + 2_000,
      firstOperation: async () => { throw new Error('session unavailable'); },
    },
    {
      name: 'permission rejection',
      firstDeadline: () => Date.now() + 2_000,
      firstOperation: async () => operation([]),
    },
    {
      name: 'deadline rejection',
      firstDeadline: () => Date.now() - 1,
      firstOperation: async () => operation(),
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const claim = deferred();
      let operations = 0;
      let claimStarted = false;
      let claimAborted = false;
      const agent = createAgent({
        sessionManager: {
          async beginCollectorOperation() {
            operations += 1;
            if (operations === 1) return scenario.firstOperation();
            return operation();
          },
          collectorFetch(path, options) {
            if (!path.endsWith('/next')) return jsonResponse(200, { ok: true });
            claimStarted = true;
            options.signal?.addEventListener('abort', () => { claimAborted = true; });
            return claim.promise;
          },
        },
        async canCapture() { return true; },
        async captureVariant() { throw new Error('capture must not run'); },
        async sleep() {},
      });

      const first = agent.drainUntil({
        requestId: `request-stale-${scenario.name}`,
        deadlineAt: scenario.firstDeadline(),
      });
      assert.equal(await settleWithin(first), 'settled');
      const second = agent.drainUntil({
        requestId: `request-stale-${scenario.name}`,
        deadlineAt: Date.now() + 2_000,
      });
      while (!claimStarted) await nextTurn();

      assert.equal(agent.stop(`request-stale-${scenario.name}`, first.releaseToken), true);
      assert.equal(claimAborted, false);
      assert.equal(agent.stop(`request-stale-${scenario.name}`, second.releaseToken), true);
      assert.equal(claimAborted, true);
      claim.resolve(jsonResponse(200, { ok: true, job: null }));
      assert.equal(await settleWithin(second), 'settled');
    });
  }
});

test('a released old-generation token remains a no-op while a newer generation is active', async () => {
  const claim = deferred();
  let operations = 0;
  let claimStarted = false;
  let claimAborted = false;
  const agent = createAgent({
    sessionManager: {
      async beginCollectorOperation() {
        operations += 1;
        return operations === 1 ? operation([]) : operation();
      },
      collectorFetch(path, options) {
        if (!path.endsWith('/next')) return jsonResponse(200, { ok: true });
        claimStarted = true;
        options.signal?.addEventListener('abort', () => { claimAborted = true; });
        return claim.promise;
      },
    },
    async canCapture() { return true; },
    async captureVariant() { throw new Error('capture must not run'); },
    async sleep() {},
  });

  const first = agent.drainUntil({
    requestId: 'request-stale-repeat',
    deadlineAt: Date.now() + 2_000,
  });
  assert.equal(await settleWithin(first), 'settled');
  assert.equal(agent.stop('request-stale-repeat', first.releaseToken), true);

  const second = agent.drainUntil({
    requestId: 'request-stale-repeat',
    deadlineAt: Date.now() + 2_000,
  });
  while (!claimStarted) await nextTurn();
  assert.equal(agent.stop('request-stale-repeat', first.releaseToken), false);
  assert.equal(claimAborted, false);
  assert.equal(agent.stop('request-stale-repeat', second.releaseToken), true);
  assert.equal(claimAborted, true);

  claim.resolve(jsonResponse(200, { ok: true, job: null }));
  assert.equal(await settleWithin(second), 'settled');
});

test('agent rejects arbitrary job data without capture and reports only a fixed safe failure', async () => {
  const requests = [];
  let captures = 0;
  let nextCalls = 0;
  let agent;
  agent = createAgent({
    sessionManager: {
      async beginCollectorOperation() { return operation(); },
      async collectorFetch(path, options) {
        requests.push({ path, options });
        if (path.endsWith('/next')) {
          nextCalls += 1;
          return jsonResponse(200, nextCalls === 1
            ? {
                ok: true,
                job: {
                  id: 'job-arbitrary',
                  requestId: 'request-arbitrary',
                  sku: '4862904234',
                  refreshBundle: false,
                  claimFence: 'claim-arbitrary',
                  script: 'steal()',
                },
              }
            : { ok: true, job: null });
        }
        return jsonResponse(200, { ok: true });
      },
    },
    async canCapture() { return true; },
    async captureVariant() { captures += 1; },
    async sleep() { agent.stop('request-arbitrary'); },
  });

  await agent.drainUntil({
    requestId: 'request-arbitrary',
    deadlineAt: Date.now() + 2_000,
  });

  assert.equal(captures, 0);
  const failure = requests.find(({ path }) => path.endsWith('/fail'));
  assert.equal(failure.path, '/collector/ozon/enrichment-jobs/job-arbitrary/fail');
  assert.deepEqual(JSON.parse(failure.options.body), {
    code: 'OZON_ENRICH_UPSTREAM_FAILED',
    message: 'Ozon 商品资料暂时无法读取',
    captureContext: captureContext(),
    claimFence: 'claim-arbitrary',
  });
});

test('capture failures never forward raw secrets and cannot select sync or arbitrary routes', async () => {
  const requests = [];
  let nextCalls = 0;
  let agent;
  agent = createAgent({
    sessionManager: {
      async beginCollectorOperation() { return operation(); },
      async collectorFetch(path, options) {
        requests.push({ path, options });
        if (path.endsWith('/next')) {
          nextCalls += 1;
          return jsonResponse(200, nextCalls === 1
            ? {
                ok: true,
                job: {
                  id: 'job-secret',
                  requestId: 'request-secret',
                  sku: '4862904234',
                  refreshBundle: false,
                  claimFence: 'claim-secret',
                },
              }
            : { ok: true, job: null });
        }
        return jsonResponse(200, { ok: true });
      },
    },
    async canCapture() { return true; },
    async captureVariant() {
      return {
        ok: false,
        error: 'AUTH_REQUIRED',
        message: 'Bearer cst_do-not-leak-secret-value',
      };
    },
    async sleep() { agent.stop('request-secret'); },
  });

  await agent.drainUntil({ requestId: 'request-secret', deadlineAt: Date.now() + 2_000 });

  const serialized = JSON.stringify(requests);
  assert.doesNotMatch(serialized, /do-not-leak|Bearer/);
  assert.equal(
    requests.some(({ path }) => /\/ozon\/sync|https?:|\.\.|script|cookie/i.test(path)),
    false,
  );
  const failure = requests.find(({ path }) => path.endsWith('/fail'));
  assert.deepEqual(JSON.parse(failure.options.body), {
    code: 'SELLER_CONTEXT_REQUIRED',
    message: '需要登录 Seller',
    captureContext: captureContext(),
    claimFence: 'claim-secret',
  });
});

test('captured variantData discards portal-only non-sensitive metadata before result upload', async () => {
  const forbiddenVariants = [
    completeVariantData('4862904234', { nested: [{ store_id: 'attacker-controlled' }] }),
    completeVariantData('4862904234', { nested: [{ sellerCompanyId: 'attacker-controlled' }] }),
    completeVariantData('4862904234', { nested: [{ account_id: 'attacker-controlled' }] }),
    completeVariantData('4862904234', { nested: [{ action: 'attacker-controlled' }] }),
    completeVariantData('4862904234', { nested: [{ script: 'attacker-controlled' }] }),
  ];

  for (const [index, variantData] of forbiddenVariants.entries()) {
    const requests = [];
    let nextCalls = 0;
    let agent;
    agent = createAgent({
      sessionManager: {
        async beginCollectorOperation() { return operation(); },
        async collectorFetch(path, options) {
          requests.push({ path, options });
          if (path.endsWith('/next')) {
            nextCalls += 1;
            return jsonResponse(200, nextCalls === 1
              ? {
                  ok: true,
                  job: {
                    id: `job-sensitive-${index}`,
                    requestId: `request-sensitive-${index}`,
                    sku: '4862904234',
                    refreshBundle: false,
                    claimFence: `claim-sensitive-${index}`,
                  },
                }
              : { ok: true, job: null });
          }
          return jsonResponse(200, { ok: true });
        },
      },
      async canCapture() { return true; },
      async captureVariant() { return { ok: true, data: { items: [variantData] } }; },
      async sleep() { agent.stop(`request-sensitive-${index}`); },
    });

    await agent.drainUntil({
      requestId: `request-sensitive-${index}`,
      deadlineAt: Date.now() + 2_000,
    });

    const result = requests.find(({ path }) => path.endsWith('/result'));
    assert.ok(result, `case ${index}`);
    assert.deepEqual(JSON.parse(result.options.body), {
      variantData: projectedVariantData(variantData),
      captureContext: captureContext(),
      claimFence: `claim-sensitive-${index}`,
    });
    assert.equal(requests.some(({ path }) => path.endsWith('/fail')), false, `case ${index}`);
    assert.doesNotMatch(JSON.stringify(requests), /attacker-controlled|attacker\.invalid|secret-secret|abcdefghijklmnopqrstuvwxyz/);
  }
});

test('captured raw variantData rejects exact credential aliases before projection', async () => {
  const sensitiveVariants = [
    completeVariantData('4862904234', { nested: [{ auth: 'attacker-controlled' }] }),
    completeVariantData('4862904234', { nested: [{ jwt: 'attacker-controlled' }] }),
    completeVariantData('4862904234', { nested: [{ session: 'attacker-controlled' }] }),
    completeVariantData('4862904234', { nested: [{ cookieJar: 'attacker-controlled' }] }),
    completeVariantData('4862904234', { nested: [{ Authorization: 'attacker-controlled' }] }),
    completeVariantData('4862904234', { nested: [{ requestHeaders: 'attacker-controlled' }] }),
    completeVariantData('4862904234', { note: 'Collector cst_secret-secret-secret-secret' }),
    completeVariantData('4862904234', { note: 'Bearer abcdefghijklmnopqrstuvwxyz123456' }),
  ];

  for (const [index, variantData] of sensitiveVariants.entries()) {
    const requests = [];
    let nextCalls = 0;
    let agent;
    agent = createAgent({
      sessionManager: {
        async beginCollectorOperation() { return operation(); },
        async collectorFetch(path, options) {
          requests.push({ path, options });
          if (path.endsWith('/next')) {
            nextCalls += 1;
            return jsonResponse(200, nextCalls === 1
              ? {
                  ok: true,
                  job: {
                    id: `job-raw-sensitive-${index}`,
                    requestId: `request-raw-sensitive-${index}`,
                    sku: '4862904234',
                    refreshBundle: false,
                    claimFence: `claim-raw-sensitive-${index}`,
                  },
                }
              : { ok: true, job: null });
          }
          return jsonResponse(200, { ok: true });
        },
      },
      async canCapture() { return true; },
      async captureVariant() { return { ok: true, data: { items: [variantData] } }; },
      async sleep() { agent.stop(`request-raw-sensitive-${index}`); },
    });

    await agent.drainUntil({
      requestId: `request-raw-sensitive-${index}`,
      deadlineAt: Date.now() + 2_000,
    });

    assert.equal(requests.some(({ path }) => path.endsWith('/result')), false, `case ${index}`);
    const failed = requests.find(({ path }) => path.endsWith('/fail'));
    assert.ok(failed, `case ${index}`);
    assert.equal(JSON.parse(failed.options.body).code, 'OZON_ENRICH_UPSTREAM_FAILED');
    assert.doesNotMatch(JSON.stringify(requests), /attacker-controlled|secret-secret|abcdefghijklmnopqrstuvwxyz/);
  }
});

test('captured variantData rejects a credential-shaped value inside an uploaded product attribute', async () => {
  const requests = [];
  let nextCalls = 0;
  let agent;
  agent = createAgent({
    sessionManager: {
      async beginCollectorOperation() { return operation(); },
      async collectorFetch(path, options) {
        requests.push({ path, options });
        if (path.endsWith('/next')) {
          nextCalls += 1;
          return jsonResponse(200, nextCalls === 1
            ? {
                ok: true,
                job: {
                  id: 'job-secret-attribute',
                  requestId: 'request-secret-attribute',
                  sku: '4862904234',
                  refreshBundle: false,
                  claimFence: 'claim-secret-attribute',
                },
              }
            : { ok: true, job: null });
        }
        return jsonResponse(200, { ok: true });
      },
    },
    async canCapture() { return true; },
    async captureVariant() {
      return {
        ok: true,
        data: {
          items: [completeVariantData('4862904234', {
            attributes: [
              { key: '4497', value: 'Bearer abcdefghijklmnopqrstuvwxyz123456' },
              { key: '9454', value: '300' },
              { key: '9455', value: '200' },
              { key: '9456', value: '100' },
            ],
          })],
        },
      };
    },
    async sleep() { agent.stop('request-secret-attribute'); },
  });

  await agent.drainUntil({
    requestId: 'request-secret-attribute',
    deadlineAt: Date.now() + 2_000,
  });

  assert.equal(requests.some(({ path }) => path.endsWith('/result')), false);
  const failure = requests.find(({ path }) => path.endsWith('/fail'));
  assert.ok(failure);
  assert.deepEqual(JSON.parse(failure.options.body), {
    code: 'OZON_ENRICH_UPSTREAM_FAILED',
    message: 'Ozon 商品资料暂时无法读取',
    captureContext: captureContext(),
    claimFence: 'claim-secret-attribute',
  });
  assert.doesNotMatch(JSON.stringify(requests), /abcdefghijklmnopqrstuvwxyz/);
});

test('batch client preserves first-seen order, caps twenty unique SKUs, and uses one fixed request body', async () => {
  const requests = [];
  const agent = {
    async drainUntil() {},
    stop() {},
  };
  const sessionManager = {
    async beginCollectorOperation() { return operation(); },
    async collectorFetch(path, options) {
      requests.push({ path, options });
      const skus = JSON.parse(options.body).skus;
      return jsonResponse(200, {
        ok: true,
        data: skus.map((sku) => ({ sku, status: 'COMPLETE', result: completeResult(sku) })),
      });
    },
  };
  const client = createClient({ sessionManager, agent, getBackendUrl: async () => '' });

  const ordered = await client.enrichBatch({
    requestId: 'batch-one',
    skus: ['sku-b', 'sku-a', 'sku-b', 'sku-c'],
  });
  assert.deepEqual(ordered.map(({ sku }) => sku), ['sku-b', 'sku-a', 'sku-c']);
  assert.equal(requests[0].path, '/collector/ozon/enrich/batch');
  assert.equal(requests[0].options.permission, READ_PERMISSION);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    requestId: 'batch-one',
    skus: ['sku-b', 'sku-a', 'sku-c'],
  });

  const twenty = Array.from({ length: 20 }, (_, index) => `sku-${index + 1}`);
  await client.enrichBatch({ requestId: 'batch-twenty', skus: twenty });
  await assert.rejects(
    client.enrichBatch({ requestId: 'batch-too-many', skus: [...twenty, 'sku-21'] }),
    (error) => error?.status === 400 && error?.code === 'OZON_ENRICH_BATCH_LIMIT',
  );
  assert.equal(requests.length, 2);
});

test('client rejects complete responses whose nested result SKU differs from the request', async () => {
  let responseBody = { ok: true, data: completeResult('wrong-single') };
  const client = createClient({
    sessionManager: {
      async beginCollectorOperation() { return operation(); },
      async collectorFetch() { return jsonResponse(200, responseBody); },
    },
    agent: { async drainUntil() {}, stop() {} },
    getBackendUrl: async () => '',
  });

  await assert.rejects(
    client.enrich({ requestId: 'wrong-single-request', sku: 'expected-single' }),
    (error) => error?.status === 502 && error?.code === 'OZON_ENRICH_UPSTREAM_FAILED',
  );

  responseBody = {
    ok: true,
    data: [{
      sku: 'expected-batch',
      status: 'COMPLETE',
      result: completeResult('wrong-batch'),
    }],
  };
  await assert.rejects(
    client.enrichBatch({ requestId: 'wrong-batch-request', skus: ['expected-batch'] }),
    (error) => error?.status === 502 && error?.code === 'OZON_ENRICH_UPSTREAM_FAILED',
  );
});

test('batch client rejects a numeric wrapper SKU even when it coerces to the request SKU', async () => {
  const client = createClient({
    sessionManager: {
      async beginCollectorOperation() { return operation(); },
      async collectorFetch() {
        return jsonResponse(200, {
          ok: true,
          data: [{
            sku: 4862904234,
            status: 'COMPLETE',
            result: completeResult('4862904234'),
          }],
        });
      },
    },
    agent: { async drainUntil() {}, stop() {} },
    getBackendUrl: async () => '',
  });

  await assert.rejects(
    client.enrichBatch({ requestId: 'batch-numeric-wrapper', skus: ['4862904234'] }),
    (error) => error?.status === 502 && error?.code === 'OZON_ENRICH_UPSTREAM_FAILED',
  );
});
