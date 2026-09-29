import test from 'node:test';
import assert from 'node:assert/strict';
import {createAiListingRuntime} from '../ai-listing-runtime.mjs';

test('global competitor pricing management rejects non-admins before body or database access, including the old URL',async()=>{
  for(const actor of [null,{id:'user',role:'user'}]){
    const runtime=createAiListingRuntime({authenticate:async()=>actor,
      resolvePool:()=>assert.fail('management must authorize before accessing the database'),
      readJson:()=>assert.fail('management must authorize before reading the body'),
      sendJson:(res,status,body)=>Object.assign(res,{status,body})});
    for(const prefix of ['/admin','/ai-listing'])for(const [method,suffix] of [['GET',''],['POST',''],['PUT','/profile'],['PUT','/profile/default'],['DELETE','/profile']]){
      const res={};assert.equal(await runtime.handleRoute({method},res,new URL(`http://qa${prefix}/real-pricing-profiles${suffix}`)),true);
      assert.equal(res.status,403,`${actor?.role||'anonymous'} ${method} ${prefix}${suffix}`);
    }
  }
});
