import test from 'node:test';
import assert from 'node:assert/strict';
import {createAiUserChannels} from '../ai-user-channels.mjs';
import {createSub2ApiAdapter} from '../sub2api-ai-adapter.mjs';

for (const imageModel of ['gpt-image-2.5-flare','fal-ai/not-listed','fal-ai/*']) {
  test(`channel creation requires a concrete catalog entry: ${imageModel}`,async()=>{
    let reads=0;const writes=[];
    const service=createAiUserChannels({
      pool:{query:async(sql,values)=>{
        if(sql.startsWith('SELECT id FROM accounts'))return {rows:[{id:'admin-account'}]};
        if(sql.startsWith('SELECT id,account_id,key_fingerprint'))return {rows:[]};
        if(sql.startsWith('WITH channel')){writes.push(values);return {rows:[]};}
        throw new Error('Unexpected query');
      }},
      cipher:{fingerprint:()=> 'test-fingerprint',encrypt:(scope,key)=>{
        assert.deepEqual(scope,{accountId:'admin-account',connectionId:'new-channel',connectionVersion:1});
        assert.equal(key,'fixture-key');return {encrypted:'fixture-only'};
      }},
      gatewayFactory:options=>createSub2ApiAdapter({...options,
        resolveHostname:async()=>[{address:'203.0.113.10',family:4}],
        fetchImpl:async(url,init)=>{
          reads++;assert.equal(String(url),'https://api.apilio.ai/v1/models');
          assert.equal(init.method,'GET');assert.equal(init.body,undefined);
          assert.equal(init.headers.Authorization,'Bearer fixture-key');
          return Response.json({object:'list',data:['fal-ai/*','gpt-4-gizmo-*','gpt-image-2.5-flare']
            .map(id=>({id,object:'model',owned_by:'custom'}))});
        }}),
    });
    const create=()=>service.create({id:'admin-account',role:'admin'},{id:'new-channel',accountId:'admin-account',
      name:'api.apilio通道-01',baseUrl:'https://api.apilio.ai/v1',billingAccount:'api.apilio',apiKey:'fixture-key',
      imageProtocol:'SUB2API_OPENAI_IMAGES',imageModel,pricing:{mode:'REQUEST',currency:'CNY',requestPrice:'0.2'}});
    if(imageModel==='gpt-image-2.5-flare'){
      assert.deepEqual(await create(),{id:'new-channel'});assert.equal(writes.length,1);
      assert.equal(writes[0][6],imageModel);assert.equal(writes[0][10],'SUB2API_OPENAI_IMAGES');
      assert.deepEqual(JSON.parse(writes[0][11]),{mode:'REQUEST',currency:'CNY',requestPrice:'0.2'});
    } else {
      await assert.rejects(create(),{code:'AI_LISTING_CHANNEL_UNAVAILABLE',message:'通道不支持所选模型，请检查网关模型配置'});
      assert.equal(writes.length,0);
    }
    assert.equal(reads,1);
  });
}
