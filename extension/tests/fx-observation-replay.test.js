const assert = require('node:assert/strict');
const { createFxObservationReplay } = require('../lib/fx-observation-replay.js');
const worker = require('node:fs').readFileSync('extension/background/service-worker.js', 'utf8');
assert.match(worker, /JzFxObservationReplay\.createFxObservationReplay/);
assert.match(worker, /replay\.run\(/);

;(async () => {
  const data = new Map(); let collects = 0; let sends = 0; let fail = true;
  const replay = createFxObservationReplay({
    get: async (key) => data.get(key),
    set: async (key, value) => data.set(key, value),
    remove: async (key) => data.delete(key),
    makeKey: () => 'key-1',
  });
  const scope = { accountId: 'account-a', deviceId: 'device-a', action: 'FX_OBSERVATION' };
  const collect = async () => ({ observations: [{ observedAt: 'first' }] });
  await assert.rejects(() => replay.run(scope, async () => { collects += 1; return collect(); }, async () => { sends += 1; if (fail) throw new Error('lost'); return { ok: true }; }), /lost/);
  assert.equal(collects, 1);
  fail = false;
  await replay.run(scope, async () => { collects += 1; return { observations: [{ observedAt: 'second' }] }; }, async (body) => { sends += 1; assert.equal(body.observations[0].observedAt, 'first'); assert.equal(body.idempotencyKey, 'key-1'); return { ok: true }; });
  assert.equal(collects, 1);
  assert.equal(data.size, 0);
  await Promise.all([replay.run(scope, async () => { collects += 1; return {}; }, async () => { sends += 1; return { ok: true }; }), replay.run(scope, async () => { collects += 1; return {}; }, async () => { sends += 1; return { ok: true }; })]);
  assert.equal(collects, 2);
  assert.equal(sends, 3);
  console.log('fx observation replay tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
