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
  const collect = async () => ({ observations: [{ observedAt: 'first' }] });
  await assert.rejects(() => replay.run(scope, async () => { collects += 1; return collect(); }, async () => { sends += 1; if (fail) throw new Error('lost'); return { ok: true }; }), /lost/);
  assert.equal(collects, 1);
  fail = false;
  await replay.run(scope, async () => { collects += 1; return { observations: [{ observedAt: 'second' }] }; }, async (body) => { sends += 1; assert.equal(body.observations[0].observedAt, 'first'); assert.equal(body.idempotencyKey, 'key-1'); return { ok: true }; });
  assert.equal(collects, 1);
  assert.equal(data.size, 0);
  data.set('jz:fx-pending:https%3A%2F%2Fapi.example:account-a:device-a:FX_OBSERVATION', { schemaVersion: 0 });
  await replay.run({ ...scope, backendOrigin: 'https://api.example' }, async () => ({ observations: [] }), async () => ({ ok: true }));
  await Promise.all([replay.run(scope, async () => { collects += 1; return {}; }, async () => { sends += 1; return { ok: true }; }), replay.run(scope, async () => { collects += 1; return {}; }, async () => { sends += 1; return { ok: true }; })]);
  assert.equal(collects, 2);
  assert.equal(sends, 3);

  const currentKey = 'jz:fx-pending:https%3A%2F%2Fapi.example:account-a:device-a:FX_OBSERVATION';
  const currentBody = {
    observations: [{ observedAt: 'current-pending' }],
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
  console.log('fx observation replay tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
