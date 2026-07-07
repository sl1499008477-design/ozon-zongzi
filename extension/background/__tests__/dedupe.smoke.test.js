'use strict';

/**
 * pushSourceCollect dedupe + retry · plain Node smoke test
 *
 * 参考实现:与 service-worker.js `case 'pushSourceCollect'` 保持同步
 * (plan v3 子项 ② — 改一处要改另一处)。
 *
 * 跑法:  node extension/background/__tests__/dedupe.smoke.test.js
 *
 * 覆盖 case:
 *   1. 同 SKU 1s 内连点 5 次,只 1 次真正发请求(dedupe 命中)
 *   2. forceResubmit:true 跳 dedupe,强制重新发
 *   3. HTTP fail 3 次后 cache 不写入(失败不缓存)
 *   4. 不同 backendHost 不互相干扰(切环境时)
 *   5. 4xx 业务错误立即返回,不重试(401/403/422)
 *   6. 5xx / network error 指数退避 3 次后才放弃
 *   7. 并发 5 次只 1 次 fetch(in-flight pendingCollects 合并)
 *   8. 缺 sku 时跳过 dedupe,仍能 fetch,不写 cache
 *   9. forceResubmit 不污染普通 pending 槽位
 *       (普通 A pending + force B 并发,后到普通 C 应 await A 而非 B)
 */

const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RETRIES = 3;

// ── mock chrome.storage.local ─────────────────────────────────────
function makeStorage() {
  const data = {};
  return {
    data,
    get: (keys, cb) => {
      const result = {};
      const list = Array.isArray(keys) ? keys : [keys];
      list.forEach((k) => { if (k in data) result[k] = data[k]; });
      cb(result);
    },
    set: (kv, cb) => {
      Object.assign(data, kv);
      if (cb) cb();
    },
    remove: (keys, cb) => {
      const list = Array.isArray(keys) ? keys : [keys];
      list.forEach((k) => delete data[k]);
      if (cb) cb();
    },
  };
}

// ── 参考实现(与 service-worker.js pushSourceCollect handler 同步)─────
// pendingCollects 在 ctx 里共享(模拟 SW 模块级 Map),让多个并发 ref 调用合并
// 2025-05 ENVELOPE_FIX:dedupeHit / lastAt / result 全塞进 data,适配 sendMessage
// wrapper 的 resolve(response.data) — 否则 envelope 字段在跨 chrome.runtime 边界丢
async function pushSourceCollectRef({ sourceId, raw, forceResubmit }, ctx) {
  const { backendUrl, storeId, token, storage, apiRequest, now, pendingCollects } = ctx;
  if (!sourceId) return { ok: false, error: 'sourceId required' };

  const sku = String(raw?.sku || '').trim();
  let cacheKey = null;
  if (sku && backendUrl) {
    try {
      const host = new URL(backendUrl).host;
      cacheKey = `jz-collect-recent-v1:${host}:${encodeURIComponent(storeId || 'no-store')}:${encodeURIComponent(sourceId)}:${encodeURIComponent(sku)}`;
      if (!forceResubmit) {
        const cached = await new Promise((r) => storage.get([cacheKey], (d) => r(d[cacheKey])));
        if (cached && now() - (cached.at || 0) < DEDUPE_TTL_MS) {
          return { ok: true, data: { dedupeHit: true, lastAt: cached.at, result: null } };
        }
      }
    } catch {
      cacheKey = null;
    }
  }

  // in-flight 合并
  if (cacheKey && !forceResubmit && pendingCollects && pendingCollects.has(cacheKey)) {
    try {
      const resp = await pendingCollects.get(cacheKey);
      return resp?.ok
        ? { ok: true, data: { ...resp.data, dedupeHit: true } }
        : resp;
    } catch (e) {
      return { ok: false, error: e?.message || 'pending request failed' };
    }
  }

  const collectPromise = (async () => {
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const data = await apiRequest(
          'POST',
          `${backendUrl}/sources/${encodeURIComponent(sourceId)}/collect`,
          { raw: raw || {} },
          token,
          storeId,
        );
        if (cacheKey) {
          await new Promise((r) => storage.set({ [cacheKey]: { at: now() } }, r));
        }
        return { ok: true, data: { dedupeHit: false, lastAt: null, result: data } };
      } catch (error) {
        lastErr = error;
        const status = error?.status;
        if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) {
          return { ok: false, error: error.message, status };
        }
        // 测试不真等 setTimeout,backoff 跳过(测语义不测时序)
      }
    }
    return { ok: false, error: lastErr?.message || 'NETWORK_ERROR' };
  })();

  // forceResubmit 不写 pendingCollects(同步于 SW 实现)
  if (cacheKey && !forceResubmit && pendingCollects) {
    pendingCollects.set(cacheKey, collectPromise);
  }
  try {
    return await collectPromise;
  } finally {
    if (cacheKey && !forceResubmit && pendingCollects) pendingCollects.delete(cacheKey);
  }
}

// ── 测试 helpers ───────────────────────────────────────────────────
let testNum = 0;
let passed = 0;
let failed = 0;
function test(name, fn) {
  testNum++;
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((e) => { failed++; console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); });
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// ── cases ─────────────────────────────────────────────────────────
async function run() {
  console.log('\n=== dedupe.smoke.test.js ===\n');

  // Case 1: 同 SKU 1s 内连点 5 次,只 1 次真正发请求
  await test('case 1: 1 秒内同 SKU 5 次只 1 次 fetch', async () => {
    const storage = makeStorage();
    let fetchCount = 0;
    const apiRequest = async () => { fetchCount++; return { id: 'abc' }; };
    const t0 = 1000;
    let now = t0;
    const ctx = { backendUrl: 'https://api.example.com', storeId: 's1', token: 't', storage, apiRequest, now: () => now, pendingCollects: new Map() };

    for (let i = 0; i < 5; i++) {
      now = t0 + i * 100; // 1s 内 5 次
      const resp = await pushSourceCollectRef({ sourceId: 'ozon', raw: { sku: '123' } }, ctx);
      assert(resp.ok, `iteration ${i} should ok`);
      if (i === 0) assert(!resp.data?.dedupeHit, 'first call must miss cache');
      else assert(resp.data?.dedupeHit, `iteration ${i} should hit cache`);
    }
    assert(fetchCount === 1, `expected 1 fetch, got ${fetchCount}`);
  });

  // Case 2: forceResubmit 跳 cache
  await test('case 2: forceResubmit 跳 cache 强制重发', async () => {
    const storage = makeStorage();
    let fetchCount = 0;
    const apiRequest = async () => { fetchCount++; return { id: 'abc' }; };
    const ctx = { backendUrl: 'https://api.example.com', storeId: 's1', token: 't', storage, apiRequest, now: () => 1000, pendingCollects: new Map() };

    await pushSourceCollectRef({ sourceId: 'ozon', raw: { sku: '123' } }, ctx);
    await pushSourceCollectRef({ sourceId: 'ozon', raw: { sku: '123' }, forceResubmit: true }, ctx);
    assert(fetchCount === 2, `expected 2 fetches, got ${fetchCount}`);
  });

  // Case 3: HTTP fail 3 次后 cache 不写入
  await test('case 3: 3 次 5xx 失败后 cache 不写入', async () => {
    const storage = makeStorage();
    let fetchCount = 0;
    const apiRequest = async () => {
      fetchCount++;
      const err = new Error('Internal Server Error');
      err.status = 500;
      throw err;
    };
    const ctx = { backendUrl: 'https://api.example.com', storeId: 's1', token: 't', storage, apiRequest, now: () => 1000, pendingCollects: new Map() };

    const resp = await pushSourceCollectRef({ sourceId: 'ozon', raw: { sku: '999' } }, ctx);
    assert(!resp.ok, 'should fail after retries');
    assert(fetchCount === 3, `expected 3 fetch attempts, got ${fetchCount}`);
    const cached = Object.keys(storage.data).filter((k) => k.startsWith('jz-collect-recent-v1:'));
    assert(cached.length === 0, `cache should be empty, got ${cached.length} keys`);
  });

  // Case 4: 不同 backendHost 不互相干扰
  await test('case 4: 不同 backendHost 各自隔离', async () => {
    const storage = makeStorage();
    let fetchCount = 0;
    const apiRequest = async () => { fetchCount++; return { id: 'abc' }; };

    const pendingCollects = new Map();
    const ctxA = { backendUrl: 'https://api.prod.com', storeId: 's1', token: 't', storage, apiRequest, now: () => 1000, pendingCollects };
    const ctxB = { backendUrl: 'http://localhost:3001', storeId: 's1', token: 't', storage, apiRequest, now: () => 1001, pendingCollects };

    await pushSourceCollectRef({ sourceId: 'ozon', raw: { sku: '111' } }, ctxA);
    await pushSourceCollectRef({ sourceId: 'ozon', raw: { sku: '111' } }, ctxB);
    assert(fetchCount === 2, `cross-host should not dedupe, got ${fetchCount} fetches`);

    // 同 host 再来一次应命中 cache
    const respA2 = await pushSourceCollectRef({ sourceId: 'ozon', raw: { sku: '111' } }, ctxA);
    assert(respA2.data?.dedupeHit, 'same host second call should hit cache');
    assert(fetchCount === 2, `dedupe should kick in, got ${fetchCount}`);
  });

  // Case 5: 4xx 业务错误立即返回不重试
  await test('case 5: 401/403/422 立即失败不重试', async () => {
    for (const status of [401, 403, 422]) {
      const storage = makeStorage();
      let fetchCount = 0;
      const apiRequest = async () => {
        fetchCount++;
        const err = new Error(`[${status}] business error`);
        err.status = status;
        throw err;
      };
      const ctx = { backendUrl: 'https://api.example.com', storeId: 's1', token: 't', storage, apiRequest, now: () => 1000, pendingCollects: new Map() };

      const resp = await pushSourceCollectRef({ sourceId: 'ozon', raw: { sku: '777' } }, ctx);
      assert(!resp.ok, `status ${status} should fail`);
      assert(resp.status === status, `status should be ${status}`);
      assert(fetchCount === 1, `4xx should not retry, got ${fetchCount} attempts (status=${status})`);
    }
  });

  // Case 6: 408/429 / 5xx / network error 才重试
  await test('case 6: 408/429/5xx 走重试到 3 次', async () => {
    for (const status of [408, 429, 502, 503, 504]) {
      const storage = makeStorage();
      let fetchCount = 0;
      const apiRequest = async () => {
        fetchCount++;
        const err = new Error('temp');
        err.status = status;
        throw err;
      };
      const ctx = { backendUrl: 'https://api.example.com', storeId: 's1', token: 't', storage, apiRequest, now: () => 1000, pendingCollects: new Map() };
      await pushSourceCollectRef({ sourceId: 'ozon', raw: { sku: 's' } }, ctx);
      assert(fetchCount === 3, `status ${status} should retry 3 times, got ${fetchCount}`);
    }
  });

  // Case 7: 并发 5 次(in-flight 合并)— 真实场景:用户连点 5 次 < 100ms 第一次还没返回
  // codex P1.1 反馈点 — 之前 case 1 是顺序 await,没覆盖并发场景
  await test('case 7: 并发 5 次只 1 次 fetch(in-flight 合并)', async () => {
    const storage = makeStorage();
    let fetchCount = 0;
    let releaseFetch;
    const fetchPromise = new Promise((r) => { releaseFetch = r; });
    const apiRequest = async () => {
      fetchCount++;
      await fetchPromise; // 阻塞所有 fetch 直到我们 release
      return { id: 'concurrent-1' };
    };
    const ctx = { backendUrl: 'https://api.example.com', storeId: 's1', token: 't', storage, apiRequest, now: () => 1000, pendingCollects: new Map() };

    // 并发发起 5 个 — 第一个会真发 fetch,后 4 个 await 同一个 Promise
    const promises = Array.from({ length: 5 }, () =>
      pushSourceCollectRef({ sourceId: 'ozon', raw: { sku: 'concurrent-sku' } }, ctx)
    );
    // 让 fetch 完成
    releaseFetch();
    const results = await Promise.all(promises);

    assert(fetchCount === 1, `concurrent 5 should fetch once, got ${fetchCount}`);
    assert(results.every((r) => r.ok), 'all 5 should ok');
    // 第 1 个 dedupeHit=false(真发),其他 4 个 dedupeHit=true(合并到同一 promise)
    const hitCount = results.filter((r) => r.data?.dedupeHit).length;
    assert(hitCount === 4, `expected 4 dedupe hits, got ${hitCount}`);
  });

  // Case 8: 缺 sku 时跳过 dedupe(不应 crash)
  await test('case 8: 缺 sku 仍能正常 fetch,不写 cache', async () => {
    const storage = makeStorage();
    let fetchCount = 0;
    const apiRequest = async () => { fetchCount++; return { id: 'x' }; };
    const ctx = { backendUrl: 'https://api.example.com', storeId: 's1', token: 't', storage, apiRequest, now: () => 1000, pendingCollects: new Map() };

    const resp = await pushSourceCollectRef({ sourceId: 'ozon', raw: {} }, ctx);
    assert(resp.ok, 'should ok');
    assert(fetchCount === 1, 'should fetch once');
    const cached = Object.keys(storage.data).filter((k) => k.startsWith('jz-collect-recent-v1:'));
    assert(cached.length === 0, `no cache should be written for sku-less call, got ${cached.length}`);
  });

  // Case 9: forceResubmit 不污染普通 pending 槽位(codex 四审 P2.1)
  // 真实场景:用户先点采集(A),立即又点"强制重新采集"(B);
  // B 不应该覆盖 A 的 pending,否则后到的普通请求 C 会 await B 而不是 A
  await test('case 9: forceResubmit 不污染普通 pending', async () => {
    const storage = makeStorage();
    let fetchCount = 0;
    let releaseA, releaseB;
    const fetchAPromise = new Promise((r) => { releaseA = r; });
    const fetchBPromise = new Promise((r) => { releaseB = r; });
    const apiRequest = async () => {
      fetchCount++;
      if (fetchCount === 1) { await fetchAPromise; return { id: 'A-1' }; }
      if (fetchCount === 2) { await fetchBPromise; return { id: 'B-2' }; }
      return { id: `extra-${fetchCount}` };
    };
    const pendingCollects = new Map();
    const ctx = { backendUrl: 'https://api.example.com', storeId: 's1', token: 't', storage, apiRequest, now: () => 1000, pendingCollects };

    // 1. 普通请求 A 先到 — set pending,在等 fetchA
    const promiseA = pushSourceCollectRef({ sourceId: 'ozon', raw: { sku: 'same' } }, ctx);
    await new Promise(r => setTimeout(r, 0)); // 让 A 走到 set pending

    // 2. forceResubmit 请求 B 到达 — 不应该覆盖 A 的 pending
    const promiseB = pushSourceCollectRef({ sourceId: 'ozon', raw: { sku: 'same' }, forceResubmit: true }, ctx);
    await new Promise(r => setTimeout(r, 0));

    // 3. 后到的普通请求 C — 应该 await A(不是 B)
    const promiseC = pushSourceCollectRef({ sourceId: 'ozon', raw: { sku: 'same' } }, ctx);
    await new Promise(r => setTimeout(r, 0));

    // 让 A 和 B 都完成
    releaseA();
    releaseB();
    const [respA, respB, respC] = await Promise.all([promiseA, promiseB, promiseC]);

    // A 是首发,B 是 force,C 合并到 A(不是 B)
    // resp.data 形如 { dedupeHit, lastAt, result } — result 即后端原始返回(含 id)
    assert(respA.ok && respA.data.result.id === 'A-1', `A should fetch A-1, got ${JSON.stringify(respA)}`);
    assert(respB.ok && respB.data.result.id === 'B-2', `B should fetch B-2 (force), got ${JSON.stringify(respB)}`);
    assert(respC.ok && respC.data.result.id === 'A-1', `C should await A, got ${JSON.stringify(respC)}`);
    assert(respC.data.dedupeHit === true, 'C should be dedupeHit (merged with A)');
    assert(fetchCount === 2, `should fetch 2 times (A + B), got ${fetchCount}`);
  });

  // 汇总
  console.log(`\n${passed}/${testNum} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
