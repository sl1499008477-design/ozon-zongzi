import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readdir} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import test, {mock} from 'node:test';
import {createAccountRecord, verifyPassword} from '../account-context.mjs';

// Mock only the PostgreSQL transport. The routes, state loader, mirror, password
// hashing, authorization, and account-scoped response builder remain real.
if (typeof mock.module !== 'function') {
  test('account-state loading regression', () => {
    const env = {...process.env, QH_LOCAL_NO_LISTEN: '1', QH_LOCAL_NO_DOTENV: '1'};
    // A nested runner must not inherit the parent's private test-worker protocol.
    delete env.NODE_TEST_CONTEXT;
    execFileSync(process.execPath, ['--experimental-test-module-mocks', '--test', fileURLToPath(import.meta.url)], {
      encoding: 'utf8', env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });
} else {
  process.env.QH_LOCAL_NO_LISTEN = '1';
  process.env.QH_LOCAL_NO_DOTENV = '1';
  process.env.NODE_ENV = 'test';
  process.env.SONLI_ADMIN_PASSWORD = 'synthetic-bootstrap-password';
  process.env.LISTING_PIPELINE_V3 = '1';
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_HOST;

  const migrationVersions = (await readdir(new URL('../db/migrations/', import.meta.url)))
    .filter(name => name.endsWith('.sql')).map(name => ({version: name.slice(0, -4)}));
  const admin = {...createAccountRecord({username: 'admin', password: 'old-password', role: 'admin'}), id: 'account-a'};
  const user = {...createAccountRecord({username: 'user', password: 'user-password'}), id: 'account-b'};
  const currentProducts = ['a', 'b'].map(id => ({
    id: `product-${id}`, store_id: `store-${id}`, name: `current product ${id}`, raw: {},
  }));
  const currentWarehouses = ['a', 'b'].map(id => ({
    id: `warehouse-${id}`, store_id: `store-${id}`, name: `current warehouse ${id}`, raw: {},
  }));
  const currentCollect = ['a', 'b'].map(id => ({
    id: `collect-${id}`, account_id: `account-${id}`, source: 'ozon',
    source_sku: id === 'a' ? '10000001' : '10000002', status: 'COLLECTED',
    raw_payload: {normalized: {name: `current collect ${id}`}}, draft_data: {}, draft_version: 1,
  }));
  const fixture = () => ({
    accounts: [structuredClone(admin), structuredClone(user)],
    stores: [{id: 'store-a', ownerAccountId: admin.id}, {id: 'store-b', ownerAccountId: user.id}],
    currentAccountId: admin.id, currentStoreId: 'store-a',
    currentStoreIdsByAccount: {[admin.id]: 'store-a', [user.id]: 'store-b'},
    token: 'admin-one', sessionIssuedAt: '2026-09-17T00:00:00.000Z',
    sessions: {
      'admin-one': {accountId: admin.id}, 'admin-two': {accountId: admin.id},
      'user-one': {accountId: user.id},
    },
    caches: {
      products: [{id: 'old-product-a', storeId: 'store-a', name: 'compatibility snapshot'}],
      warehouses: [{id: 'old-warehouse-a', storeId: 'store-a'}], collectBox: [],
      postings: [{id: 'historic-order', storeId: 'store-b'}], files: [],
      announcements: [], favorites: [], messageHistory: [], messageTemplates: [],
      productTemplates: [], promotions: [], refunds: [], returns: [],
    },
    jobs: {}, reports: [], auditEvents: [], collectorAuthTickets: [], collectorSessions: [],
  });
  let stored, version, queries, transaction, rejectNextSave;
  const reset = () => {stored = fixture(); version = 7; queries = []; transaction = null; rejectNextSave = false;};
  reset();
  const pool = {
    async connect() {return {...this, release() {}};},
    async query(sql, values = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      queries.push({text, values});
      if (text === 'SELECT version FROM schema_migrations') return {rows: migrationVersions};
      if (text.includes('pg_advisory_unlock')) return {rows: [{unlocked: true}]};
      if (text.startsWith('SELECT state, version FROM local_state')) return {rows: [{state: structuredClone(stored), version}]};
      if (text.startsWith('SELECT EXISTS(SELECT 1 FROM accounts')) return {rows: [{populated: true}]};
      if (text.includes('FROM sessions s') && text.includes('JOIN accounts a')) {
        const session = stored.sessions[values[0]];
        const account = stored.accounts.find(row => row.id === session?.accountId);
        return {rows: account ? [{...account, display_name: account.displayName, expires_at: account.expiresAt}] : []};
      }
      if (text.startsWith('WITH snapshot AS MATERIALIZED')) {
        const accountId = values[1];
        return {rows: [{state: {
          accounts: stored.accounts.filter(a => a.id === accountId),
          stores: stored.stores.filter(s => s.ownerAccountId === accountId),
          currentAccountId: accountId,
          currentStoreIdsByAccount: {[accountId]: stored.currentStoreIdsByAccount[accountId]},
          caches: {files: [], favorites: [], productTemplates: [], announcements: []}, jobs: {}, reports: [],
        }}]};
      }
      if (text.startsWith('SELECT p.* FROM products')) {
        assert.ok(text.includes('s.owner_account_id=$1 AND p.store_id=$2'));
        return {rows: currentProducts.filter(row => row.store_id === values[1])};
      }
      if (text.includes('FROM products') && text.includes('ORDER BY store_id')) return {rows: currentProducts};
      if (text.includes('FROM warehouses') && text.includes('ORDER BY store_id')) return {rows: currentWarehouses};
      if (text.includes('FROM collect_items c') && text.startsWith('SELECT c.*')) {
        assert.ok(text.includes('c.account_id=$1'));
        return {rows: currentCollect.filter(row => row.account_id === values[0])};
      }
      if (text.includes('COUNT(*)::int FROM products')) return {rows: [{products: 1, collect_box: 1}]};
      if (text === 'BEGIN') transaction = {stored: structuredClone(stored), version};
      if (text === 'ROLLBACK' && transaction) {stored = transaction.stored; version = transaction.version; transaction = null;}
      if (text === 'COMMIT') transaction = null;
      if (text.startsWith('UPDATE local_state SET state =')) {
        if (rejectNextSave) {rejectNextSave = false; return {rows: [], rowCount: 0};}
        stored = JSON.parse(values[0]); version += 1;
        return {rows: [{version}], rowCount: 1};
      }
      return {rows: [], rowCount: 1};
    },
  };
  mock.module('../db/connection.mjs', {namedExports: {
    postgresEnabled: () => true, getPostgresPool: async () => pool,
    closePostgresPool: async () => {}, postgresConfig: () => ({}), postgresSslConfig: () => false,
  }});
  const {handle} = await import('../index.mjs');
  const {loadPersistedState, savePersistedState} = await import('../persistence.mjs');

  async function request(method, pathname, body = null, token = 'admin-one') {
    const req = Readable.from(body === null ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, {method, url: pathname, headers: {'content-type': 'application/json', authorization: `Bearer ${token}`}});
    const res = {status: 0, body: '', writeHead(status) {this.status = status;}, end(body = '') {this.body = String(body);}};
    try {await handle(req, res);} catch (error) {return {status: error.status || 500, body: {code: error.code}};}
    return {status: res.status, body: JSON.parse(res.body || '{}')};
  }
  const globalCatalogReads = () => queries.filter(({text}) => (
    /^SELECT .* FROM (products|warehouses) ORDER BY /s.test(text)
    || text === 'SELECT account_id,id FROM collect_items'
    || (/FROM submission_jobs j/.test(text) && !text.includes('j.account_id='))
  ));
  const catalogWrites = () => queries.filter(({text}) => /^(INSERT INTO|UPDATE|DELETE FROM) (products|warehouses|orders)\b/.test(text));
  const fullProductLoads = () => globalCatalogReads().filter(({text}) => text.includes('FROM products'));
  const fullWarehouseLoads = () => globalCatalogReads().filter(({text}) => text.includes('FROM warehouses'));
  const jsonResponse = payload => ({ok: true, status: 200, text: async () => JSON.stringify(payload)});

  test.beforeEach(reset);

  test('an unhydrated account save preserves historical JSON and never rewrites the relational catalog', async () => {
    stored.caches.products.push({id: 'unscoped-legacy-product'});
    const before = structuredClone(stored.caches);
    const state = await loadPersistedState({dataFile: '/unused.json', hydrateCatalog: false});
    state.accounts[0].displayName = 'renamed';
    await savePersistedState({state});
    assert.deepEqual(stored.caches, before);
    assert.equal(stored.accounts[0].displayName, 'renamed');
    assert.equal(globalCatalogReads().length, 0);
    assert.equal(catalogWrites().length, 0);
    assert.equal(queries.some(({text}) => text.includes('FROM collect_items c')), false);
    assert.ok(queries.some(({text}) => text.startsWith('INSERT INTO accounts')));
    // Saving captures a fresh baseline; that capture and the persistence clone
    // must preserve the fact that this request never loaded the catalog.
    state.currentAccountId = user.id;
    state.currentStoreId = 'store-b';
    await savePersistedState({state});
    assert.deepEqual(stored.caches, before);
    assert.equal(catalogWrites().length, 0);
  });

  test('the default loader still hydrates product and warehouse data for existing business routes', async () => {
    await loadPersistedState({dataFile: '/unused.json'});
    assert.equal(globalCatalogReads().length, 2);
  });

  test('password update keeps catalog unloaded, revokes all target sessions, and retains unrelated sessions', async () => {
    const before = structuredClone(stored.caches);
    const changed = await request('PATCH', `/local/accounts/${admin.id}`, {password: 'new-password'});
    assert.equal(changed.status, 200);
    assert.equal(verifyPassword('old-password', stored.accounts[0]), false);
    assert.equal(verifyPassword('new-password', stored.accounts[0]), true);
    assert.deepEqual(Object.keys(stored.sessions), ['user-one']);
    assert.deepEqual(stored.caches, before);
    assert.equal(globalCatalogReads().length, 0);
    assert.equal(catalogWrites().length, 0);
    assert.ok(stored.auditEvents.some(event => event.action === 'ACCOUNT_UPDATED' && event.metadata.passwordChanged));
    assert.ok(queries.some(({text, values}) => text.startsWith('UPDATE sessions SET revoked_at=') && values[0] === admin.id));
    assert.ok(queries.some(({text, values}) => text.startsWith('UPDATE collector_sessions SET revoked_at=') && values[0] === admin.id));
    assert.equal((await request('GET', '/local/accounts', null, 'admin-two')).status, 401);
    assert.equal((await request('POST', '/local/accounts/login', {username: 'admin', password: 'old-password'}, '')).status, 401);
    const login = await request('POST', '/local/accounts/login', {username: 'admin', password: 'new-password'}, '');
    assert.equal(login.status, 200);
    assert.equal(login.body.account.id, admin.id);
    assert.ok(stored.sessions[login.body.token]);
    assert.equal(globalCatalogReads().length, 0);
  });

  test('same-page login returns current owned products and collect details for the existing Web response contract', async () => {
    const login = await request('POST', '/local/accounts/login', {username: 'user', password: 'user-password'}, '');
    assert.equal(login.status, 200);
    assert.equal(login.body.account.id, user.id);
    assert.equal(login.body.state.account.id, user.id);
    assert.equal(login.body.state.token, login.body.token);
    assert.deepEqual(login.body.state.accounts, []);
    assert.deepEqual(login.body.state.stores.map(store => store.id), ['store-b']);
    assert.deepEqual(login.body.state.caches.products.map(item => item.id), ['product-b']);
    assert.deepEqual(login.body.state.caches.collectBox.map(item => item.id), ['collect-b']);
    assert.equal(login.body.state.summary.products, 1);
    assert.equal(login.body.state.summary.collectBox, 1);
    const collectReads = queries.filter(({text}) => text.startsWith('SELECT c.*') && text.includes('FROM collect_items c'));
    assert.ok(collectReads.length > 0);
    assert.ok(collectReads.every(({values}) => values[0] === user.id));
    assert.equal(globalCatalogReads().length, 0);
  });

  test('bootstrap login preserves identity and summaries without loading page catalogs', async () => {
    const login = await request('POST', '/local/accounts/login?view=bootstrap', {username: 'user', password: 'user-password'}, '');
    assert.equal(login.status, 200);
    assert.equal(login.body.account.id, user.id);
    assert.equal(login.body.state.account.id, user.id);
    assert.equal(login.body.state.token, login.body.token);
    assert.deepEqual(login.body.state.accounts, []);
    assert.deepEqual(login.body.state.stores.map(store => store.id), ['store-b']);
    assert.deepEqual(login.body.state.caches.products, []);
    assert.deepEqual(login.body.state.caches.collectBox, []);
    assert.equal(login.body.state.summary.products, 1);
    assert.equal(login.body.state.summary.collectBox, 1);
    assert.equal(queries.some(({text}) => text.startsWith('SELECT p.* FROM products')), false);
    assert.equal(queries.some(({text}) => text.startsWith('SELECT c.*') && text.includes('FROM collect_items c')), false);
    assert.equal(queries.some(({text}) => text.includes('FROM submission_jobs j')), false);
    assert.ok(stored.sessions[login.body.token]);
    assert.ok(stored.auditEvents.some(event => event.action === 'ACCOUNT_LOGIN' && event.accountId === user.id));
  });

  test('store selection persists metadata without hydrating or rewriting the catalog', async () => {
    const before = structuredClone(stored.caches);
    const switched = await request('POST', '/local/current-store', {storeId: 'store-a'});
    assert.equal(switched.status, 200);
    assert.equal(switched.body.store.id, 'store-a');
    assert.equal(stored.currentStoreIdsByAccount[admin.id], 'store-a');
    assert.deepEqual(stored.caches, before);
    assert.equal(globalCatalogReads().length, 0);
    assert.equal(catalogWrites().length, 0);
  });

  test('metadata routes and an unknown route never hydrate the catalog', async () => {
    const stores = await request('GET', '/auth/ozon-stores');
    assert.equal(stores.status, 200);
    assert.deepEqual(stores.body.map(store => store.id), ['store-a']);

    const membership = await request('GET', '/membership/usage-summary');
    assert.equal(membership.status, 200);
    assert.equal(membership.body.plan, 'free');

    const templates = await request('GET', '/ozon/templates?pageSize=100');
    assert.equal(templates.status, 200);
    assert.deepEqual(templates.body.data, []);

    const missing = await request('GET', '/definitely-not-a-live-route');
    assert.equal(missing.status, 404);
    assert.equal(globalCatalogReads().length, 0);
  });

  test('store selection cannot cross account ownership without hydrating the catalog', async () => {
    const denied = await request('POST', '/local/current-store', {storeId: 'store-b'});
    assert.equal(denied.status, 404);
    assert.equal(stored.currentStoreIdsByAccount[admin.id], 'store-a');
    assert.equal(globalCatalogReads().length, 0);
  });

  test('profile refresh keeps its response reload metadata-only', async () => {
    const before = structuredClone(stored.caches);
    const refreshed = await request('POST', '/local/stores/refresh-profile', {});
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.state.account.id, admin.id);
    assert.deepEqual(stored.caches, before);
    assert.equal(globalCatalogReads().length, 0);
    assert.equal(catalogWrites().length, 0);
  });

  test('template writes preserve the formal catalog without hydrating it', async () => {
    const catalogBefore = structuredClone({
      products: stored.caches.products,
      warehouses: stored.caches.warehouses,
    });
    const created = await request('POST', '/ozon/templates', {
      templateName: 'Account A template',
      templateSettings: {stock: 3},
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.item.accountId, admin.id);
    assert.equal(stored.caches.productTemplates.length, 1);
    assert.deepEqual({
      products: stored.caches.products,
      warehouses: stored.caches.warehouses,
    }, catalogBefore);
    assert.equal(globalCatalogReads().length, 0);
    assert.equal(catalogWrites().length, 0);
  });

  test('a legacy product-data read still hydrates the current formal catalog', async () => {
    const product = await request('GET', '/ozon/product-data/product-a?storeId=store-a');
    assert.equal(product.status, 200);
    assert.equal(product.body.data.id, 'product-a');
    assert.ok(globalCatalogReads().length > 0);
  });

  for (const capability of [
    {name: 'product batch', method: 'POST', path: '/ozon/product-data/batch', body: {storeId: 'store-a', skus: ['product-a']}, minLoads: 1},
    {name: 'warehouse read', method: 'GET', path: '/ozon/warehouses', body: null, minLoads: 1},
    // The V3 delete handler owns its account-scoped PG mutation before the
    // compatibility boundary; the allowlist remains the JSON/V3-off fallback.
    {name: 'collect delete', method: 'DELETE', path: '/ozon/collect-box/batch', body: {ids: ['collect-a']}, minLoads: 0, maxLoads: 0},
    {name: 'collect listing', method: 'POST', path: '/ozon/collect-box/collect-a/listing/preview', body: {targetStoreId:'store-a'}, minLoads: 0, maxLoads: 0,
      assertScopedRead: true},
    {name: 'AI collect draft', method: 'POST', path: '/ozon/collect-box/collect-a/ai-listing-draft', body: {title: 'draft'}, minLoads: 1},
  ]) {
    test(`${capability.name} capability reaches its real handler with a hydrated formal catalog`, async () => {
      const response = await request(capability.method, capability.path, capability.body);
      assert.notEqual(response.status, 404);
      assert.ok(fullProductLoads().length >= capability.minLoads);
      assert.ok(fullWarehouseLoads().length >= capability.minLoads);
      if (capability.maxLoads !== undefined) {
        assert.ok(fullProductLoads().length <= capability.maxLoads);
        assert.ok(fullWarehouseLoads().length <= capability.maxLoads);
      }
      if (capability.assertScopedRead) {
        assert.ok(queries.some(({text, values}) => text.includes('FROM collect_items c')
          && text.includes('c.account_id=$1') && text.includes('c.id=ANY($2::text[])')
          && values[0] === admin.id && values[1]?.[0] === 'collect-a'));
      }
    });
  }

  test('collect listing routes keep item and target-store reads inside the authenticated account', async () => {
    const foreignItem = await request('POST', '/ozon/collect-box/collect-a/listing/preview',
      {targetStoreId:'store-b'}, 'user-one');
    assert.equal(foreignItem.status, 404);
    assert.equal(fullProductLoads().length, 0);
    assert.equal(fullWarehouseLoads().length, 0);
    assert.ok(queries.some(({text,values}) => text.includes('FROM collect_items c')
      && text.includes('c.id=ANY($2::text[])') && values[0] === user.id
      && values[1]?.[0] === 'collect-a'));

    queries = [];
    const foreignStore = await request('POST', '/ozon/collect-box/collect-b/listing/submit',
      {targetStoreId:'store-a',idempotencyKey:'foreign-store'}, 'user-one');
    assert.equal(foreignStore.status, 404);
    assert.equal(globalCatalogReads().length, 0);
    assert.equal(queries.some(({text}) => text.includes('FROM collect_items c')), false);
  });

  for (const type of ['PRODUCTS', 'WAREHOUSES']) {
    test(`${type} sync gives the formal catalog a single commit owner and preserves the other store`, async () => {
      Object.assign(stored.stores[0], {clientId: 'client-a', apiKey: 'key-a'});
      globalThis.fetch = async url => {
        const pathname = new URL(url).pathname;
        if (pathname === '/v1/seller/info') return jsonResponse({result: {company: {name: 'Store A'}}});
        if (pathname === '/v2/warehouse/list') {
          return jsonResponse({result: {warehouses: [{warehouse_id: 'warehouse-new-a', name: 'New A'}]}});
        }
        if (pathname === '/v2/analytics/stock_on_warehouses') return jsonResponse({result: {rows: []}});
        if (pathname === '/v3/product/list') return jsonResponse({result: {items: [], last_id: ''}});
        throw new Error(`unexpected Ozon test endpoint: ${pathname}`);
      };

      const synced = await request('POST', `/local/sync/${type}`, {
        storeId: 'store-a', jobId: `job-${type.toLowerCase()}`,
      });

      assert.equal(synced.status, 200);
      assert.equal(synced.body.job.status, 'SUCCESS');
      assert.equal(synced.body.state.account.id, admin.id);
      assert.equal(fullProductLoads().length, 0);
      assert.equal(fullWarehouseLoads().length, 0);
      const catalogDeletes = queries.filter(({text}) => /^DELETE FROM (products|warehouses)\b/.test(text));
      assert.ok(catalogDeletes.length > 0);
      assert.ok(catalogDeletes.every(({values}) => values[0] === 'store-a'));
      if (type === 'PRODUCTS') {
        assert.equal(stored.caches.products.some(item => item.storeId === 'store-a'), false);
        assert.equal(catalogDeletes.some(({text}) => /^DELETE FROM warehouses\b/.test(text)), false);
      } else {
        assert.deepEqual(
          stored.caches.warehouses.filter(item => item.storeId === 'store-a').map(item => item.id),
          ['warehouse-new-a'],
        );
        assert.equal(catalogDeletes.some(({text}) => /^DELETE FROM products\b/.test(text)), false);
      }
    });
  }

  test('sync rejects a store owned by another account before any catalog load', async () => {
    const denied = await request('POST', '/local/sync/WAREHOUSES', {storeId: 'store-a'}, 'user-one');
    assert.equal(denied.status, 400);
    assert.equal(denied.body.code, 'STORE_NOT_FOUND');
    assert.equal(globalCatalogReads().length, 0);
  });

  test('account list, creation, logout and recovery do not hydrate catalog data', async () => {
    assert.equal((await request('GET', '/local/accounts')).status, 200);
    assert.equal((await request('POST', '/local/accounts', {username: 'third', password: 'third-password'})).status, 200);
    stored.accounts.find(account => account.id === user.id).status = 'disabled';
    assert.equal((await request('PATCH', `/local/accounts/${user.id}`, {status: 'active'})).status, 200);
    assert.equal(stored.accounts.find(account => account.id === user.id).status, 'active');
    assert.equal(stored.sessions['user-one'], undefined);
    assert.equal((await request('POST', '/local/accounts/logout')).status, 200);
    assert.ok(stored.sessions['admin-two']);
    assert.equal(stored.sessions['admin-one'], undefined);
    assert.equal(globalCatalogReads().length, 0);
    assert.equal(catalogWrites().length, 0);
    assert.equal(queries.some(({text}) => text.includes('FROM collect_items c')), false);
  });

  test('logging into another account does not remap legacy cache rows without an explicit store id', async () => {
    stored.caches.products.push({id: 'legacy-product', name: 'retained historical snapshot'});
    stored.caches.warehouses.push({warehouse_id: 'legacy-warehouse'});
    const before = structuredClone(stored.caches);
    assert.equal((await request('POST', '/local/accounts/login', {username: 'user', password: 'user-password'}, '')).status, 200);
    assert.deepEqual(stored.caches, before);
    assert.equal(catalogWrites().length, 0);
  });

  test('invalid account edit and non-admin edit do not persist password or session changes', async () => {
    const before = structuredClone(stored);
    assert.equal((await request('PATCH', `/local/accounts/${admin.id}`, {password: 'new-password', status: 'disabled'})).status, 400);
    assert.deepEqual(stored, before);
    assert.equal((await request('PATCH', `/local/accounts/${admin.id}`, {password: 'new-password'}, 'user-one')).status, 403);
    assert.deepEqual(stored, before);
    assert.equal(queries.some(({text}) => text.startsWith('UPDATE local_state SET state =')), false);
  });

  test('failed optimistic save retains the previous password and sessions and does not revoke persisted sessions', async () => {
    const before = structuredClone(stored);
    rejectNextSave = true;
    const failed = await request('PATCH', `/local/accounts/${admin.id}`, {password: 'new-password'});
    assert.equal(failed.status, 409);
    assert.equal(failed.body.code, 'LOCAL_STATE_VERSION_CONFLICT');
    assert.deepEqual(stored, before);
    assert.equal(queries.some(({text}) => text.startsWith('UPDATE sessions SET revoked_at=')), false);
    assert.equal(queries.some(({text}) => text.startsWith('UPDATE collector_sessions SET revoked_at=')), false);
  });

  test('account deletion keeps its complete data-loading path', async () => {
    // Rejecting self-deletion avoids external cleanup while exercising the loader.
    assert.equal((await request('DELETE', `/local/accounts/${admin.id}`)).status, 400);
    assert.equal(globalCatalogReads().some(({text}) => text.includes('FROM products')), true);
    assert.equal(queries.some(({text}) => text.includes('FROM collect_items c')), true);
  });
}
