import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {createSalePricingProfiles} from '../sale-pricing-profiles.mjs';
import {createAiListingRuntime} from '../ai-listing-runtime.mjs';
import {normalizeAiListingConfig} from '../ai-listing-service.mjs';
import {memoryRepository} from './support/ai-listing-memory-repository.mjs';

test('retry route adopts an edited authoritative profile despite stale frozen revisions and preserves account boundaries',
 {skip:process.env.SONLI_POSTGRES_TESTS!=='1'},async t=>{
  assert.ok(process.env.SONLI_MIGRATION_TEST_DATABASE_URL,'an explicit disposable database is required');
  const schema='pricing_refresh_'+randomUUID().replaceAll('-','');
  const accountId='owner-'+randomUUID(),otherAccountId='other-'+randomUUID();
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});let pool,runtime;
  try{
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`});
    await pool.query("CREATE TABLE accounts(id TEXT PRIMARY KEY,role TEXT DEFAULT 'user')");
    await pool.query("INSERT INTO accounts(id) VALUES($1),($2)",[accountId,otherAccountId]);
    for(const file of ['112_ai_listing_presets','147_sale_pricing_profiles','148_real_pricing_profiles','149_global_real_pricing_profiles'])await pool.query(await readFile(new URL(`../db/migrations/${file}.sql`,import.meta.url),'utf8'));
    const profiles=createSalePricingProfiles(pool),repository=memoryRepository();
    let owned=await profiles.save(accountId,null,{name:'own-original',currency:'CNY',salePriceFormula:'真实售价 * 2',useBlackPriceWhenGreenMissing:false});
    const foreign=await profiles.save(otherAccountId,null,{name:'other-private',currency:'CNY',salePriceFormula:'真实售价 * 9',useBlackPriceWhenGreenMissing:true});
    let real=await profiles.defaultReal();
    const resolved=await profiles.resolveConfig(accountId,{targetStoreId:'store',targetWarehouseId:'warehouse',salePricingId:owned.id,
      salePricingUpdatedAt:owned.updatedAt,realPricingId:real.id,realPricingUpdatedAt:real.updatedAt});
    // Preserve revision hints accepted by historical task snapshots as well as the frozen authoritative rules.
    const frozen={...normalizeAiListingConfig(resolved),salePricingUpdatedAt:owned.updatedAt,realPricingId:real.id,realPricingUpdatedAt:real.updatedAt};
    const oldProfileVersion=owned.updatedAt,oldRealVersion=real.updatedAt;
    const seed=async(config=frozen)=>repository.create({id:'task-'+randomUUID(),dedupeKey:randomUUID(),accountId,
      sourceType:'COLLECT_BOX',sourceId:'collect-'+randomUUID(),sku:'QA-SKU',name:'local pricing refresh test',status:'GENERATION_FAILED',config,
      source:{sku:'QA-SKU',sourceSnapshot:{currency:'CNY',blackKopecks:'10000'},items:[{sku:'QA-SKU',listingItem:{},images:['https://example.test/original.jpg']}]},
      images:[{sku:'QA-SKU',index:0,status:'GENERATION_FAILED',sourceUrl:'https://example.test/original.jpg',paidResultRetained:true}],
      createdAt:Date.now(),updatedAt:Date.now(),nextRunAt:Date.now(),errorMessage:'paid result retained for local reuse',submissionId:null});
    const refreshTask=await seed(),plainTask=await seed();
    owned=await profiles.save(accountId,owned.id,{...owned,useBlackPriceWhenGreenMissing:true});
    real=await profiles.saveReal(real.id,{...real,realPriceFormula:'黑标价 * 1.01'});
    assert.notEqual(owned.updatedAt,oldProfileVersion);assert.notEqual(real.updatedAt,oldRealVersion);
    await assert.rejects(profiles.resolveConfig(accountId,frozen),{statusCode:409},'the saved revisions are genuinely stale');
    runtime=createAiListingRuntime({env:{},repository,resolvePool:async()=>pool,
      authenticate:async req=>({id:req.accountId||accountId,role:'admin',status:'active'}),
      checkAccount:async({accountId:id})=>({id,role:'admin',status:'active'}),
      validateTarget:async()=>({store:{currencyCode:'CNY'}}),readJson:async req=>req.body,
      sendJson:(res,status,body)=>Object.assign(res,{status,body})});
    const retry=async(task,body={},id=accountId)=>{
      const res={};await runtime.handleRoute({method:'POST',accountId:id,body:{expectedVersion:task.version,...body}},res,new URL(`/ai-listing/tasks/${task.id}/retry`,'http://local-qa'));
      return res;
    };
    await t.test('explicit refresh bypasses obsolete client revisions and freezes current owned rules',async()=>{
      const res=await retry(refreshTask,{refreshSalePricing:true,salePricingId:foreign.id,salePricing:{...foreign}});
      assert.equal(res.status,200,JSON.stringify(res.body));
      assert.equal(res.body.task.config.salePricingId,owned.id);
      assert.equal(res.body.task.config.salePricing.useBlackPriceWhenGreenMissing,true);
      assert.equal(res.body.task.config.salePricing.updatedAt,owned.updatedAt);
      assert.equal(res.body.task.config.salePricing.realPricingUpdatedAt,real.updatedAt);
      assert.equal(res.body.task.config.salePricing.realPriceFormula,'黑标价 * 1.01');
      assert.equal(res.body.task.config.salePricing.salePriceFormula,'真实售价 * 2');
      assert.equal(repository.rows.get(refreshTask.id).pricingRefreshPending,true);
      assert.equal(repository.rows.get(refreshTask.id).images[0].reusePaidResult,true);
      assert.equal(frozen.salePricing.useBlackPriceWhenGreenMissing,false,'the prior frozen value remains unchanged');
    });
    await t.test('ordinary retry keeps the original snapshot without silently adopting changed prices',async()=>{
      const res=await retry(plainTask);
      assert.equal(res.status,200,JSON.stringify(res.body));
      assert.equal(res.body.task.config.salePricing.useBlackPriceWhenGreenMissing,false);
      assert.equal(res.body.task.config.salePricing.updatedAt,oldProfileVersion);
      assert.equal(res.body.task.config.salePricing.realPricingUpdatedAt,oldRealVersion);
    });
    await t.test('a foreign task or foreign bound profile is rejected without task mutation',async()=>{
      const crossTask=await seed();
      const beforeCross=structuredClone(repository.rows.get(crossTask.id));
      assert.equal((await retry(crossTask,{refreshSalePricing:true},otherAccountId)).status,404);
      assert.deepEqual(repository.rows.get(crossTask.id),beforeCross);
      const foreignBound=await seed({...frozen,salePricingId:foreign.id});
      const beforeForeign=structuredClone(repository.rows.get(foreignBound.id));
      const res=await retry(foreignBound,{refreshSalePricing:true});
      assert.equal(res.status,404,JSON.stringify(res.body));
      assert.deepEqual(repository.rows.get(foreignBound.id),beforeForeign);
    });
  }finally{
    await runtime?.stop();await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();
  }
});
