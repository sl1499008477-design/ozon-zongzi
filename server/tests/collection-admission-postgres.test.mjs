import './support/dedicated-postgres-test-environment.mjs';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import test,{after} from 'node:test';
import {getPostgresPool,closePostgresPool} from '../db/connection.mjs';
import {runMigrations} from '../db/migrate.mjs';
import {ingestCollectRequestV4} from '../collection-pipeline.mjs';
import {upsertCollectorRunItem} from '../collector-desktop-service.mjs';
import {admitCollectedItem} from '../collection-admission.mjs';
import {addSelectedCollectorItemsToCollectBox} from '../collector-selection-service.mjs';
const enabled=process.env.SONLI_POSTGRES_TESTS==='1';
after(async()=>{if(enabled)await closePostgresPool();});
test('desktop admission precedes its write lock, rejects failed checks, and replays saved results', {skip:!enabled}, async()=>{
  const pool=await getPostgresPool();await runMigrations(pool);
  const id='admission-'+randomUUID(), lease='fixture-lease';
  try {
    await pool.query("INSERT INTO accounts(id,username,role) VALUES($1,$1,'user')",[id]);
    await pool.query("INSERT INTO pricing_config_versions(id,version_no,scope_type,scope_id) VALUES($1,1,'account',$1)",[id]);
    await pool.query('INSERT INTO collector_devices(id,account_id,device_key) VALUES($1,$1,$1)',[id]);
    await pool.query("INSERT INTO collector_tasks(id,account_id,task_type,status) VALUES($1,$1,'MARKET','RUNNING')",[id]);
    await pool.query(`INSERT INTO collector_task_runs(id,task_id,account_id,pricing_config_version_id,run_no,status,
      claimed_by_device_id,lease_token_hash,lock_expires_at) VALUES($1,$1,$1,$1,1,'RUNNING',$1,$2,NOW()+INTERVAL '5 minutes')`,
    [id,createHash('sha256').update(lease).digest('hex')]);
    const input={accountId:id,runId:id,deviceId:id,leaseToken:lease,item:{source:'ozon',sourceKey:'1234567',sourceSku:'1234567',status:'QUALIFIED',rawPayload:{sku:'1234567',name:'Товар'}}};
    let calls=0;
    const checkAdmission=async({item})=>{
      calls++;
      const client=await pool.connect();try{
        await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='100ms'");
        await client.query('SELECT id FROM collector_task_runs WHERE id=$1 FOR UPDATE',[id]);
      }finally{await client.query('ROLLBACK');client.release();}
      if(calls===1)throw Object.assign(new Error('blocked'),{code:'PRODUCT_RESTRICTION_BLOCK'});
      return {...item,collectionAdmission:{status:'PASSED',checkedAt:'fixture'}};
    };
    await assert.rejects(upsertCollectorRunItem(input,{checkAdmission}),e=>e.code==='PRODUCT_RESTRICTION_BLOCK');
    assert.equal((await pool.query('SELECT count(*)::int n FROM collector_task_items WHERE account_id=$1',[id])).rows[0].n,0);
    const saved=await upsertCollectorRunItem(input,{checkAdmission});
    assert.equal(saved.item.rawPayload.collectionAdmission.status,'PASSED');
    await upsertCollectorRunItem(input,{checkAdmission:()=>{throw new Error('saved result must not be rechecked');}});
    const receipt=await ingestCollectRequestV4({authenticatedAccount:{id},input:{source:'ozon',sourceSku:'7654321',requestId:'new-source',payload:{sku:'7654321',name:'Товар'}},
      checkAdmission:async()=>{throw Object.assign(new Error('blocked'),{code:'PRODUCT_RESTRICTION_BLOCK'});}}).catch(error=>error);
    assert.equal(receipt.code,'PRODUCT_RESTRICTION_BLOCK');
  } finally {
    for(const table of ['collector_task_items','collector_task_runs','collector_tasks','collector_devices','collect_requests','pricing_config_versions'])
      await pool.query(`DELETE FROM ${table} WHERE ${table==='pricing_config_versions'?'id':'account_id'}=$1`,[id]);
    await pool.query('DELETE FROM accounts WHERE id=$1',[id]);
  }
});

test('desktop buyer captures reach Seller enrichment without bypassing final admission', {skip:!enabled}, async t=>{
  const pool=await getPostgresPool();await runMigrations(pool);
  const id='buyer-admission-'+randomUUID(),lease='buyer-fixture-lease',ruleId=id+'-blocked';
  const buyer={sku:'928000001',name:'Держатель для зубных щеток',images:['https://example.test/buyer.jpg']};
  const complete={...buyer,description_category_id:123,type_id:456,logistics:{weightG:500,lengthMm:300,widthMm:200,heightMm:100}};
  const admissionPorts={pool,
    readCredential:async(storeId,accountId)=>{
      assert.equal(storeId,id);assert.equal(accountId,id);
      return {id,clientId:'fixture-client',apiKey:'fixture-key'};
    },
    categories:{getCategoryTree:async()=>({items:[{description_category_id:123,children:[{type_id:456,children:[]}]}]})},
  };
  const checkAdmission=input=>admitCollectedItem(input,admissionPorts);
  const desktopInput=rawPayload=>({accountId:id,runId:id,deviceId:id,leaseToken:lease,
    item:{source:'ozon',sourceKey:rawPayload.sku,sourceSku:rawPayload.sku,status:'QUALIFIED',rawPayload}});
  try{
    await pool.query("INSERT INTO accounts(id,username,role) VALUES($1,$1,'user')",[id]);
    await pool.query("INSERT INTO stores(id,owner_account_id,client_id,is_current,status) VALUES($1,$1,$1,true,'active')",[id]);
    await pool.query("INSERT INTO pricing_config_versions(id,version_no,scope_type,scope_id) VALUES($1,1,'account',$1)",[id]);
    await pool.query('INSERT INTO collector_devices(id,account_id,device_key) VALUES($1,$1,$1)',[id]);
    await pool.query("INSERT INTO collector_tasks(id,account_id,task_type,status) VALUES($1,$1,'MARKET','RUNNING')",[id]);
    await pool.query(`INSERT INTO collector_task_runs(id,task_id,account_id,pricing_config_version_id,run_no,status,
      claimed_by_device_id,lease_token_hash,lock_expires_at) VALUES($1,$1,$1,$1,1,'RUNNING',$1,$2,NOW()+INTERVAL '5 minutes')`,
    [id,createHash('sha256').update(lease).digest('hex')]);

    await t.test('QUALIFIED buyer captures transfer once into per-SKU Seller enrichment jobs',async()=>{
      const captured={...buyer,variantData:{variants:[buyer,{...buyer,sku:'928000003'}]}};
      const saved=await upsertCollectorRunItem(desktopInput(captured),{checkAdmission});
      assert.equal(saved.item.status,'QUALIFIED');
      const row=(await pool.query('SELECT status,raw_payload FROM collector_task_items WHERE account_id=$1 AND id=$2',[id,saved.item.id])).rows[0];
      assert.equal(row.status,'QUALIFIED');
      assert.equal(row.raw_payload.status,'PENDING_ENRICHMENT');
      assert.equal(row.raw_payload.enrichment.status,'PENDING_ENRICHMENT');
      assert.equal(row.raw_payload.collectionAdmission,undefined);
      assert.ok(row.raw_payload.enrichment.missingFields.includes('descriptionCategoryId'));
      assert.ok(row.raw_payload.enrichment.missingFields.includes('weightG'));
      const selection={accountId:id,runId:id,itemIds:[saved.item.id]};
      const dependencies={ingestCollectRequestV4:options=>ingestCollectRequestV4({...options,checkAdmission})};
      const transferred=await addSelectedCollectorItemsToCollectBox(selection,dependencies);
      assert.equal(transferred.ok,true,JSON.stringify(transferred.errors));
      const collectItemId=transferred.results[0].collectItemId;
      const collect=(await pool.query(`SELECT c.status,d.data FROM collect_items c
        JOIN product_drafts d ON d.id=c.current_draft_id WHERE c.account_id=$1 AND c.id=$2`,[id,collectItemId])).rows[0];
      assert.equal(collect.status,'PENDING_ENRICHMENT');
      assert.equal(collect.data.collectionAdmission,undefined);
      const readJobs=async()=> (await pool.query(`SELECT id,sku,status FROM collector_ozon_enrichment_jobs
        WHERE account_id=$1 AND collect_item_id=$2 ORDER BY sku`,[id,collectItemId])).rows;
      const jobs=await readJobs();
      assert.deepEqual(jobs.map(({sku,status})=>({sku,status})),[
        {sku:'928000001',status:'PENDING'},{sku:'928000003',status:'PENDING'},
      ]);
      const replay=await addSelectedCollectorItemsToCollectBox(selection,dependencies);
      assert.equal(replay.ok,true,JSON.stringify(replay.errors));
      assert.equal(replay.results[0].collectItemId,collectItemId);
      assert.equal(replay.results[0].duplicate,true);
      assert.deepEqual(await readJobs(),jobs,'repeated transfer must retain the same per-SKU jobs');
    });

    await pool.query('INSERT INTO platform_product_restrictions(id,payload,updated_by) VALUES($1,$2,$3)',[ruleId,
      {enabled:true,action:'BLOCK',name:'Fixture prohibited type',reason:'Regression fixture',storeId:id,
        categories:[{categoryId:123,typeId:456}]},id]);
    await t.test('known prohibited buyer type is rejected even before packaging arrives',async()=>{
      const prohibited={...buyer,sku:'928000002',description_category_id:123,type_id:456};
      await assert.rejects(upsertCollectorRunItem(desktopInput(prohibited),{checkAdmission}),{code:'PRODUCT_RESTRICTION_BLOCK'});
      assert.equal((await pool.query('SELECT count(*)::int n FROM collector_task_items WHERE account_id=$1 AND source_sku=$2',[id,prohibited.sku])).rows[0].n,0);
    });
    await t.test('completed Seller facts still require enabled categories and allowed products',async()=>{
      await assert.rejects(checkAdmission({accountId:id,item:{...complete,type_id:999},requireComplete:true}),{code:'COLLECTION_CATEGORY_INVALID'});
      await assert.rejects(checkAdmission({accountId:id,item:complete,requireComplete:true}),{code:'PRODUCT_RESTRICTION_BLOCK'});
      await pool.query('DELETE FROM platform_product_restrictions WHERE id=$1',[ruleId]);
      const accepted=await checkAdmission({accountId:id,item:complete,requireComplete:true});
      assert.equal(accepted.status,'COMPLETE');
      assert.equal(accepted.collectionAdmission.status,'PASSED');
      assert.equal(accepted.collectionAdmission.restrictions.decision,'ALLOW');
      assert.equal(accepted.categoryResolution.target.descriptionCategoryId,123);
      assert.equal(accepted.categoryResolution.target.typeId,456);
    });
  }finally{
    await pool.query('DELETE FROM platform_product_restrictions WHERE id=$1',[ruleId]);
    for(const table of ['product_restriction_events','collector_task_items','collector_task_runs','collector_tasks','collector_devices','collect_requests',
      'collector_ozon_enrichment_jobs','collect_items','collect_raw_payloads','pricing_config_versions'])
      await pool.query(`DELETE FROM ${table} WHERE ${table==='pricing_config_versions'?'id':'account_id'}=$1`,[id]);
    await pool.query('DELETE FROM stores WHERE id=$1',[id]);
    await pool.query('DELETE FROM accounts WHERE id=$1',[id]);
  }
});
