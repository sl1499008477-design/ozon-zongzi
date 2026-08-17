(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.JzCategoryStrategySampling = api;
})(typeof globalThis === 'object' ? globalThis : this, function() {
  'use strict';

  const MODE = 'CATEGORY_STRATEGY_SAMPLING';
  const SESSION_STORAGE_KEY = 'zongzi.categoryStrategySampling.session';
  const SESSION_INDEX_KEY = `${SESSION_STORAGE_KEY}.index`;
  const HASH = /^[a-f0-9]{64}$/;
  const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;
  const SKU = /^[1-9][0-9]{4,19}$/;
  const SESSION_KEYS = new Set(['sessionId', 'draftId', 'extensionMode', 'scope', 'expiresAt']);
  const PRIVATE_SESSION_KEYS = new Set([
    'accountId', ...SESSION_KEYS, 'sessionSecret', 'selectedFacts',
  ]);
  const LEGACY_PRIVATE_SESSION_KEYS = new Set([
    'accountId', ...SESSION_KEYS, 'sessionSecret',
  ]);
  const SCOPE_KEYS = new Set(['taxonomyScope', 'descriptionCategoryId', 'typeId']);
  const PAGE_KEYS = new Set(['pageScope', 'sourceResponseHash']);
  const PRODUCT_KEYS = new Set([
    'sku', 'sourceProductId', 'sourceProductRef', 'sourceProductResponseHash',
    'pageScope', 'productScope', 'sourceReferences',
  ]);
  const REFERENCE_KEYS = new Set([
    'imageId', 'role', 'ordinal', 'sourceUrl', 'sourceResponseHash',
  ]);
  const ACTIONABLE_CAPTURE_ERRORS = new Set([
    'CATEGORY_STRATEGY_SAMPLING_FACTS_INVALID',
    'CATEGORY_STRATEGY_SAMPLING_PAGE_FACTS_INVALID',
    'CATEGORY_STRATEGY_SAMPLING_CARD_SCOPE_MISMATCH',
    'CATEGORY_STRATEGY_SAMPLING_COUNT_INVALID',
  ]);

  function failure(code) {
    return Object.assign(new Error(code), { code });
  }

  function invalidFacts() {
    return failure('CATEGORY_STRATEGY_SAMPLING_FACTS_INVALID');
  }

  function descriptors(raw, keys, error = invalidFacts) {
    try {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw error();
      const all = Object.getOwnPropertyDescriptors(raw);
      const own = Reflect.ownKeys(all);
      if (own.length !== keys.size || own.some((key) => typeof key !== 'string'
        || !keys.has(key) || all[key]?.enumerable !== true
        || !Object.hasOwn(all[key], 'value'))) throw error();
      return Object.fromEntries(own.map((key) => [key, all[key].value]));
    } catch (caught) {
      if (caught?.code) throw caught;
      throw error();
    }
  }

  function arrayValues(raw, minimum, maximum, error = invalidFacts) {
    try {
      if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype
        || raw.length < minimum || raw.length > maximum) throw error();
      const all = Object.getOwnPropertyDescriptors(raw);
      const own = Reflect.ownKeys(all);
      if (own.length !== raw.length + 1 || all.length?.value !== raw.length) throw error();
      return Array.from({ length: raw.length }, (_, index) => {
        const descriptor = all[String(index)];
        if (!descriptor || descriptor.enumerable !== true
          || !Object.hasOwn(descriptor, 'value')) throw error();
        return descriptor.value;
      });
    } catch (caught) {
      if (caught?.code) throw caught;
      throw error();
    }
  }

  function freeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) freeze(child);
    return Object.freeze(value);
  }

  function id(value) {
    if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) throw invalidFacts();
    return value;
  }

  function positive(value) {
    if (!Number.isSafeInteger(value) || value < 1) throw invalidFacts();
    return value;
  }

  function exactIso(value) {
    if (typeof value !== 'string') throw invalidFacts();
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) throw invalidFacts();
    return value;
  }

  function projectExactScope(raw) {
    const value = descriptors(raw, SCOPE_KEYS);
    if (value.taxonomyScope !== 'OZON:DEFAULT') throw invalidFacts();
    return freeze({
      taxonomyScope: value.taxonomyScope,
      descriptionCategoryId: positive(value.descriptionCategoryId),
      typeId: positive(value.typeId),
    });
  }

  function sameScope(left, right) {
    return left.taxonomyScope === right.taxonomyScope
      && left.descriptionCategoryId === right.descriptionCategoryId
      && left.typeId === right.typeId;
  }

  function projectSamplingSession(raw) {
    const value = descriptors(raw, SESSION_KEYS);
    if (value.extensionMode !== MODE) throw invalidFacts();
    return freeze({
      sessionId: id(value.sessionId),
      draftId: id(value.draftId),
      extensionMode: MODE,
      scope: projectExactScope(value.scope),
      expiresAt: exactIso(value.expiresAt),
    });
  }

  function projectCapturedPageFact(raw) {
    const value = descriptors(raw, PAGE_KEYS);
    if (typeof value.sourceResponseHash !== 'string' || !HASH.test(value.sourceResponseHash)) {
      throw invalidFacts();
    }
    return freeze({
      pageScope: projectExactScope(value.pageScope),
      sourceResponseHash: value.sourceResponseHash,
    });
  }

  function projectCapturedPageFactFromSession(raw) {
    const value = descriptors(raw, new Set(['session', 'responseHash']));
    const session = projectSamplingSession(value.session);
    return projectCapturedPageFact({
      pageScope: session.scope,
      sourceResponseHash: value.responseHash,
    });
  }

  function sourceUrl(raw) {
    if (typeof raw !== 'string' || raw.length > 2048) throw invalidFacts();
    let url;
    try { url = new URL(raw); } catch { throw invalidFacts(); }
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    const allowed = host === 'ozon.ru' || host.endsWith('.ozon.ru')
      || host === 'ozon.kz' || host.endsWith('.ozon.kz')
      || host === 'ozone.ru' || host.endsWith('.ozone.ru')
      || host === 'ozonusercontent.com' || host.endsWith('.ozonusercontent.com')
      || host === 'ozonru.cn' || host.endsWith('.ozonru.cn');
    if (url.protocol !== 'https:' || url.username || url.password || !allowed) throw invalidFacts();
    return url.href;
  }

  function projectReference(raw, index) {
    const value = descriptors(raw, REFERENCE_KEYS);
    const expectedRole = index === 0 ? 'MAIN' : 'DETAIL';
    if (value.role !== expectedRole || value.ordinal !== index
      || typeof value.sourceResponseHash !== 'string' || !HASH.test(value.sourceResponseHash)) {
      throw invalidFacts();
    }
    return freeze({
      imageId: id(value.imageId),
      role: expectedRole,
      ordinal: index,
      sourceUrl: sourceUrl(value.sourceUrl),
      sourceResponseHash: value.sourceResponseHash,
    });
  }

  function projectCapturedProductFact(raw) {
    const value = descriptors(raw, PRODUCT_KEYS);
    if (typeof value.sku !== 'string' || !SKU.test(value.sku)
      || Number(value.sku) !== value.sourceProductId
      || typeof value.sourceProductResponseHash !== 'string'
      || !HASH.test(value.sourceProductResponseHash)) throw invalidFacts();
    const refs = arrayValues(value.sourceReferences, 1, 6)
      .map((reference, index) => projectReference(reference, index));
    if (new Set(refs.map((reference) => reference.imageId)).size !== refs.length) throw invalidFacts();
    return freeze({
      sku: value.sku,
      sourceProductId: positive(value.sourceProductId),
      sourceProductRef: id(value.sourceProductRef),
      sourceProductResponseHash: value.sourceProductResponseHash,
      pageScope: projectExactScope(value.pageScope),
      productScope: projectExactScope(value.productScope),
      sourceReferences: freeze(refs),
    });
  }

  function projectSelection(raw) {
    const value = descriptors(raw, new Set(['sku', 'productUrl']), () =>
      failure('CATEGORY_STRATEGY_SAMPLING_REQUEST_INVALID'));
    if (typeof value.sku !== 'string' || !SKU.test(value.sku)) {
      throw failure('CATEGORY_STRATEGY_SAMPLING_REQUEST_INVALID');
    }
    let url;
    try { url = new URL(value.productUrl); } catch {
      throw failure('CATEGORY_STRATEGY_SAMPLING_REQUEST_INVALID');
    }
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (url.protocol !== 'https:' || url.username || url.password
      || !(['ozon.ru', 'ozon.kz'].includes(host) || host.endsWith('.ozon.ru') || host.endsWith('.ozon.kz'))
      || !url.pathname.startsWith('/product/')) {
      throw failure('CATEGORY_STRATEGY_SAMPLING_REQUEST_INVALID');
    }
    return freeze({ sku: value.sku, productUrl: url.href });
  }

  function createCategoryStrategySamplingController(rawOptions = {}) {
    const options = descriptors(rawOptions, new Set([
      'now', 'getSession', 'capturePageFacts', 'captureCardFacts',
      'confirmSamples', 'cancelSession',
    ]), () => failure('CATEGORY_STRATEGY_SAMPLING_DEPENDENCY_INVALID'));
    if (Object.values(options).some((value) => typeof value !== 'function')) {
      throw failure('CATEGORY_STRATEGY_SAMPLING_DEPENDENCY_INVALID');
    }
    let activeSession = null;
    let stateMode = 'INACTIVE';
    let reason = 'NO_SESSION';
    let page = null;
    let currentPageUrl = null;
    const selected = new Map();

    function clear(nextReason = 'NO_SESSION') {
      activeSession = null;
      page = null;
      currentPageUrl = null;
      selected.clear();
      stateMode = 'INACTIVE';
      reason = nextReason;
    }

    function snapshot() {
      return freeze({
        mode: stateMode,
        reason,
        scope: activeSession ? activeSession.scope : null,
        expiresAt: activeSession ? activeSession.expiresAt : null,
        selectedCount: selected.size,
        selectedSkus: [...selected.keys()],
        canConfirm: stateMode === MODE && selected.size >= 5 && selected.size <= 20,
      });
    }

    function currentMillis() {
      const value = Number(options.now());
      if (!Number.isFinite(value)) throw failure('CATEGORY_STRATEGY_SAMPLING_CLOCK_INVALID');
      return value;
    }

    async function refresh(raw = {}) {
      let input;
      try {
        input = descriptors(raw, new Set(['pageUrl']), () =>
          failure('CATEGORY_STRATEGY_SAMPLING_REQUEST_INVALID'));
      } catch {
        clear('SESSION_INVALID');
        return snapshot();
      }
      let current;
      try { current = await options.getSession(); } catch {
        clear('SESSION_INVALID');
        return snapshot();
      }
      if (current === null) {
        clear('NO_SESSION');
        return snapshot();
      }
      try { activeSession = projectSamplingSession(current); } catch {
        clear('SESSION_INVALID');
        return snapshot();
      }
      selected.clear();
      if (Date.parse(activeSession.expiresAt) <= currentMillis()) {
        clear('SESSION_EXPIRED');
        return snapshot();
      }
      let captured;
      try {
        captured = projectCapturedPageFact(await options.capturePageFacts({
          sessionId: activeSession.sessionId,
          pageUrl: input.pageUrl,
        }));
      } catch {
        page = null;
        stateMode = 'BLOCKED';
        reason = 'PAGE_FACTS_INVALID';
        return snapshot();
      }
      if (!sameScope(captured.pageScope, activeSession.scope)) {
        page = null;
        stateMode = 'BLOCKED';
        reason = 'PAGE_SCOPE_MISMATCH';
        return snapshot();
      }
      page = captured;
      currentPageUrl = input.pageUrl;
      stateMode = MODE;
      reason = null;
      return snapshot();
    }

    async function select(raw) {
      if (stateMode !== MODE || !activeSession || !page) {
        throw failure('CATEGORY_STRATEGY_SAMPLING_PAGE_BLOCKED');
      }
      if (Date.parse(activeSession.expiresAt) <= currentMillis()) {
        clear('SESSION_EXPIRED');
        throw failure('CATEGORY_STRATEGY_SAMPLING_SESSION_EXPIRED');
      }
      const input = projectSelection(raw);
      if (selected.has(input.sku)) return snapshot();
      if (selected.size >= 20) throw failure('CATEGORY_STRATEGY_SAMPLING_COUNT_INVALID');
      let fact;
      try {
        fact = projectCapturedProductFact(await options.captureCardFacts({
          sessionId: activeSession.sessionId,
          sku: input.sku,
          productUrl: input.productUrl,
          pageUrl: currentPageUrl,
          pageResponseHash: page.sourceResponseHash,
        }));
      } catch (caught) {
        if (ACTIONABLE_CAPTURE_ERRORS.has(caught?.code)) throw failure(caught.code);
        throw invalidFacts();
      }
      if (fact.sku !== input.sku || fact.sourceProductId !== Number(input.sku)
        || !sameScope(fact.pageScope, activeSession.scope)
        || !sameScope(fact.productScope, activeSession.scope)) {
        throw failure('CATEGORY_STRATEGY_SAMPLING_CARD_SCOPE_MISMATCH');
      }
      selected.set(fact.sku, fact);
      return snapshot();
    }

    function deselect(raw = {}) {
      const value = descriptors(raw, new Set(['sku']), () =>
        failure('CATEGORY_STRATEGY_SAMPLING_REQUEST_INVALID'));
      if (typeof value.sku !== 'string' || !SKU.test(value.sku)) {
        throw failure('CATEGORY_STRATEGY_SAMPLING_REQUEST_INVALID');
      }
      selected.delete(value.sku);
      return snapshot();
    }

    function restoreSelections(raw) {
      if (stateMode !== MODE || !activeSession || !page) {
        throw failure('CATEGORY_STRATEGY_SAMPLING_PAGE_BLOCKED');
      }
      const facts = arrayValues(raw, 0, 20).map(projectCapturedProductFact);
      if (new Set(facts.map((fact) => fact.sku)).size !== facts.length
        || facts.some((fact) => !sameScope(fact.pageScope, activeSession.scope)
          || !sameScope(fact.productScope, activeSession.scope))) {
        selected.clear();
        throw failure('CATEGORY_STRATEGY_SAMPLING_CARD_SCOPE_MISMATCH');
      }
      selected.clear();
      for (const fact of facts) selected.set(fact.sku, fact);
      return snapshot();
    }

    async function confirm() {
      if (stateMode !== MODE || !activeSession || selected.size < 5 || selected.size > 20) {
        throw failure('CATEGORY_STRATEGY_SAMPLING_COUNT_INVALID');
      }
      if (Date.parse(activeSession.expiresAt) <= currentMillis()) {
        clear('SESSION_EXPIRED');
        throw failure('CATEGORY_STRATEGY_SAMPLING_SESSION_EXPIRED');
      }
      const result = await options.confirmSamples({
        sessionId: activeSession.sessionId,
        pageFact: page,
        samples: freeze([...selected.values()]),
      });
      clear('COMPLETED');
      return freeze({ ...snapshot(), result });
    }

    async function cancel() {
      const sessionId = activeSession?.sessionId || null;
      try {
        if (sessionId) await options.cancelSession({ sessionId });
      } finally {
        clear('CANCELLED');
      }
      return snapshot();
    }

    return Object.freeze({ refresh, select, deselect, restoreSelections, confirm, cancel, snapshot });
  }

  function accountId(raw) {
    const value = descriptors(raw, new Set(['id']), () =>
      failure('CATEGORY_STRATEGY_SAMPLING_ACCOUNT_INVALID'));
    return id(value.id);
  }

  function projectPrivateSession(raw, expectedAccountId) {
    let own;
    try { own = Reflect.ownKeys(Object.getOwnPropertyDescriptors(raw)); }
    catch { throw invalidFacts(); }
    const value = descriptors(raw, own.includes('selectedFacts')
      ? PRIVATE_SESSION_KEYS : LEGACY_PRIVATE_SESSION_KEYS);
    if (value.accountId !== expectedAccountId || typeof value.sessionSecret !== 'string'
      || value.sessionSecret.length < 32 || value.sessionSecret.length > 512) throw invalidFacts();
    const publicSession = projectSamplingSession({
      sessionId: value.sessionId,
      draftId: value.draftId,
      extensionMode: value.extensionMode,
      scope: value.scope,
      expiresAt: value.expiresAt,
    });
    const selectedFacts = Object.hasOwn(value, 'selectedFacts')
      ? arrayValues(value.selectedFacts, 0, 20).map(projectCapturedProductFact) : [];
    if (new Set(selectedFacts.map((fact) => fact.sku)).size !== selectedFacts.length
      || selectedFacts.some((fact) => !sameScope(fact.pageScope, publicSession.scope)
        || !sameScope(fact.productScope, publicSession.scope))) throw invalidFacts();
    return freeze({ accountId: expectedAccountId, ...publicSession,
      sessionSecret: value.sessionSecret, selectedFacts: freeze(selectedFacts) });
  }

  function redactPrivateSession(raw, expectedAccountId) {
    const stored = projectPrivateSession(raw, expectedAccountId);
    return projectSamplingSession({ sessionId: stored.sessionId, draftId: stored.draftId,
      extensionMode: stored.extensionMode, scope: stored.scope, expiresAt: stored.expiresAt });
  }

  function projectServerSession(raw, expectedAccountId) {
    const value = descriptors(raw, new Set([
      'sessionId', 'draftId', 'extensionMode', 'scope', 'expiresAt', 'sessionSecret',
    ]));
    return projectPrivateSession({ accountId: expectedAccountId,
      sessionId: value.sessionId, draftId: value.draftId, extensionMode: value.extensionMode,
      scope: value.scope, expiresAt: value.expiresAt, sessionSecret: value.sessionSecret,
      selectedFacts: [] },
    expectedAccountId);
  }

  function createCategoryStrategySamplingBackgroundClient(rawOptions = {}) {
    const options = descriptors(rawOptions, new Set([
      'storageSession', 'currentAccount', 'extensionVersion', 'request',
    ]), () => failure('CATEGORY_STRATEGY_SAMPLING_DEPENDENCY_INVALID'));
    if (!options.storageSession || typeof options.storageSession.get !== 'function'
      || typeof options.storageSession.set !== 'function'
      || typeof options.storageSession.remove !== 'function'
      || typeof options.currentAccount !== 'function' || typeof options.request !== 'function'
      || typeof options.extensionVersion !== 'string' || options.extensionVersion.length < 5
      || options.extensionVersion.length > 40) {
      throw failure('CATEGORY_STRATEGY_SAMPLING_DEPENDENCY_INVALID');
    }
    const headers = freeze({ 'x-zongzi-extension-version': options.extensionVersion });
    let mutationOwner = Promise.resolve();
    const serializeMutation = (operation) => {
      const result = mutationOwner.then(operation, operation);
      mutationOwner = result.catch(() => {});
      return result;
    };

    function storageKey(currentId, sessionId) {
      return `${SESSION_STORAGE_KEY}.${id(currentId)}.${id(sessionId)}`;
    }

    async function readIndex() {
      try {
        const value = (await options.storageSession.get(SESSION_INDEX_KEY))?.[SESSION_INDEX_KEY];
        if (value === undefined) return [];
        return arrayValues(value, 0, 100).filter((entry) => typeof entry === 'string'
          && entry.includes('\0')).map((entry) => {
          const [indexedAccountId, indexedSessionId, ...extra] = entry.split('\0');
          if (extra.length || !ID.test(indexedAccountId) || !ID.test(indexedSessionId)) {
            throw invalidFacts();
          }
          return { accountId: indexedAccountId, sessionId: indexedSessionId };
        });
      } catch {
        await options.storageSession.remove(SESSION_INDEX_KEY);
        return [];
      }
    }

    async function writeIndex(entries) {
      await options.storageSession.set({ [SESSION_INDEX_KEY]: freeze(entries.map((entry) =>
        `${entry.accountId}\0${entry.sessionId}`)) });
    }

    async function currentAccountId() {
      const currentId = accountId(await options.currentAccount());
      const entries = await readIndex();
      const keep = [];
      for (const entry of entries) {
        if (entry.accountId === currentId) keep.push(entry);
        else await options.storageSession.remove(storageKey(entry.accountId, entry.sessionId));
      }
      if (keep.length !== entries.length) await writeIndex(keep);
      return currentId;
    }

    async function registerSession(currentId, sessionId) {
      const entries = await readIndex();
      if (!entries.some((entry) => entry.accountId === currentId && entry.sessionId === sessionId)) {
        entries.push({ accountId: currentId, sessionId });
        await writeIndex(entries);
      }
    }

    async function removeStored(currentId, sessionId) {
      await options.storageSession.remove(storageKey(currentId, sessionId));
      const entries = (await readIndex()).filter((entry) =>
        entry.accountId !== currentId || entry.sessionId !== sessionId);
      await writeIndex(entries);
    }

    async function storedFor(currentId, sessionId) {
      const key = storageKey(currentId, sessionId);
      let candidate;
      try { candidate = (await options.storageSession.get(key))?.[key]; }
      catch { await removeStored(currentId, sessionId); return null; }
      if (!candidate) return null;
      try {
        const stored = projectPrivateSession(candidate, currentId);
        if (stored.sessionId !== sessionId) throw invalidFacts();
        return stored;
      } catch { await removeStored(currentId, sessionId); return null; }
    }

    async function fetchSession(currentId, sessionId, previous = null) {
      const response = await options.request({ method: 'GET',
        path: `/extension/auto-listing/category-strategy/sampling-sessions/${encodeURIComponent(sessionId)}`,
        headers });
      const key = storageKey(currentId, sessionId);
      if (response === null) {
        await removeStored(currentId, sessionId);
        return null;
      }
      let privateSession = projectServerSession(response, currentId);
      if (previous?.sessionId === privateSession.sessionId
        && sameScope(previous.scope, privateSession.scope)) {
        privateSession = freeze({ ...privateSession, selectedFacts: previous.selectedFacts });
      }
      await options.storageSession.set({ [key]: privateSession });
      await registerSession(currentId, sessionId);
      return redactPrivateSession(privateSession, currentId);
    }

    async function start(raw) {
      const value = descriptors(raw, new Set(['sessionId']), () =>
        failure('CATEGORY_STRATEGY_SAMPLING_REQUEST_INVALID'));
      const sessionId = id(value.sessionId);
      return serializeMutation(async () => {
        const currentId = await currentAccountId();
        const previous = await storedFor(currentId, sessionId);
        await options.request({ method: 'POST',
          path: '/extension/auto-listing/category-strategy/readiness', headers, body: {} });
        return fetchSession(currentId, sessionId, previous);
      });
    }

    async function ready() {
      accountId(await options.currentAccount());
      const result = descriptors(await options.request({ method: 'POST',
        path: '/extension/auto-listing/category-strategy/readiness', headers, body: {} }),
      new Set(['ready', 'minimumExtensionVersion']), () =>
        failure('CATEGORY_STRATEGY_SAMPLING_REQUEST_INVALID'));
      if (result.ready !== true || typeof result.minimumExtensionVersion !== 'string'
        || result.minimumExtensionVersion.length < 5 || result.minimumExtensionVersion.length > 40) {
        throw failure('CATEGORY_STRATEGY_SAMPLING_REQUEST_INVALID');
      }
      return freeze({ ready: true, minimumExtensionVersion: result.minimumExtensionVersion });
    }

    async function getSession(raw) {
      const value = descriptors(raw, new Set(['sessionId']), () =>
        failure('CATEGORY_STRATEGY_SAMPLING_REQUEST_INVALID'));
      const sessionId = id(value.sessionId);
      return serializeMutation(async () => {
        const currentId = await currentAccountId();
        const stored = await storedFor(currentId, sessionId);
        if (stored && Date.parse(stored.expiresAt) > Date.now()) {
          return redactPrivateSession(stored, currentId);
        }
        if (stored) await removeStored(currentId, sessionId);
        return fetchSession(currentId, sessionId);
      });
    }

    async function confirm(raw) {
      const value = descriptors(raw, new Set(['sessionId', 'pageFact', 'samples']), () =>
        failure('CATEGORY_STRATEGY_SAMPLING_REQUEST_INVALID'));
      const sessionId = id(value.sessionId);
      return serializeMutation(async () => {
        const currentId = await currentAccountId();
        const stored = await storedFor(currentId, sessionId);
        if (!stored) throw failure('CATEGORY_STRATEGY_SAMPLING_SESSION_INVALID');
        const pageFact = projectCapturedPageFact(value.pageFact);
        const samples = arrayValues(value.samples, 5, 20).map(projectCapturedProductFact);
        const result = await options.request({ method: 'POST',
          path: `/extension/auto-listing/category-strategy/sampling-sessions/${encodeURIComponent(sessionId)}/confirm`,
          headers,
          body: freeze({ sessionId, pageFact, samples: freeze(samples),
            idempotencyKey: `category-confirm-${sessionId}`,
            correlationId: `category-sampling-${sessionId}` }),
        });
        await removeStored(currentId, sessionId);
        return result;
      });
    }

    async function listFacts(raw) {
      const value = descriptors(raw, new Set(['sessionId']), () =>
        failure('CATEGORY_STRATEGY_SAMPLING_REQUEST_INVALID'));
      return serializeMutation(async () => {
        const currentId = await currentAccountId();
        const stored = await storedFor(currentId, id(value.sessionId));
        return stored ? freeze([...stored.selectedFacts]) : freeze([]);
      });
    }

    async function rememberFact(raw) {
      const value = descriptors(raw, new Set(['sessionId', 'fact']), () =>
        failure('CATEGORY_STRATEGY_SAMPLING_REQUEST_INVALID'));
      return serializeMutation(async () => {
        const currentId = await currentAccountId();
        const stored = await storedFor(currentId, id(value.sessionId));
        if (!stored) throw failure('CATEGORY_STRATEGY_SAMPLING_SESSION_INVALID');
        const fact = projectCapturedProductFact(value.fact);
        if (!sameScope(fact.pageScope, stored.scope) || !sameScope(fact.productScope, stored.scope)) {
          throw failure('CATEGORY_STRATEGY_SAMPLING_CARD_SCOPE_MISMATCH');
        }
        const selected = new Map(stored.selectedFacts.map((entry) => [entry.sku, entry]));
        if (!selected.has(fact.sku) && selected.size >= 20) {
          throw failure('CATEGORY_STRATEGY_SAMPLING_COUNT_INVALID');
        }
        selected.set(fact.sku, fact);
        const facts = freeze([...selected.values()]);
        await options.storageSession.set({ [storageKey(currentId, stored.sessionId)]: freeze({ ...stored,
          selectedFacts: facts }) });
        await registerSession(currentId, stored.sessionId);
        return facts;
      });
    }

    async function removeFact(raw) {
      const value = descriptors(raw, new Set(['sessionId', 'sku']), () =>
        failure('CATEGORY_STRATEGY_SAMPLING_REQUEST_INVALID'));
      return serializeMutation(async () => {
        const currentId = await currentAccountId();
        const stored = await storedFor(currentId, id(value.sessionId));
        if (!stored || typeof value.sku !== 'string'
          || !SKU.test(value.sku)) throw failure('CATEGORY_STRATEGY_SAMPLING_SESSION_INVALID');
        const facts = freeze(stored.selectedFacts.filter((fact) => fact.sku !== value.sku));
        await options.storageSession.set({ [storageKey(currentId, stored.sessionId)]: freeze({ ...stored,
          selectedFacts: facts }) });
        await registerSession(currentId, stored.sessionId);
        return facts;
      });
    }

    async function cancel(raw) {
      const value = descriptors(raw, new Set(['sessionId']), () =>
        failure('CATEGORY_STRATEGY_SAMPLING_REQUEST_INVALID'));
      const sessionId = id(value.sessionId);
      return serializeMutation(async () => {
        const currentId = await currentAccountId();
        const stored = await storedFor(currentId, sessionId);
        if (!stored) return freeze({ cancelled: false });
        try {
          return await options.request({ method: 'POST',
            path: `/extension/auto-listing/category-strategy/sampling-sessions/${encodeURIComponent(sessionId)}/cancel`,
            headers, body: freeze({ sessionId }) });
        } finally {
          await removeStored(currentId, sessionId);
        }
      });
    }

    return Object.freeze({ ready, start, getSession, listFacts, rememberFact, removeFact, confirm, cancel });
  }

  function directData(raw) {
    if (!raw || typeof raw !== 'object') return null;
    try {
      const descriptors = Object.getOwnPropertyDescriptors(raw);
      const output = Object.create(null);
      for (const key of Reflect.ownKeys(descriptors)) {
        const descriptor = descriptors[key];
        if (typeof key !== 'string' || !descriptor?.enumerable
          || !Object.hasOwn(descriptor, 'value')) return null;
        output[key] = descriptor.value;
      }
      return output;
    } catch { return null; }
  }

  function capturedInteger(value) {
    if (Number.isSafeInteger(value) && value > 0) return value;
    if (typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value)) return Number(value);
    return null;
  }

  function capturedArray(raw) {
    try {
      if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) return null;
      const all = Object.getOwnPropertyDescriptors(raw);
      if (all.length?.value !== raw.length
        || Reflect.ownKeys(all).length !== raw.length + 1) return null;
      return Array.from({ length: raw.length }, (_, index) => {
        const descriptor = all[String(index)];
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalidFacts();
        return descriptor.value;
      });
    } catch { return null; }
  }

  function extractOzonCapturedFacts(raw) {
    const input = descriptors(raw, new Set([
      'payload', 'expectedSku', 'expectedBuyerCategoryId', 'responseHash',
    ]), invalidFacts);
    if (input.expectedSku !== null && (typeof input.expectedSku !== 'string'
      || !SKU.test(input.expectedSku))) throw invalidFacts();
    const expectedBuyerCategoryId = input.expectedBuyerCategoryId == null
      ? null : capturedInteger(input.expectedBuyerCategoryId);
    if (input.expectedBuyerCategoryId != null && !expectedBuyerCategoryId) throw invalidFacts();
    if (typeof input.responseHash !== 'string' || !HASH.test(input.responseHash)) throw invalidFacts();
    const pending = [input.payload];
    const seen = new Set();
    const candidates = [];
    const buyerCategoryIds = new Set();
    const productImages = [];
    const productImageSet = new Set();
    const captureImage = (rawUrl) => {
      try {
        if (typeof rawUrl !== 'string') return;
        const url = sourceUrl(rawUrl);
        if (!productImageSet.has(url) && productImages.length < 6) {
          productImageSet.add(url);
          productImages.push(url);
        }
      } catch { /* skip unsafe image */ }
    };
    let budget = 5000;
    while (pending.length && budget > 0) {
      budget -= 1;
      const current = pending.pop();
      if (typeof current === 'string' && current.length <= 2_000_000
        && /^[\s]*[\[{]/.test(current)) {
        try { pending.push(JSON.parse(current)); } catch { /* non-JSON widget state */ }
        continue;
      }
      if (!current || typeof current !== 'object' || seen.has(current)) continue;
      seen.add(current);
      if (Array.isArray(current)) {
        const values = capturedArray(current);
        if (!values) continue;
        for (const value of values) pending.push(value);
        continue;
      }
      const value = directData(current);
      if (!value) continue;
      const descriptionCategoryId = capturedInteger(
        value.descriptionCategoryId ?? value.description_category_id);
      const typeId = capturedInteger(value.typeId ?? value.type_id);
      const candidateSku = String(value.sku ?? value.productId ?? value.product_id ?? '');
      const exactProduct = input.expectedSku !== null && candidateSku === input.expectedSku;
      if (exactProduct) {
        const buyerCategoryId = capturedInteger(value.categoryId ?? value.category_id);
        if (buyerCategoryId) buyerCategoryIds.add(buyerCategoryId);
        for (const rawUrl of [
          value.image, value.imageUrl, value.imageURL, value.coverImage, value.coverImageUrl,
        ]) captureImage(rawUrl);
      }
      if (descriptionCategoryId && typeId
        && (input.expectedSku === null || candidateSku === input.expectedSku)) {
        const imageValue = value.images ?? value.imageUrls ?? value.image_urls;
        const imageItems = capturedArray(imageValue);
        const images = [];
        if (imageItems) {
          for (let index = 0; index < Math.min(imageValue.length, 6); index += 1) {
            const item = imageItems[index];
            const itemValue = typeof item === 'string' ? { url: item } : directData(item);
            const url = itemValue && (itemValue.url ?? itemValue.src ?? itemValue.imageUrl);
            try {
              if (typeof url === 'string') {
                const projected = sourceUrl(url);
                images.push(projected);
                if (exactProduct) captureImage(projected);
              }
            } catch { /* skip unsafe */ }
          }
        }
        candidates.push({ descriptionCategoryId, typeId, images });
      }
      for (const child of Object.values(value)) pending.push(child);
    }
    const scopes = new Map();
    for (const candidate of candidates) {
      const key = `${candidate.descriptionCategoryId}:${candidate.typeId}`;
      if (!scopes.has(key) || candidate.images.length > scopes.get(key).images.length) {
        scopes.set(key, candidate);
      }
    }
    if (scopes.size > 1 || buyerCategoryIds.size > 1) {
      throw failure('CATEGORY_STRATEGY_SAMPLING_FACTS_AMBIGUOUS');
    }
    const candidate = [...scopes.values()][0] || null;
    const buyerCategoryId = [...buyerCategoryIds][0] || null;
    if (expectedBuyerCategoryId !== null && buyerCategoryId !== null
      && buyerCategoryId !== expectedBuyerCategoryId) {
      throw failure('CATEGORY_STRATEGY_SAMPLING_CARD_SCOPE_MISMATCH');
    }
    if (!candidate && (expectedBuyerCategoryId === null
      || buyerCategoryId !== expectedBuyerCategoryId)) throw invalidFacts();
    const images = productImages.length ? productImages : (candidate?.images || []);
    if (!images.length) throw invalidFacts();
    return freeze({ scope: candidate ? projectExactScope({ taxonomyScope: 'OZON:DEFAULT',
      descriptionCategoryId: candidate.descriptionCategoryId, typeId: candidate.typeId }) : null,
    buyerCategoryId, images: freeze(images) });
  }

  return Object.freeze({
    MODE,
    SESSION_STORAGE_KEY,
    createCategoryStrategySamplingBackgroundClient,
    createCategoryStrategySamplingController,
    extractOzonCapturedFacts,
    projectCapturedPageFact,
    projectCapturedPageFactFromSession,
    projectCapturedProductFact,
    projectExactScope,
    projectSamplingSession,
  });
});
