import test from 'node:test';
import assert from 'node:assert/strict';
import * as service from '../ozon-sync-service.mjs';
test('official key expiry overrides estimates without depending on the key creation date',async()=>{
  const store={apiKeyCreatedAt:'2026-07-01',apiKeyExpiresAt:'2026-12-28'};
  await service.refreshOzonKeyExpiry(store,{callApi:async(_store,path)=>{assert.equal(path,'/v1/roles');return {expires_at:'2026-09-01T00:00:00Z'};},now:()=>new Date('2026-09-10')});
  assert.equal(store.apiKeyExpiresAt,'2026-09-01T00:00:00.000Z');
  assert.equal(store.apiKeyExpirySource,'OZON_ROLES');
});
test('expiry lookup failure preserves an explicit value and never fabricates an unknown value',async()=>{
  const callApi=async()=>{throw Error('failure with credential that must not be stored');};
  const store={apiKeyExpiresAt:'2026-10-01'};await service.refreshOzonKeyExpiry(store,{callApi});
  assert.equal(store.apiKeyExpiresAt,'2026-10-01');
  assert.doesNotMatch(JSON.stringify(store),/credential/);
  const unknown={apiKeyCreatedAt:'2026-07-01'};await service.refreshOzonKeyExpiry(unknown,{callApi});
  assert.equal(unknown.apiKeyExpiresAt,undefined);
});
