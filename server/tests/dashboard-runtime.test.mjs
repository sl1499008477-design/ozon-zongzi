import test from 'node:test';
import assert from 'node:assert/strict';

async function runtime(options={}) {
  const module=await import('../dashboard-runtime.mjs').catch(error=>{
    if(error.code==='ERR_MODULE_NOT_FOUND')return {};
    throw error;
  });
  assert.equal(typeof module.createDashboardRuntime,'function','dashboard runtime must exist');
  return module.createDashboardRuntime(options);
}

test('dashboard authenticates and forwards only the actor and requested store for either API prefix',async()=>{
  const scopes=[];
  const r=await runtime({authenticate:async()=>({id:'owner',role:'admin'}),
    resolveService:async()=>({getSummary:async scope=>{scopes.push(scope);return {storeId:scope.storeId};}}),
    sendJson:(res,status,body)=>Object.assign(res,{status,body})});
  for(const prefix of ['','/api']) {
    const res={};assert.equal(await r.handleRoute({method:'GET'},res,new URL(`http://test${prefix}/ozon/dashboard/summary?storeId=owned&accountId=other`)),true);
    assert.equal(res.status,200);assert.deepEqual(res.body,{storeId:'owned'});
  }
  assert.deepEqual(scopes,[{accountId:'owner',storeId:'owned'},{accountId:'owner',storeId:'owned'}]);
  assert.equal(await r.handleRoute({method:'GET'},{},new URL('http://test/ozon/products')),false);
});

test('dashboard rejects unauthenticated and write requests before aggregation and hides internal errors',async()=>{
  let aggregates=0;
  const sendJson=(res,status,body)=>Object.assign(res,{status,body});
  const resolveService=async()=>({getSummary:async()=>{aggregates++;throw Error('private database details');}});
  let r=await runtime({authenticate:async()=>null,resolveService,sendJson}),res={};
  await r.handleRoute({method:'GET'},res,new URL('http://test/ozon/dashboard/summary'));
  assert.equal(res.status,403);assert.equal(aggregates,0);
  r=await runtime({authenticate:async()=>({id:'owner',role:'user'}),resolveService,sendJson});res={};
  await r.handleRoute({method:'POST'},res,new URL('http://test/ozon/dashboard/summary'));
  assert.equal(res.status,405);assert.equal(aggregates,0);
  res={};await r.handleRoute({method:'GET'},res,new URL('http://test/ozon/dashboard/summary'));
  assert.equal(res.status,500);assert.doesNotMatch(JSON.stringify(res),/private database/);
});
