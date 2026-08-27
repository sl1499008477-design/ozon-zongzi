const assert = require('node:assert/strict');
const { createFxObservationReplay } = require('../lib/fx-observation-replay.js');
const worker = require('node:fs').readFileSync('extension/background/service-worker.js', 'utf8');
assert.match(worker, /JzFxObservationReplay\.createFxObservationReplay/);
assert.match(worker, /replay\.run\(/);

;(async () => {
  const data = new Map();
  let collects = 0;
  let sends = 0;
  let fail = true;
  const replay = createFxObservationReplay({
    get: async (key) => data.get(key),
    list: async () => Object.fromEntries(data),
    set: async (key, value) => data.set(key, value),
    remove: async (keys) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key);
    },
    makeKey: () => 'key-1',
    now: () => 10_000,
  });
  const scope = { backendOrigin: 'https://api.example', accountId: 'account-a', deviceId: 'device-a', action: 'FX_OBSERVATION' };
  const collect = async () => ({ observations: [{ observedAt: 'first' }], errors: [], deviceId: scope.deviceId });
  await assert.rejects(() => replay.run(scope, async () => { collects += 1; return collect(); }, async () => { sends += 1; if (fail) throw new Error('lost'); return { ok: true }; }), /lost/);
  assert.equal(collects, 1);
  fail = false;
  await replay.run(scope, async () => { collects += 1; return { observations: [{ observedAt: 'second' }], errors: [], deviceId: scope.deviceId }; }, async (body) => { sends += 1; assert.equal(body.observations[0].observedAt, 'first'); assert.equal(body.idempotencyKey, 'key-1'); return { ok: true }; });
  assert.equal(collects, 1);
  assert.equal(data.size, 0);
  data.set('jz:fx-pending:https%3A%2F%2Fapi.example:account-a:device-a:FX_OBSERVATION', { schemaVersion: 0 });
  await replay.run({ ...scope, backendOrigin: 'https://api.example' }, async () => ({ observations: [], errors: [], deviceId: scope.deviceId }), async () => ({ ok: true }));
  await Promise.all([replay.run(scope, async () => { collects += 1; return { observations: [], errors: [], deviceId: scope.deviceId }; }, async () => { sends += 1; return { ok: true }; }), replay.run(scope, async () => { collects += 1; return { observations: [], errors: [], deviceId: scope.deviceId }; }, async () => { sends += 1; return { ok: true }; })]);
  assert.equal(collects, 2);
  assert.equal(sends, 3);

  const currentKey = 'jz:fx-pending:https%3A%2F%2Fapi.example:account-a:device-a:FX_OBSERVATION';
  const currentBody = {
    observations: [{ observedAt: 'current-pending' }],
    errors: [],
    deviceId: scope.deviceId,
    idempotencyKey: 'stable-current-key',
  };
  const namespaceData = new Map([
    ['unrelated:preference', { keep: true }],
    [currentKey, {
      schemaVersion: 1,
      scope,
      createdAt: 9_000,
      expiresAt: 11_000,
      key: 'stable-current-key',
      body: currentBody,
    }],
    ['jz:fx-pending:old-token-hash:device-a:FX_OBSERVATION', {
      scope: { accountId: 'old-token-hash', deviceId: 'device-a', action: 'FX_OBSERVATION' },
      body: { idempotencyKey: 'legacy' },
    }],
    ['jz:fx-pending:https%3A%2F%2Fold.example:account-a:device-a:FX_OBSERVATION', {
      schemaVersion: 1,
      scope: { ...scope, backendOrigin: 'https://old.example' },
      createdAt: 9_000,
      expiresAt: 11_000,
      key: 'old-backend',
      body: { idempotencyKey: 'old-backend' },
    }],
    ['jz:fx-pending:https%3A%2F%2Fapi.example:account-b:device-a:FX_OBSERVATION', {
      schemaVersion: 1,
      scope: { ...scope, accountId: 'account-b' },
      createdAt: 9_000,
      expiresAt: 11_000,
      key: 'other-account',
      body: { idempotencyKey: 'other-account' },
    }],
    ['jz:fx-pending:https%3A%2F%2Fapi.example:account-a:device-old:FX_OBSERVATION', {
      schemaVersion: 1,
      scope: { ...scope, deviceId: 'device-old' },
      createdAt: 9_000,
      expiresAt: 11_000,
      key: 'old-device',
      body: { idempotencyKey: 'old-device' },
    }],
    ['jz:fx-pending:https%3A%2F%2Fapi.example:account-a:device-a:OLD_ACTION', {
      schemaVersion: 1,
      scope: { ...scope, action: 'OLD_ACTION' },
      createdAt: 9_000,
      expiresAt: 11_000,
      key: 'old-action',
      body: { idempotencyKey: 'old-action' },
    }],
    ['jz:fx-pending:https%3A%2F%2Fexpired.example:account-a:device-a:FX_OBSERVATION', {
      schemaVersion: 1,
      scope: { ...scope, backendOrigin: 'https://expired.example' },
      createdAt: 1,
      expiresAt: 2,
      key: 'expired',
      body: { idempotencyKey: 'expired' },
    }],
    ['jz:fx-pending:malformed', null],
  ]);
  let namespaceCollects = 0;
  const namespaceSends = [];
  const namespaceReplay = createFxObservationReplay({
    get: async (key) => namespaceData.get(key),
    list: async () => Object.fromEntries(namespaceData),
    set: async (key, value) => namespaceData.set(key, value),
    remove: async (keys) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) namespaceData.delete(key);
    },
    makeKey: () => 'must-not-be-used',
    now: () => 10_000,
  });
  await namespaceReplay.run(
    scope,
    async () => {
      namespaceCollects += 1;
      return { observations: [{ observedAt: 'new' }] };
    },
    async (body) => {
      namespaceSends.push(body);
      return { ok: true };
    },
  );
  assert.equal(namespaceCollects, 0, 'the current stable pending observation must be replayed');
  assert.deepEqual(namespaceSends, [currentBody], 'only the current scope record may be sent');
  assert.deepEqual(
    [...namespaceData.entries()],
    [['unrelated:preference', { keep: true }]],
    'all stale pending namespace entries are removed without touching unrelated storage',
  );

  const malformedCurrentData = new Map([
    ['unrelated:preference', { keep: true }],
    [currentKey, {
      schemaVersion: 1,
      scope,
      createdAt: 9_000,
      expiresAt: 11_000,
      key: 'malformed-current-key',
      body: {
        idempotencyKey: 'malformed-current-key',
        observations: 'not-an-array',
        errors: { message: 'not-an-array' },
        deviceId: 'wrong-device',
      },
    }],
  ]);
  let malformedCollects = 0;
  const malformedSends = [];
  const malformedReplay = createFxObservationReplay({
    list: async () => Object.fromEntries(malformedCurrentData),
    set: async (key, value) => malformedCurrentData.set(key, value),
    remove: async (keys) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) malformedCurrentData.delete(key);
    },
    makeKey: () => 'replacement-key',
    now: () => 10_000,
  });
  await malformedReplay.run(
    scope,
    async () => {
      malformedCollects += 1;
      return { observations: [], errors: [], deviceId: scope.deviceId };
    },
    async (body) => {
      malformedSends.push(body);
      return { ok: true };
    },
  );
  assert.equal(malformedCollects, 1, 'a malformed current record must be replaced');
  assert.deepEqual(
    malformedSends,
    [{ observations: [], errors: [], deviceId: scope.deviceId, idempotencyKey: 'replacement-key' }],
    'only the newly persisted valid body may be sent',
  );
  assert.deepEqual(
    [...malformedCurrentData.entries()],
    [['unrelated:preference', { keep: true }]],
    'the malformed current record is removed without touching unrelated storage',
  );

  const failClosedScope = { ...scope, deviceId: 'fail-closed-device' };
  const failClosedBody = { observations: [], errors: [], deviceId: failClosedScope.deviceId };
  for (const failure of ['list', 'set', 'stale-remove']) {
    let failClosedCollects = 0;
    let failClosedSends = 0;
    const failClosedReplay = createFxObservationReplay({
      list: async () => {
        if (failure === 'list') throw new Error('storage list failed');
        if (failure === 'stale-remove') return { 'jz:fx-pending:malformed': null };
        return {};
      },
      set: async () => {
        if (failure === 'set') throw new Error('storage set failed');
      },
      remove: async () => {
        if (failure === 'stale-remove') throw new Error('storage remove failed');
      },
      makeKey: () => 'fail-closed-key',
      now: () => 10_000,
    });
    await assert.rejects(
      () => failClosedReplay.run(
        failClosedScope,
        async () => {
          failClosedCollects += 1;
          return failClosedBody;
        },
        async () => {
          failClosedSends += 1;
          return { ok: true };
        },
      ),
      /storage (?:list|set|remove) failed/,
    );
    assert.equal(failClosedSends, 0, `${failure} failure must not reach the external send`);
    assert.equal(failClosedCollects, failure === 'set' ? 1 : 0);
  }

  const retainedAfterRemoveFailure = new Map();
  let postSendCollects = 0;
  const postSendBodies = [];
  let failFinalRemove = true;
  const postSendReplay = createFxObservationReplay({
    list: async () => Object.fromEntries(retainedAfterRemoveFailure),
    set: async (key, value) => retainedAfterRemoveFailure.set(key, value),
    remove: async (keys) => {
      if (failFinalRemove) throw new Error('final remove failed');
      for (const key of Array.isArray(keys) ? keys : [keys]) retainedAfterRemoveFailure.delete(key);
    },
    makeKey: () => 'retained-key',
    now: () => 10_000,
  });
  await assert.rejects(
    () => postSendReplay.run(
      failClosedScope,
      async () => {
        postSendCollects += 1;
        return failClosedBody;
      },
      async (body) => {
        postSendBodies.push(body);
        return { ok: true };
      },
    ),
    /final remove failed/,
  );
  assert.equal(retainedAfterRemoveFailure.size, 1, 'a sent record remains available after final cleanup fails');
  failFinalRemove = false;
  await postSendReplay.run(
    failClosedScope,
    async () => {
      postSendCollects += 1;
      return failClosedBody;
    },
    async (body) => {
      postSendBodies.push(body);
      return { ok: true };
    },
  );
  assert.equal(postSendCollects, 1, 'cleanup recovery must replay rather than recollect');
  assert.equal(postSendBodies.length, 2);
  assert.equal(postSendBodies[0].idempotencyKey, 'retained-key');
  assert.deepEqual(postSendBodies[1], postSendBodies[0], 'cleanup recovery must preserve the original request');
  assert.equal(retainedAfterRemoveFailure.size, 0);
  console.log('fx observation replay tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
