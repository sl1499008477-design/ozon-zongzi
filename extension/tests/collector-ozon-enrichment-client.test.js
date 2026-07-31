const assert = require('node:assert/strict');
const test = require('node:test');

require('../lib/ozon-enrichment-contract.js');
const { create: createAgent } = require('../background/collector-ozon-enrichment-agent.js');
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

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('single client request requires read permission and drains concurrently on fixed routes', async () => {
  const publicResponse = deferred();
  const calls = [];
  const drain = deferred();
  const agent = {
    drainUntil(input) {
      calls.push(['drain', input]);
      return drain.promise;
    },
    stop(requestId) {
      calls.push(['stop', requestId]);
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
  assert.deepEqual(calls.find(([kind]) => kind === 'stop'), ['stop', 'request-one']);
});

test('client aborts a held public request at twenty seconds with a stable retryable error', async () => {
  const never = new Promise(() => {});
  const timers = [];
  let aborted = false;
  const client = createClient({
    sessionManager: {
      async beginCollectorOperation() { return operation(); },
      async collectorFetch(_path, options) {
        options.signal?.addEventListener('abort', () => { aborted = true; });
        return never;
      },
    },
    agent: { async drainUntil() {}, stop() {} },
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

  assert.deepEqual(captures, [{
    sku: '4862904234',
    noProxy: true,
    forceRefresh: true,
  }]);
  assert.deepEqual(requests.map(({ path }) => path), [
    '/collector/ozon/enrichment-jobs/next',
    '/collector/ozon/enrichment-jobs/job-one/result',
    '/collector/ozon/enrichment-jobs/next',
  ]);
  const resultRequest = requests[1];
  assert.equal(resultRequest.options.permission, READ_PERMISSION);
  assert.deepEqual(Object.keys(JSON.parse(resultRequest.options.body)), ['variantData']);
  assert.deepEqual(JSON.parse(resultRequest.options.body), { variantData: matchedVariant });
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
    code: 'OZON_ENRICH_UPSTREAM_FAILED',
    message: 'Ozon 商品资料暂时无法读取',
  });
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
