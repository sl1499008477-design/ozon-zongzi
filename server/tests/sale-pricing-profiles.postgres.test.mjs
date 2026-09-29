import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {createSalePricingProfiles} from '../sale-pricing-profiles.mjs';
import {createAiListingPresets} from '../ai-listing-presets.mjs';
import {normalizeAiListingConfig} from '../ai-listing-service.mjs';
import {aiListingItemPrice} from '../ai-listing-source-facts.mjs';
import {DEFAULT_REAL_PRICE_FORMULA} from '../../shared/sale-pricing.mjs';
import {createAiListingRuntime} from '../ai-listing-runtime.mjs';
import {memoryRepository} from './support/ai-listing-memory-repository.mjs';

test('saved sale pricing: scoped CRUD, revision, frozen Web/collector pricing and old configs', {skip:process.env.SONLI_POSTGRES_TESTS!=='1'}, async t=>{
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
  const schema='sale_pricing_'+randomUUID().replaceAll('-','');let pool;
  try{
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`});
    await pool.query("CREATE TABLE accounts(id TEXT PRIMARY KEY,role TEXT DEFAULT 'user');INSERT INTO accounts(id) VALUES('a'),('b')");
    for(const file of ['112_ai_listing_presets','147_sale_pricing_profiles','148_real_pricing_profiles','149_global_real_pricing_profiles'])await pool.query(await readFile(new URL(`../db/migrations/${file}.sql`,import.meta.url),'utf8'));
    const profiles=createSalePricingProfiles(pool),presets=createAiListingPresets(pool);
    let profile;
    const config={targetStoreId:'store',targetWarehouseId:'warehouse',priceAdjustmentKopecks:-1000,priceMultiplier:'5'};
    const source={sku:'2102714113',sourceSnapshot:{currency:'CNY',blackKopecks:'10692',greenKopecks:'10158'},items:[]};
    const group={sku:'2102714113',listingItem:{}};source.items=[group];
    let frozen,collectorFrozen,webTask,route;
    await t.test('account scope and formula validation',async()=>{
      profile=await profiles.save('a',null,{name:'减10乘5',currency:'CNY',realPriceFormula:DEFAULT_REAL_PRICE_FORMULA,salePriceFormula:'(真实售价 - 10) * 5'});
      assert.equal(profile.useBlackPriceWhenGreenMissing,false);
      assert.equal((await profiles.list('a')).length,1);assert.deepEqual(await profiles.list('b'),[]);
      await assert.rejects(profiles.get('b',profile.id),{statusCode:404});
      await assert.rejects(profiles.save('b',profile.id,{...profile,name:'stolen'}),{statusCode:409});
      await assert.rejects(profiles.remove('b',profile.id),{statusCode:404});
      await assert.rejects(profiles.save('a',null,{...profile,name:'bad',salePriceFormula:'eval(1)'}),{code:'SALE_PRICING_FORMULA_INVALID'});
      await assert.rejects(profiles.save('a',null,profile),{statusCode:409});
    });
    await t.test('server resolves owned saved rules, ignores forged formulas and freezes the collector snapshot',async()=>{
      const raw={...config,salePricingId:profile.id,salePricingUpdatedAt:profile.updatedAt,salePricing:{...profile,salePriceFormula:'1'}};
      frozen=normalizeAiListingConfig(await profiles.resolveConfig('a',raw));
      assert.equal(aiListingItemPrice(source,group,frozen,{currencyCode:'CNY'}).pricing.finalPriceKopecks,'54470');
      assert.throws(()=>aiListingItemPrice(source,group,{...frozen,salePricing:{...frozen.salePricing,salePriceFormula:'真实售价 / 0'}},{currencyCode:'CNY'}),error=>error.code==='SALE_PRICING_DIVISION_BY_ZERO'&&error.priceValidationFailure&&error.definitelyNotSubmitted);
      collectorFrozen=await profiles.freezeCollectorConfiguration('a',{autoStartAiGeneration:true,aiListingConfigSnapshot:{id:'saved-config',config:raw}});
      assert.deepEqual(collectorFrozen.aiListingConfigSnapshot.config.salePricing,frozen.salePricing);
      await assert.rejects(profiles.resolveConfig('b',raw),{statusCode:404});
    });
    await t.test('listing config preserves profile selection and exposes price revision to desktop clients',async()=>{
      const prompt=await presets.save('a','prompts',null,{name:'prompt',content:'test image'});
      const saved=await presets.save('a','configs',null,{name:'listing',config:{...config,promptId:prompt.id,salePricingId:profile.id}});
      const loaded=await presets.get('a','configs',saved.id);
      assert.equal(loaded.config.salePricingId,profile.id);assert.equal(loaded.config.salePricingUpdatedAt,profile.updatedAt);
      assert.equal((await presets.list('a','configs'))[0].config.salePricingUpdatedAt,profile.updatedAt);
      assert.equal(loaded.config.salePricing,undefined);
    });
    await t.test('Web HTTP task creation stores the selected server formula rather than client edits',async()=>{
      const repository=memoryRepository();
      const loaded={...source,collectItemId:'collect',items:[{...group,images:['https://example.test/original.jpg'],listingItem:{weight:100,depth:100,width:100,height:100}}]};
      const runtime=createAiListingRuntime({env:{},repository,resolvePool:async()=>pool,
        authenticate:async req=>({id:req.accountId||'a',role:'admin',status:'active'}),
        readJson:async req=>req.body,sendJson:(res,status,body)=>Object.assign(res,{status,body}),
        validateTarget:async()=>({store:{currencyCode:'CNY'}}),loadSources:async()=>[loaded],generateImage:async()=>{throw Error('must not generate');}});
      route=async(method,path,body,accountId='a')=>{const res={};await runtime.handleRoute({method,body,accountId},res,new URL(path,'http://qa'));return res;};
      const list=await route('GET','/ai-listing/pricing-profiles');assert.equal(list.status,200);assert.equal(list.body.items[0].id,profile.id);
      assert.equal((await route('GET',`/ai-listing/pricing-profiles/${profile.id}`,undefined,'b')).status,404);
      const result=await route('POST','/ai-listing/tasks/from-collect-box',{collectItemIds:['collect'],idempotencyKey:'pricing-http',config:{...config,manualReview:true,salePricingId:profile.id,salePricingUpdatedAt:profile.updatedAt,salePricing:{...profile,salePriceFormula:'1'}}});
      assert.equal(result.status,201,JSON.stringify(result.body));assert.equal(result.body.tasks.length,1);
      webTask=result.body.tasks[0];assert.deepEqual(webTask.config.salePricing,frozen.salePricing);
      assert.equal(aiListingItemPrice(source,group,webTask.config,{currencyCode:'CNY'}).pricing.finalPriceKopecks,'54470');
      repository.rows.get(webTask.id).status='GENERATION_FAILED';
    });
    await t.test('editing or deleting a profile never changes frozen tasks; stale new requests fail clearly',async()=>{
      const original=profile;
      profile=await profiles.save('a',profile.id,{...profile,salePriceFormula:'真实售价 * 2'});
      assert.notEqual(profile.updatedAt,original.updatedAt);
      await assert.rejects(profiles.resolveConfig('a',{...config,salePricingId:profile.id,salePricingUpdatedAt:original.updatedAt}),{statusCode:409});
      await assert.rejects(profiles.save('a',profile.id,original),{statusCode:409});
      const latest=normalizeAiListingConfig(await profiles.resolveConfig('a',{...config,salePricingId:profile.id}));
      assert.equal(aiListingItemPrice(source,group,latest,{currencyCode:'CNY'}).pricing.finalPriceKopecks,'23788');
      await profiles.remove('a',profile.id);
      assert.equal(aiListingItemPrice(source,group,frozen,{currencyCode:'CNY'}).pricing.finalPriceKopecks,'54470');
      assert.equal(aiListingItemPrice(source,group,normalizeAiListingConfig(collectorFrozen.aiListingConfigSnapshot.config),{currencyCode:'CNY'}).pricing.finalPriceKopecks,'54470');
      await assert.rejects(profiles.resolveConfig('a',{...config,salePricingId:profile.id}),{statusCode:404});
      const retry=await route('POST',`/ai-listing/tasks/${webTask.id}/retry`,{expectedVersion:webTask.version});
      assert.equal(retry.status,200,JSON.stringify(retry.body));
      assert.equal(aiListingItemPrice(source,group,retry.body.task.config,{currencyCode:'CNY'}).pricing.finalPriceKopecks,'54470');
    });
    await t.test('legacy tasks keep old formula and unreferenced client snapshots cannot inject a rule',async()=>{
      const legacy=normalizeAiListingConfig(await profiles.resolveConfig('a',{...config,salePricing:{salePriceFormula:'1'}}));
      assert.equal(legacy.salePricing,undefined);
      assert.equal(aiListingItemPrice(source,group,legacy,{currencyCode:'CNY'}).pricing.finalPriceKopecks,'54470');
    });
    await t.test('fallback setting is owned, persisted, frozen for Web and collector, and explicit when editing old profiles',async()=>{
      let saved=await profiles.save('a',null,{name:'缺绿用黑乘2',currency:'CNY',salePriceFormula:'真实售价 * 2',useBlackPriceWhenGreenMissing:true});
      assert.equal(saved.useBlackPriceWhenGreenMissing,true);
      assert.equal((await profiles.get('a',saved.id)).useBlackPriceWhenGreenMissing,true);
      assert.equal((await profiles.list('a')).find(row=>row.id===saved.id).useBlackPriceWhenGreenMissing,true);
      const raw={...config,salePricingId:saved.id,salePricing:{useBlackPriceWhenGreenMissing:false}};
      const frozenConfig=await profiles.resolveConfig('a',raw);
      assert.equal(frozenConfig.salePricing.useBlackPriceWhenGreenMissing,true);
      const collector=await profiles.freezeCollectorConfiguration('a',{aiListingConfigSnapshot:{config:raw}});
      assert.deepEqual(collector.aiListingConfigSnapshot.config.salePricing,frozenConfig.salePricing);
      const noGreen={...source,sourceSnapshot:{currency:'CNY',blackKopecks:'10000',greenKopecks:null}};
      assert.equal(aiListingItemPrice(noGreen,group,frozenConfig,{currencyCode:'CNY'}).pricing.finalPriceKopecks,'20000');
      saved=await profiles.save('a',saved.id,{...saved,useBlackPriceWhenGreenMissing:false});
      assert.equal(saved.useBlackPriceWhenGreenMissing,false);
      const newConfig=await profiles.resolveConfig('a',{...config,salePricingId:saved.id});
      assert.throws(()=>aiListingItemPrice(noGreen,group,newConfig,{currencyCode:'CNY'}),{code:'SALE_PRICING_SKU_SKIPPED'});
      assert.equal(aiListingItemPrice(noGreen,group,frozenConfig,{currencyCode:'CNY'}).pricing.finalPriceKopecks,'20000');
      await pool.query("UPDATE sale_pricing_profiles SET rules=rules-'useBlackPriceWhenGreenMissing' WHERE account_id=$1 AND id=$2",['a',saved.id]);
      assert.equal((await profiles.get('a',saved.id)).useBlackPriceWhenGreenMissing,false);
      await profiles.remove('a',saved.id);
    });
  }finally{await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});
