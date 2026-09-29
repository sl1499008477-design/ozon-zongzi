import test from 'node:test';
import assert from 'node:assert/strict';
import {readAiListingStoreQuota} from '../ai-listing-store-routing.mjs';
import {createAiListingRuntime} from '../ai-listing-runtime.mjs';

test('displayed quota uses daily SKU allowance regardless of total capacity', async () => {
  for (const [daily, total, remaining] of [[2, 950, 2], [80, 3, 80], [0, 900, 0], [-2, 900, 0]]) {
    const result = await readAiListingStoreQuota({accountId:'account-a', storeId:'store-a',
      readCredential:async (storeId, accountId) => {
        assert.equal(storeId, 'store-a'); assert.equal(accountId, 'account-a');
        return {clientId:'client-a', apiKey:'PRIVATE'};
      },
      call:async (credential, path, body) => {
        assert.equal(credential.clientId, 'client-a');
        assert.equal(path, '/v4/product/info/limit'); assert.deepEqual(body, {});
        return {daily_create:{limit:100,usage:100-daily}, total:{limit:1000,usage:1000-total},
          daily_update:{limit:1,usage:1}, operation_limits:{limit:1}};
      }});
    assert.equal(result.remaining, remaining);
    assert.equal(result.storeId, 'store-a');
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  }
});

test('missing or foreign store credentials never call Ozon, and an empty account cannot bypass ownership', async () => {
  let calls = 0;
  const call=async()=>{calls++;};
  await assert.rejects(readAiListingStoreQuota({accountId:'account-a',storeId:'foreign',readCredential:async()=>null,call}),{statusCode:404});
  await assert.rejects(readAiListingStoreQuota({accountId:'',storeId:'store-a',readCredential:async()=>{calls++;},call}),{statusCode:403});
  assert.equal(calls, 0);
});

test('failed or incomplete Ozon responses are unavailable, never reported as zero quota', async () => {
  const input={accountId:'account-a',storeId:'store-a',readCredential:async()=>({})};
  for (const quota of [{}, {daily_create:{limit:100}},
    {daily_create:{limit:null,usage:0},total:{limit:100,usage:0}}]) {
    await assert.rejects(readAiListingStoreQuota({...input,call:async()=>quota}),{statusCode:502});
  }
  await assert.rejects(readAiListingStoreQuota({...input,call:async()=>{throw new Error('private upstream detail');}}),
    error=>error.statusCode===502 && !error.message.includes('private'));
});

test('quota HTTP route uses the authenticated account, ignores caller account IDs, and denies unauthenticated reads', async () => {
  for (const authenticated of [true, false]) {
    let calls = 0;
    const runtime=createAiListingRuntime({
      authenticate:async()=>{if (!authenticated) throw Object.assign(new Error('请登录'),{statusCode:401}); return {id:'account-a',role:'user',status:'active'};},
      resolvePool:async()=>({query:async()=>({rows:[]})}),
      readStoreQuota:async input=>{calls++; assert.deepEqual(input,{accountId:'account-a',storeId:'store-a'}); return {storeId:'store-a',remaining:23};},
      sendJson:(res,status,body)=>Object.assign(res,{status,body}),
    });
    const res={};
    await runtime.handleRoute({method:'GET'},res,new URL('https://example.test/api/ai-listing/stores/store-a/quota?accountId=foreign'));
    assert.equal(res.status, authenticated ? 200 : 401);
    assert.equal(calls, authenticated ? 1 : 0);
    if (authenticated) assert.deepEqual(res.body,{storeId:'store-a',remaining:23});
  }
});


test('daily-only responses are enough to display remaining SKU allowance',async()=>{
 const value=await readAiListingStoreQuota({accountId:'account',storeId:'store',readCredential:async()=>({}),call:async()=>({daily_create:{limit:100,usage:2}})});
 assert.deepEqual(value,{storeId:'store',remaining:98});
});
