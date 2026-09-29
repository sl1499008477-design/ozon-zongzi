import assert from 'node:assert/strict';
import test from 'node:test';
import {createOzonCategoryRouteHandler} from '../ozon-category-routes.mjs';

const paths=[
  '/ozon/categories/tree?language=RU',
  '/ozon/description-category/20/attributes',
  '/ozon/description-category/20/attributes/30/values?limit=77',
];
function fixture(resolveContext) {
  const calls=[], responses=[];
  const categoryService=Object.fromEntries(['getCategoryTree','getCategoryAttributes','getCategoryAttributeValues','resolveDescriptionCategoryId'].map(method=>[
    method,async input=>{calls.push({method,input});return method==='resolveDescriptionCategoryId'?10:{items:[{id:40,value:'Без бренда'}],meta:{source:'OZON_API'}};},
  ]));
  const handler=createOzonCategoryRouteHandler({
    resolveContext,categoryService,
    requireAuth(){throw new Error('GLOBAL_STATE_CONTEXT_USED');},
    sendJson(_res,status,body){responses.push({status,body});},
    sendError(_res,status,message,code){responses.push({status,body:{message,code}});},
  });
  const req={method:'GET',headers:{}},state={mustNotRead:true},res={};
  return {calls,responses,req,state,res,run:pathname=>handler({req,res,state,url:new URL(pathname,'http://fixture.invalid')})};
}

for(const pathname of paths) test('async context supplies the authenticated store for '+pathname,async()=>{
  let checks=0;const account={id:'account-a'},store={id:'store-a',ownerAccountId:account.id,apiKey:'fixture-only'};
  const f=fixture(async(req,state,url)=>{
    await Promise.resolve();
    assert.equal(req,f.req);assert.equal(state,f.state);assert.equal(url.pathname,new URL(pathname,'http://fixture.invalid').pathname);
    checks++;return {account,store};
  });
  assert.equal(await f.run(pathname),true);
  assert.equal(checks,pathname.startsWith('/ozon/categories/tree')?1:2);
  assert.ok(f.calls.every(call=>call.input.accountId===account.id&&call.input.store===store));
  assert.equal(f.responses[0].status,200);
  assert.deepEqual(f.responses[0].body.data,[{id:40,value:'Без бренда'}]);
  assert.doesNotMatch(JSON.stringify(f.responses),/fixture-only/);
});

for(const pathname of paths.slice(1)) for(const [status,code] of [[401,'WEB_AUTH_REQUIRED'],[403,'STORE_ACCOUNT_FORBIDDEN']]) {
  test('second asynchronous context recheck rejects '+code+' before data access: '+pathname,async()=>{
    let checks=0;
    const f=fixture(async()=>{
      await Promise.resolve();
      if(++checks===2)throw Object.assign(new Error(code),{status,code});
      return {account:{id:'a'},store:{id:'s',ownerAccountId:'a'}};
    });
    await assert.rejects(f.run(pathname),{status,code});
    assert.equal(checks,2);
    assert.deepEqual(f.calls.map(call=>call.method),['resolveDescriptionCategoryId']);
    assert.deepEqual(f.responses,[]);
  });
}
test('unrelated routes never resolve category context',async()=>{
  const f=fixture(async()=>{throw new Error('should not authenticate');});
  assert.equal(await f.run('/ozon/products/cache'),false);
  f.req.method='POST';
  assert.equal(await f.run(paths[0]),false);
  assert.deepEqual(f.calls,[]);
});
