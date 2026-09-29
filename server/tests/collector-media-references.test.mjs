import test from 'node:test';
import assert from 'node:assert/strict';
import {consumeCollectorMediaObjects} from '../collector-media-upload.mjs';

// Match the two failed group sizes, with both shared and SKU-specific assets.
function fixture(variantCount,sharedImages,uniqueImages=false){
  const rows=new Map(),intents=[];
  const variants=Array.from({length:variantCount},(_,variant)=>{
    const sku=String(9000000000+variant),urls=Array.from({length:sharedImages},(_,i)=>`https://source.test/shared-${i}.png`);
    if(uniqueImages&&variant%2===0)urls.push(`https://source.test/${sku}.png`);
    for(const [index,sourceUrl] of urls.entries()){
      const id=sourceUrl;
      if(!rows.has(id))rows.set(id,{id,account_id:'account',run_id:'run',device_id:'device',lease_hash:'lease',
        source_sku:sku,purpose:'rich-image',media_index:index,source_url:sourceUrl,collector_item_id:null,collect_item_id:null,
        expected_size:12,expected_type:'image/png',expected_md5:Buffer.alloc(16).toString('base64'),confirmed_object:null});
      intents.push({uploadId:id,sourceSku:sku,purpose:'rich-image',index,sourceUrl,size:12,contentType:'image/png',md5:Buffer.alloc(16).toString('base64')});
    }
    return {sku,richContent:{content:urls.map(src=>({img:{src}}))}};
  });
  const product={...variants[0],variantData:{variants}};
  const client={async query(sql,[accountId,ids,itemId,collectItemId]){
    assert.equal(new Set(ids).size,ids.length,'the database boundary receives one id per upload, not per SKU slot');
    const matching=[...rows.values()].filter(row=>row.account_id===accountId&&ids.includes(row.id));
    if(sql.startsWith('SELECT * FROM collector_media_uploads'))return {rows:matching};
    if(sql.startsWith('UPDATE collector_media_uploads SET collector_item_id=')){
      for(const row of matching){row.collector_item_id=itemId;row.collect_item_id??=collectItemId;}
      return {rows:[]};
    }
    throw Error('unexpected query');
  }};
  const scope={accountId:'account',runId:'run',itemId:'item',deviceId:'device',leaseHash:'lease'};
  return {rows,intents,product,client,scope};
}

for(const [variants,shared,unique,total,uploads] of [[87,48,false,4176,48],[100,16,true,1650,66]]){
  test(`${variants} variants retain all ${total} media slots through pending save, confirmation and handoff`,async()=>{
    const f=fixture(variants,shared,unique);
    const pending=await consumeCollectorMediaObjects(f.client,{...f.scope,payload:{...f.product,mediaObjects:[],mediaIntents:f.intents}});
    assert.equal(pending.mediaIntents.length,total);
    assert.deepEqual(pending.mediaIntents,f.intents);
    assert.equal(f.rows.size,uploads);
    for(const row of f.rows.values())row.confirmed_object={key:'staging/'+row.id,versionId:'v1',size:12,contentType:'image/png'};
    const confirmed=f.intents.map(({size,contentType,md5,...ref})=>({...ref,...f.rows.get(ref.uploadId).confirmed_object}));
    const saved=await consumeCollectorMediaObjects(f.client,{...f.scope,payload:{...f.product,mediaObjects:confirmed,mediaIntents:[]}});
    assert.equal(saved.mediaObjects.length,total);
    assert.deepEqual(saved.mediaObjects,confirmed);
    assert.deepEqual(saved.mediaIntents,[]);
    const handedOff=await consumeCollectorMediaObjects(f.client,{...f.scope,deviceId:undefined,leaseHash:undefined,collectItemId:'collect-item',payload:saved});
    assert.deepEqual(handedOff.mediaObjects,confirmed);
    assert.equal([...f.rows.values()].every(row=>row.collect_item_id==='collect-item'),true);
  });
}

test('large media groups still reject duplicate slots, mixed states, forged sources and foreign ownership',async()=>{
  const f=fixture(87,48),payload={...f.product,mediaObjects:[],mediaIntents:f.intents};
  for(const [change,code] of [
    [{payload:{...payload,mediaIntents:[...f.intents,f.intents[0]]}},'COLLECTOR_MEDIA_REFERENCE_INVALID'],
    [{payload:{...payload,mediaObjects:[f.intents[0]],mediaIntents:f.intents.slice(1)}},'COLLECTOR_MEDIA_REFERENCE_INVALID'],
    [{payload:{...payload,mediaIntents:[{...f.intents[0],sourceUrl:'https://source.test/forged.png'},...f.intents.slice(1)]}},'COLLECTOR_MEDIA_REFERENCE_TAMPERED'],
    [{accountId:'another-account'},'COLLECTOR_MEDIA_REFERENCE_SCOPE'],
    [{runId:'another-run'},'COLLECTOR_MEDIA_REFERENCE_SCOPE'],
    [{leaseHash:'another-lease'},'COLLECTOR_MEDIA_REFERENCE_SCOPE'],
  ])await assert.rejects(consumeCollectorMediaObjects(f.client,{...f.scope,payload,...change}),{code});
  await consumeCollectorMediaObjects(f.client,{...f.scope,payload});
  await assert.rejects(consumeCollectorMediaObjects(f.client,{...f.scope,itemId:'another-item',payload}),{code:'COLLECTOR_MEDIA_REFERENCE_SCOPE'});
});
