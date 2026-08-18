const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CONFIRM_HANDLER_TIMEOUT_MS,
  MODE,
  SESSION_STORAGE_KEY,
  createCategoryStrategySamplingBackgroundClient,
  createCategoryStrategySamplingController,
  extractOzonCapturedFacts,
  projectCapturedPageFactFromSession,
  projectCapturedProductFact,
} = require('../lib/category-strategy-sampling.js');

const HASH = 'a'.repeat(64);
const NOW = Date.parse('2026-08-15T00:00:00.000Z');
const SCOPE = Object.freeze({
  taxonomyScope: 'OZON:DEFAULT',
  descriptionCategoryId: 17028922,
  typeId: 91542,
});
const PRIVATE_SESSION_KEY = `${SESSION_STORAGE_KEY}.account-a.session-a`;
const PRIVATE_INDEX_KEY = `${SESSION_STORAGE_KEY}.index`;

test('category confirmation exposes the content-side 600 second handler deadline', () => {
  assert.equal(CONFIRM_HANDLER_TIMEOUT_MS, 600_000);
});

function session(overrides = {}) {
  return {
    sessionId: 'session-a',
    draftId: 'draft-a',
    extensionMode: MODE,
    scope: SCOPE,
    expiresAt: '2026-08-15T02:00:00.000Z',
    ...overrides,
  };
}

function pageFact(overrides = {}) {
  return { pageScope: SCOPE, sourceResponseHash: HASH, ...overrides };
}

function productFact(index = 1, overrides = {}) {
  const sku = String(4_862_904_233 + index);
  return {
    sku,
    sourceProductId: Number(sku),
    sourceProductRef: `product-${sku}`,
    sourceProductResponseHash: HASH,
    pageScope: SCOPE,
    productScope: SCOPE,
    sourceReferences: [
      {
        imageId: `image-${sku}-0`, role: 'MAIN', ordinal: 0,
        sourceUrl: `https://cdn1.ozone.ru/s3/multimedia-${index}.jpg`,
        sourceResponseHash: HASH,
      },
      {
        imageId: `image-${sku}-1`, role: 'DETAIL', ordinal: 1,
        sourceUrl: `https://cdn1.ozone.ru/s3/detail-${index}.jpg`,
        sourceResponseHash: HASH,
      },
    ],
    ...overrides,
  };
}

function harness({ currentSession = session(), capturedPage = pageFact(), capturedCard,
  confirmSamples = async () => ({ accepted: true }) } = {}) {
  const calls = { getSession: 0, page: 0, card: 0, confirm: 0, cancel: 0, ordinary: 0 };
  const confirmed = [];
  const controller = createCategoryStrategySamplingController({
    now: () => NOW,
    async getSession() { calls.getSession += 1; return currentSession; },
    async capturePageFacts() { calls.page += 1; return capturedPage; },
    async captureCardFacts(input) {
      calls.card += 1;
      const index = Number(String(input.sku).slice(-1)) || calls.card;
      return capturedCard ? capturedCard(input) : productFact(index, { sku: input.sku,
        sourceProductId: Number(input.sku), sourceProductRef: `product-${input.sku}` });
    },
    async confirmSamples(input) {
      calls.confirm += 1;
      confirmed.push(input);
      return confirmSamples(input);
    },
    async cancelSession() { calls.cancel += 1; return { cancelled: true }; },
  });
  return { calls, confirmed, controller };
}

test('no active or expired session keeps the dedicated mode inactive and clears selection', async () => {
  const absent = harness({ currentSession: null });
  assert.deepEqual(await absent.controller.refresh({ pageUrl: 'https://www.ozon.ru/category/17028922/' }), {
    mode: 'INACTIVE', reason: 'NO_SESSION', scope: null, expiresAt: null,
    selectedCount: 0, selectedSkus: [], canConfirm: false,
  });
  assert.equal(absent.calls.page, 0);

  const expired = harness({ currentSession: session({ expiresAt: '2026-08-14T23:59:59.000Z' }) });
  assert.equal((await expired.controller.refresh({
    pageUrl: 'https://www.ozon.ru/category/17028922/',
  })).reason, 'SESSION_EXPIRED');
  assert.equal(expired.calls.page, 0);
});

test('exact page scope activates the strategy-only mode without ordinary collection writes', async () => {
  const h = harness();
  const state = await h.controller.refresh({ pageUrl: 'https://www.ozon.ru/category/17028922/' });
  assert.equal(state.mode, MODE);
  assert.deepEqual(state.scope, SCOPE);
  assert.equal(state.selectedCount, 0);
  assert.equal(h.calls.ordinary, 0);
  assert.equal(JSON.stringify(state).includes('secret'), false);
});

test('missing or mismatched page identity blocks the whole page before card capture', async () => {
  for (const [label, capturedPage, reason] of [
    ['missing', { pageScope: { taxonomyScope: 'OZON:DEFAULT', descriptionCategoryId: 17028922 },
      sourceResponseHash: HASH }, 'PAGE_FACTS_INVALID'],
    ['mismatch', pageFact({ pageScope: { ...SCOPE, typeId: 999 } }), 'PAGE_SCOPE_MISMATCH'],
  ]) {
    const h = harness({ capturedPage });
    const state = await h.controller.refresh({ pageUrl: 'https://www.ozon.ru/category/17028922/' });
    assert.equal(state.mode, 'BLOCKED', label);
    assert.equal(state.reason, reason, label);
    await assert.rejects(h.controller.select({ sku: '4862904234',
      productUrl: 'https://www.ozon.ru/product/item-4862904234/' }), {
      code: 'CATEGORY_STRATEGY_SAMPLING_PAGE_BLOCKED',
    });
    assert.equal(h.calls.card, 0, label);
  }
});

test('card selection requires exact page and product scope and never guesses missing facts', async () => {
  for (const [label, fact] of [
    ['card mismatch', productFact(1, { productScope: { ...SCOPE, typeId: 1 } })],
    ['page mismatch', productFact(1, { pageScope: { ...SCOPE, descriptionCategoryId: 1 } })],
    ['missing type', productFact(1, { productScope: {
      taxonomyScope: 'OZON:DEFAULT', descriptionCategoryId: SCOPE.descriptionCategoryId,
    } })],
  ]) {
    const h = harness({ capturedCard: () => fact });
    await h.controller.refresh({ pageUrl: 'https://www.ozon.ru/category/17028922/' });
    await assert.rejects(h.controller.select({ sku: fact.sku,
      productUrl: `https://www.ozon.ru/product/item-${fact.sku}/` }), (error) =>
      ['CATEGORY_STRATEGY_SAMPLING_CARD_SCOPE_MISMATCH',
        'CATEGORY_STRATEGY_SAMPLING_FACTS_INVALID'].includes(error?.code), label);
    assert.equal(h.controller.snapshot().selectedCount, 0, label);
    assert.equal(h.calls.confirm, 0, label);
  }
});

test('card capture preserves only actionable closed lifecycle errors for safe UI recovery', async () => {
  for (const code of [
    'CATEGORY_STRATEGY_SAMPLING_PAGE_FACTS_INVALID',
    'CATEGORY_STRATEGY_SAMPLING_CARD_SCOPE_MISMATCH',
  ]) {
    const h = harness({ capturedCard: async () => { throw Object.assign(new Error(code), { code }); } });
    await h.controller.refresh({ pageUrl: 'https://www.ozon.ru/category/17028922/' });
    await assert.rejects(h.controller.select({ sku: '4862904234',
      productUrl: 'https://www.ozon.ru/product/item-4862904234/' }), { code });
    assert.equal(h.calls.ordinary, 0);
  }
});

test('selection deduplicates SKU, stops at twenty, and confirms only five to twenty', async () => {
  const h = harness();
  await h.controller.refresh({ pageUrl: 'https://www.ozon.ru/category/17028922/' });
  for (let index = 1; index <= 4; index += 1) {
    const sku = String(4_862_904_233 + index);
    await h.controller.select({ sku, productUrl: `https://www.ozon.ru/product/item-${sku}/` });
  }
  await assert.rejects(h.controller.confirm(), { code: 'CATEGORY_STRATEGY_SAMPLING_COUNT_INVALID' });
  assert.equal(h.calls.confirm, 0);

  const duplicateSku = '4862904234';
  await h.controller.select({ sku: duplicateSku,
    productUrl: `https://www.ozon.ru/product/item-${duplicateSku}/` });
  assert.equal(h.controller.snapshot().selectedCount, 4);

  for (let index = 5; index <= 20; index += 1) {
    const sku = String(4_862_904_233 + index);
    await h.controller.select({ sku, productUrl: `https://www.ozon.ru/product/item-${sku}/` });
  }
  assert.equal(h.controller.snapshot().selectedCount, 20);
  await assert.rejects(h.controller.select({ sku: '4862904999',
    productUrl: 'https://www.ozon.ru/product/item-4862904999/' }), {
    code: 'CATEGORY_STRATEGY_SAMPLING_COUNT_INVALID',
  });
  await h.controller.confirm();
  assert.equal(h.calls.confirm, 1);
  assert.equal(h.confirmed[0].samples.length, 20);
  assert.equal(h.calls.ordinary, 0);
});

test('confirmation is single-flight and disables confirmation until the request settles', async () => {
  let releaseConfirm;
  let markConfirmStarted;
  const confirmGate = new Promise((resolve) => { releaseConfirm = resolve; });
  const confirmStarted = new Promise((resolve) => { markConfirmStarted = resolve; });
  const h = harness({
    async confirmSamples() {
      markConfirmStarted();
      await confirmGate;
      return { accepted: true };
    },
  });
  await h.controller.refresh({ pageUrl: 'https://www.ozon.ru/category/17028922/' });
  for (let index = 1; index <= 5; index += 1) {
    const sku = String(4_862_904_233 + index);
    await h.controller.select({ sku, productUrl: `https://www.ozon.ru/product/item-${sku}/` });
  }

  const first = h.controller.confirm();
  await confirmStarted;
  const second = h.controller.confirm();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(h.controller.snapshot().canConfirm, false);
  assert.equal(h.calls.confirm, 1);
  releaseConfirm();
  assert.deepEqual(await second, await first);
});

test('a failed confirmation unlocks the same selection for one explicit retry', async () => {
  let attempts = 0;
  const h = harness({
    async confirmSamples() {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('temporary failure'), { code: 'TEMPORARY' });
      return { accepted: true };
    },
  });
  await h.controller.refresh({ pageUrl: 'https://www.ozon.ru/category/17028922/' });
  for (let index = 1; index <= 5; index += 1) {
    const sku = String(4_862_904_333 + index);
    await h.controller.select({ sku, productUrl: `https://www.ozon.ru/product/item-${sku}/` });
  }

  await assert.rejects(h.controller.confirm(), { code: 'TEMPORARY' });
  assert.equal(h.controller.snapshot().canConfirm, true);
  assert.equal(h.calls.confirm, 1);
  const retried = await h.controller.confirm();
  assert.equal(h.calls.confirm, 2);
  assert.equal(retried.reason, 'COMPLETED');
});

test('captured image evidence is closed MAIN zero plus at most five contiguous DETAIL refs', () => {
  assert.deepEqual(projectCapturedProductFact(productFact(1)), productFact(1));
  for (const invalid of [
    productFact(1, { sourceReferences: [] }),
    productFact(1, { sourceReferences: [
      { ...productFact(1).sourceReferences[0], role: 'DETAIL' },
    ] }),
    productFact(1, { sourceReferences: [
      productFact(1).sourceReferences[0],
      { ...productFact(1).sourceReferences[1], ordinal: 2 },
    ] }),
    productFact(1, { sourceReferences: Array.from({ length: 7 }, (_, index) => ({
      imageId: `image-${index}`, role: index === 0 ? 'MAIN' : 'DETAIL', ordinal: index,
      sourceUrl: `https://cdn1.ozone.ru/${index}.jpg`, sourceResponseHash: HASH,
    })) }),
    { ...productFact(1), vendorPayload: {} },
  ]) assert.throws(() => projectCapturedProductFact(invalid), {
    code: 'CATEGORY_STRATEGY_SAMPLING_FACTS_INVALID',
  });
});

test('accessors, revoked proxies, and extra session fields fail before capture or confirmation', async () => {
  let getterReads = 0;
  const accessor = session();
  Object.defineProperty(accessor, 'sessionId', {
    enumerable: true,
    get() { getterReads += 1; return 'session-a'; },
  });
  const revoked = Proxy.revocable(session(), {});
  revoked.revoke();
  for (const hostile of [accessor, revoked.proxy, { ...session(), sessionSecret: 'must-not-enter-content' }]) {
    const h = harness({ currentSession: hostile });
    const state = await h.controller.refresh({ pageUrl: 'https://www.ozon.ru/category/17028922/' });
    assert.equal(state.mode, 'INACTIVE');
    assert.equal(state.reason, 'SESSION_INVALID');
    assert.equal(h.calls.page, 0);
    assert.equal(h.calls.card, 0);
    assert.equal(h.calls.confirm, 0);
  }
  assert.equal(getterReads, 0);
});

test('cancel and account/session invalidation clear selected state without retaining facts', async () => {
  const h = harness();
  await h.controller.refresh({ pageUrl: 'https://www.ozon.ru/category/17028922/' });
  await h.controller.select({ sku: '4862904234',
    productUrl: 'https://www.ozon.ru/product/item-4862904234/' });
  assert.equal(h.controller.snapshot().selectedCount, 1);
  const state = await h.controller.cancel();
  assert.equal(h.calls.cancel, 1);
  assert.equal(state.mode, 'INACTIVE');
  assert.equal(state.selectedCount, 0);
  assert.equal(state.reason, 'CANCELLED');
});

test('validated facts restore across a page or tab controller lifecycle without ordinary collection', async () => {
  const restored = harness();
  await restored.controller.refresh({ pageUrl: 'https://www.ozon.ru/category/17028922/' });
  const state = restored.controller.restoreSelections(
    Array.from({ length: 5 }, (_, index) => productFact(index + 1)),
  );
  assert.equal(state.selectedCount, 5);
  assert.equal(state.canConfirm, true);
  assert.equal(restored.calls.ordinary, 0);
  assert.throws(() => restored.controller.restoreSelections([
    productFact(1, { productScope: { ...SCOPE, typeId: 1 } }),
  ]), { code: 'CATEGORY_STRATEGY_SAMPLING_CARD_SCOPE_MISMATCH' });
  assert.equal(restored.controller.snapshot().selectedCount, 0);
});

test('background client stores the raw session only in session storage and returns a redacted DTO', async () => {
  const state = {};
  const requests = [];
  const storageSession = {
    async get(key) { return { [key]: state[key] }; },
    async set(values) { Object.assign(state, values); },
    async remove(key) { delete state[key]; },
  };
  const client = createCategoryStrategySamplingBackgroundClient({
    storageSession,
    async currentAccount() { return { id: 'account-a' }; },
    extensionVersion: '0.13.46.3',
    async request(input) {
      requests.push(input);
      if (input.path.endsWith('/readiness')) return { ready: true };
      return { ...session(), sessionSecret: 'secret-value-at-least-32-characters' };
    },
  });
  await client.start({ sessionId: 'session-a' });
  const publicSession = await client.getSession({ sessionId: 'session-a' });
  assert.deepEqual(publicSession, session());
  assert.equal(state[PRIVATE_SESSION_KEY].sessionSecret,
    'secret-value-at-least-32-characters');
  assert.equal(JSON.stringify(publicSession).includes('secret-value'), false);
  assert.equal(JSON.stringify(requests).includes('secret-value'), false);
  assert.equal(requests[0].headers['x-zongzi-extension-version'], '0.13.46.3');
});

test('background readiness authenticates the account before announcing the extension without a session', async () => {
  const calls = [];
  const client = createCategoryStrategySamplingBackgroundClient({
    storageSession: {
      async get() { return {}; },
      async set() { throw new Error('readiness must not write session storage'); },
      async remove() {},
    },
    async currentAccount() { calls.push('account'); return { id: 'account-a' }; },
    extensionVersion: '0.13.46.3',
    async request(input) {
      calls.push(input);
      return { ready: true, minimumExtensionVersion: '0.13.46.3' };
    },
  });

  assert.deepEqual(await client.ready(), {
    ready: true, minimumExtensionVersion: '0.13.46.3',
  });
  assert.deepEqual(calls, ['account', {
    method: 'POST',
    path: '/extension/auto-listing/category-strategy/readiness',
    headers: { 'x-zongzi-extension-version': '0.13.46.3' },
    body: {},
  }]);
});

test('background confirmation uses only the dedicated endpoint and clears secret state on success', async () => {
  const state = { [PRIVATE_SESSION_KEY]: {
    accountId: 'account-a', ...session(), sessionSecret: 'secret-value-at-least-32-characters',
  } };
  const requests = [];
  const storageSession = {
    async get(key) { return { [key]: state[key] }; },
    async set(values) { Object.assign(state, values); },
    async remove(key) { delete state[key]; },
  };
  const client = createCategoryStrategySamplingBackgroundClient({
    storageSession,
    async currentAccount() { return { id: 'account-a' }; },
    extensionVersion: '0.13.46.3',
    async request(input) { requests.push(input); return { accepted: true }; },
  });
  const facts = Array.from({ length: 5 }, (_, index) => productFact(index + 1));
  assert.deepEqual(await client.confirm({ sessionId: 'session-a', pageFact: pageFact(), samples: facts }),
    { accepted: true });
  assert.equal(state[PRIVATE_SESSION_KEY], undefined);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path,
    '/extension/auto-listing/category-strategy/sampling-sessions/session-a/confirm');
  assert.equal(JSON.stringify(requests[0]).includes('secret-value'), false);
  assert.equal(requests.some((entry) => entry.path.includes('/sources/')
    || entry.path.includes('collect-box')), false);
});

test('background keeps only validated selected facts with the private session for cross-tab recovery', async () => {
  const state = { [PRIVATE_SESSION_KEY]: {
    accountId: 'account-a', ...session(), sessionSecret: 'secret-value-at-least-32-characters',
  } };
  const storageSession = {
    async get(key) { return { [key]: state[key] }; },
    async set(values) { Object.assign(state, values); },
    async remove(key) { delete state[key]; },
  };
  const client = createCategoryStrategySamplingBackgroundClient({
    storageSession,
    async currentAccount() { return { id: 'account-a' }; },
    extensionVersion: '0.13.46.3',
    async request() { throw new Error('not called'); },
  });
  await client.rememberFact({ sessionId: 'session-a', fact: productFact(1) });
  assert.deepEqual(await client.listFacts({ sessionId: 'session-a' }), [productFact(1)]);
  assert.equal(JSON.stringify(await client.listFacts({ sessionId: 'session-a' })).includes('secret-value'), false);
  await client.removeFact({ sessionId: 'session-a', sku: productFact(1).sku });
  assert.deepEqual(await client.listFacts({ sessionId: 'session-a' }), []);
  assert.equal(state[PRIVATE_SESSION_KEY].sessionSecret,
    'secret-value-at-least-32-characters');
});

test('a new page or restarted worker START preserves same-account same-session selections', async () => {
  const state = {};
  const storageSession = {
    async get(key) { return { [key]: state[key] }; },
    async set(values) { Object.assign(state, values); },
    async remove(key) { delete state[key]; },
  };
  const dependencies = {
    storageSession,
    async currentAccount() { return { id: 'account-a' }; },
    extensionVersion: '0.13.46.3',
    async request(input) {
      if (input.path.endsWith('/readiness')) return { ready: true };
      return { ...session(), sessionSecret: 'secret-value-at-least-32-characters' };
    },
  };
  const client = createCategoryStrategySamplingBackgroundClient(dependencies);
  await client.start({ sessionId: 'session-a' });
  await client.rememberFact({ sessionId: 'session-a', fact: productFact(1) });
  const restarted = createCategoryStrategySamplingBackgroundClient(dependencies);
  await restarted.start({ sessionId: 'session-a' });
  assert.deepEqual(await restarted.listFacts({ sessionId: 'session-a' }), [productFact(1)]);
});

test('two active sessions in one account retain independent secrets and selected facts', async () => {
  const state = {};
  const storageSession = {
    async get(key) { return { [key]: state[key] }; },
    async set(values) { Object.assign(state, values); },
    async remove(key) { delete state[key]; },
  };
  const client = createCategoryStrategySamplingBackgroundClient({
    storageSession,
    async currentAccount() { return { id: 'account-a' }; },
    extensionVersion: '0.13.46.3',
    async request(input) {
      if (input.path.endsWith('/readiness')) return { ready: true };
      const requested = input.path.endsWith('/session-b') ? 'session-b' : 'session-a';
      return { ...session({ sessionId: requested, draftId: `draft-${requested.at(-1)}` }),
        sessionSecret: `${requested}-secret-value-at-least-32-characters` };
    },
  });
  await client.start({ sessionId: 'session-a' });
  await client.start({ sessionId: 'session-b' });
  await client.rememberFact({ sessionId: 'session-a', fact: productFact(1) });
  await client.rememberFact({ sessionId: 'session-b', fact: productFact(2) });
  assert.deepEqual((await client.listFacts({ sessionId: 'session-a' })).map((fact) => fact.sku),
    [productFact(1).sku]);
  assert.deepEqual((await client.listFacts({ sessionId: 'session-b' })).map((fact) => fact.sku),
    [productFact(2).sku]);
  assert.notEqual(state[`${SESSION_STORAGE_KEY}.account-a.session-a`].sessionSecret,
    state[`${SESSION_STORAGE_KEY}.account-a.session-b`].sessionSecret);
});

test('concurrent tabs serialize selection mutations without dropping either SKU', async () => {
  const state = { [PRIVATE_SESSION_KEY]: {
    accountId: 'account-a', ...session(), sessionSecret: 'secret-value-at-least-32-characters',
  }, [PRIVATE_INDEX_KEY]: ['account-a\0session-a'] };
  const client = createCategoryStrategySamplingBackgroundClient({
    storageSession: {
      async get(key) {
        if (key === PRIVATE_SESSION_KEY) await new Promise((resolve) => setTimeout(resolve, 5));
        return { [key]: state[key] };
      },
      async set(values) { Object.assign(state, values); },
      async remove(key) { delete state[key]; },
    },
    async currentAccount() { return { id: 'account-a' }; },
    extensionVersion: '0.13.46.3',
    async request() { throw new Error('not called'); },
  });
  await Promise.all([
    client.rememberFact({ sessionId: 'session-a', fact: productFact(1) }),
    client.rememberFact({ sessionId: 'session-a', fact: productFact(2) }),
  ]);
  assert.deepEqual((await client.listFacts({ sessionId: 'session-a' })).map((fact) => fact.sku),
    [productFact(1).sku, productFact(2).sku]);
});

test('background account switch and cancel remove session-only state', async () => {
  const state = { [PRIVATE_SESSION_KEY]: {
    accountId: 'account-a', ...session(), sessionSecret: 'secret-value-at-least-32-characters',
  }, [PRIVATE_INDEX_KEY]: ['account-a\0session-a'] };
  const requests = [];
  const storageSession = {
    async get(key) { return { [key]: state[key] }; },
    async set(values) { Object.assign(state, values); },
    async remove(key) { delete state[key]; },
  };
  const client = createCategoryStrategySamplingBackgroundClient({
    storageSession,
    async currentAccount() { return { id: 'account-b' }; },
    extensionVersion: '0.13.46.3',
    async request(input) { requests.push(input); return null; },
  });
  assert.equal(await client.getSession({ sessionId: 'session-a' }), null);
  assert.equal(state[PRIVATE_SESSION_KEY], undefined);
  assert.equal(requests.at(-1).method, 'GET');
});

test('cancel clears session-only state even when the dedicated endpoint is unavailable', async () => {
  const state = { [PRIVATE_SESSION_KEY]: {
    accountId: 'account-a', ...session(), sessionSecret: 'secret-value-at-least-32-characters',
  } };
  const client = createCategoryStrategySamplingBackgroundClient({
    storageSession: {
      async get(key) { return { [key]: state[key] }; },
      async set(values) { Object.assign(state, values); },
      async remove(key) { delete state[key]; },
    },
    async currentAccount() { return { id: 'account-a' }; },
    extensionVersion: '0.13.46.3',
    async request() { throw Object.assign(new Error('offline'), { code: 'OFFLINE' }); },
  });
  await assert.rejects(client.cancel({ sessionId: 'session-a' }), { code: 'OFFLINE' });
  assert.equal(state[PRIVATE_SESSION_KEY], undefined);
});

test('hostile server session payloads are rejected without reading accessors or persisting secrets', async () => {
  let getterReads = 0;
  const hostile = { ...session(), sessionSecret: 'secret-value-at-least-32-characters' };
  Object.defineProperty(hostile, 'scope', { enumerable: true, get() {
    getterReads += 1;
    return SCOPE;
  } });
  const state = {};
  let calls = 0;
  const client = createCategoryStrategySamplingBackgroundClient({
    storageSession: {
      async get(key) { return { [key]: state[key] }; },
      async set(values) { Object.assign(state, values); },
      async remove(key) { delete state[key]; },
    },
    async currentAccount() { return { id: 'account-a' }; },
    extensionVersion: '0.13.46.3',
    async request() { calls += 1; return calls === 1 ? { ready: true } : hostile; },
  });
  await assert.rejects(client.start({ sessionId: 'session-a' }), {
    code: 'CATEGORY_STRATEGY_SAMPLING_FACTS_INVALID',
  });
  assert.equal(getterReads, 0);
  assert.equal(state[PRIVATE_SESSION_KEY], undefined);
});

test('structured Ozon capture accepts one exact scope and rejects ambiguous or missing identity', async () => {
  const exact = await extractOzonCapturedFacts({
    payload: {
      widgetStates: {
        product: JSON.stringify({ sku: '4862904234', description_category_id: 17028922,
          type_id: 91542, images: [
            { url: 'https://cdn1.ozone.ru/main.jpg' },
            { url: 'https://cdn1.ozone.ru/detail.jpg' },
          ] }),
      },
    },
    expectedSku: '4862904234',
    expectedBuyerCategoryId: null,
    responseHash: HASH,
  });
  assert.deepEqual(exact.scope, SCOPE);
  assert.equal(exact.images.length, 2);
  assert.throws(() => extractOzonCapturedFacts({
    payload: [{ descriptionCategoryId: 17028922, typeId: 91542 },
      { descriptionCategoryId: 17028922, typeId: 1 }],
    expectedSku: null, expectedBuyerCategoryId: null, responseHash: HASH,
  }), { code: 'CATEGORY_STRATEGY_SAMPLING_FACTS_AMBIGUOUS' });
  assert.throws(() => extractOzonCapturedFacts({ payload: { categoryName: '猜测无效' },
    expectedSku: null, expectedBuyerCategoryId: null, responseHash: HASH }), {
    code: 'CATEGORY_STRATEGY_SAMPLING_FACTS_INVALID',
  });
});

test('public Ozon product facts use exact SKU and buyer category without requiring Seller ids', () => {
  const exact = extractOzonCapturedFacts({
    payload: {
      widgetStates: {
        category: JSON.stringify({
          categoryId: 11504,
          categoryName: 'Столы и наборы мебели',
          sku: '5000090976',
        }),
        image: JSON.stringify({
          image: 'https://ir.ozone.ru/s3/multimedia-1-5/12498991097.jpg',
          sku: '5000090976',
        }),
      },
    },
    expectedSku: '5000090976',
    expectedBuyerCategoryId: 11504,
    responseHash: HASH,
  });
  assert.equal(exact.scope, null);
  assert.equal(exact.buyerCategoryId, 11504);
  assert.deepEqual(exact.images, [
    'https://ir.ozone.ru/s3/multimedia-1-5/12498991097.jpg',
  ]);

  assert.throws(() => extractOzonCapturedFacts({
    payload: { categoryId: 11505, sku: '5000090976',
      image: 'https://ir.ozone.ru/wrong-category.jpg' },
    expectedSku: '5000090976',
    expectedBuyerCategoryId: 11504,
    responseHash: HASH,
  }), { code: 'CATEGORY_STRATEGY_SAMPLING_CARD_SCOPE_MISMATCH' });

  for (const payload of [
    { categoryId: 11504, sku: '5000090977', image: 'https://ir.ozone.ru/wrong-sku.jpg' },
    { categoryId: 11504, sku: '5000090976' },
  ]) assert.throws(() => extractOzonCapturedFacts({
    payload,
    expectedSku: '5000090976',
    expectedBuyerCategoryId: 11504,
    responseHash: HASH,
  }), { code: 'CATEGORY_STRATEGY_SAMPLING_FACTS_INVALID' });
});

test('public Ozon product facts join an exact gallery SKU with its separate leaf breadcrumb', () => {
  const exact = extractOzonCapturedFacts({
    payload: {
      widgetStates: {
        'webGallery-5000090976-default-1': JSON.stringify({
          sku: '5000090976',
          images: [
            { url: 'https://ir.ozone.ru/s3/multimedia-1-5/12498991097.jpg' },
            { url: 'https://ir.ozone.ru/s3/multimedia-1-5/12498991098.jpg' },
          ],
        }),
        'breadCrumbs-5000090976-default-1': JSON.stringify({
          breadcrumbs: [
            { link: '/category/turizm-i-otdyh-na-prirode-11424/' },
            { link: '/category/skladnaya-pohodnaya-mebel-32938/' },
            { link: '/category/nabory-skladnoy-mebeli-11504/' },
            { link: '/category/nabory-skladnoy-mebeli-11504/mqouo-101091944/' },
          ],
        }),
      },
    },
    expectedSku: '5000090976',
    expectedBuyerCategoryId: 11504,
    responseHash: HASH,
  });

  assert.equal(exact.scope, null);
  assert.equal(exact.buyerCategoryId, 11504);
  assert.deepEqual(exact.images, [
    'https://ir.ozone.ru/s3/multimedia-1-5/12498991097.jpg',
    'https://ir.ozone.ru/s3/multimedia-1-5/12498991098.jpg',
  ]);
});

test('category page facts use the trusted session scope when public Ozon data omits Seller ids', () => {
  assert.deepEqual(projectCapturedPageFactFromSession({
    session: session(),
    responseHash: HASH,
  }), {
    pageScope: SCOPE,
    sourceResponseHash: HASH,
  });
});
