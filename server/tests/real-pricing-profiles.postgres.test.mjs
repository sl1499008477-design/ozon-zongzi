import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {createSalePricingProfiles} from '../sale-pricing-profiles.mjs';
import {createAiListingPresets} from '../ai-listing-presets.mjs';
import {createAiListingRuntime} from '../ai-listing-runtime.mjs';
import {calculateSalePrice} from '../../shared/sale-pricing.mjs';

test('global real pricing preserves old data and applies one administrator default to all accounts',{skip:process.env.SONLI_POSTGRES_TESTS!=='1'},async t=>{
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});const schema='real_pricing_'+randomUUID().replaceAll('-','');let pool;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`});
  await pool.query("CREATE TABLE accounts(id TEXT PRIMARY KEY,role TEXT DEFAULT 'user');INSERT INTO accounts VALUES('a','admin'),('b','user'),('empty','user')");
  const migrate=async file=>pool.query(await readFile(new URL(`../db/migrations/${file}.sql`,import.meta.url),'utf8'));
  await migrate('112_ai_listing_presets');await migrate('147_sale_pricing_profiles');
  const old={currency:'CNY',realPriceFormula:'黑标价',salePriceFormula:'真实售价 + 10'};
  await pool.query("INSERT INTO sale_pricing_profiles(id,account_id,name,rules) VALUES('old','a','加十', $1),('other','b','其他',$1)",[old]);
  await migrate('148_real_pricing_profiles');
  await pool.query("UPDATE real_pricing_profiles SET rules=rules||'{\"realPriceFormula\":\"黑标价 * 9\"}' WHERE account_id='b'");
  const legacy=(await pool.query('SELECT * FROM real_pricing_profiles ORDER BY id')).rows;
  await migrate('149_global_real_pricing_profiles');
  const profiles=createSalePricingProfiles(pool),presets=createAiListingPresets(pool);
  const route=async(method,path,body,actor={id:'a',role:'admin'})=>{
   const runtime=createAiListingRuntime({env:{},resolvePool:async()=>pool,authenticate:async()=>actor,readJson:async()=>body,sendJson:(res,status,payload)=>Object.assign(res,{status,body:payload})});
   const res={};assert.equal(await runtime.handleRoute({method},res,new URL(path,'http://qa')),true);return res;
  };
  let initial,alternate,frozen,preset;
  const input={currency:'CNY',blackKopecks:'10692',greenKopecks:'10158'};
  await t.test('migration copies the administrator default; ordinary users keep their old data without using it',async()=>{
   initial=await profiles.defaultReal('a');assert.equal(initial.id,'real:old');assert.equal(initial.realPriceFormula,'黑标价');
   assert.deepEqual(await profiles.defaultReal('b'),initial);assert.deepEqual(await profiles.defaultReal('empty'),initial);
   assert.deepEqual((await pool.query('SELECT * FROM real_pricing_profiles ORDER BY id')).rows,legacy);
   assert.equal((await profiles.list('b'))[0].id,'other');await assert.rejects(profiles.get('b','old'),{statusCode:404});
  });
  await t.test('admin management works, and ordinary users can still read the global default alongside their own listing profiles',async()=>{
   const listed=await route('GET','/admin/real-pricing-profiles');assert.equal(listed.status,200);assert.equal(listed.body.items[0].id,initial.id);
   const created=await route('POST','/admin/real-pricing-profiles',{name:'两倍真实',currency:'CNY',realPriceFormula:'黑标价 * 2',isDefault:true});
   assert.equal(created.status,200);alternate=created.body.item;assert.equal(alternate.isDefault,false);
   const own=await route('GET','/ai-listing/pricing-profiles',null,{id:'b',role:'user'});
   assert.equal(own.status,200);assert.deepEqual(own.body.items.map(i=>i.id),['other']);assert.equal(own.body.defaultRealPricing.id,initial.id);
   const edited=await route('PUT',`/admin/real-pricing-profiles/${alternate.id}`,{...alternate,name:'两倍竞品售价'});
   assert.equal(edited.status,200);alternate=edited.body.item;
  });
  await t.test('non-default formulas do not apply; switching the global default updates new resolutions and presets, not snapshots',async()=>{
   frozen=(await profiles.resolveConfig('b',{salePricingId:'other',realPricingId:initial.id,realPricingUpdatedAt:initial.updatedAt})).salePricing;
   assert.equal(calculateSalePrice(frozen,input).finalPriceKopecks,'11692');
   const prompt=await presets.save('b','prompts',null,{name:'prompt',content:'test'});
   preset=await presets.save('b','configs',null,{name:'preset',config:{targetStoreId:'store',targetWarehouseId:'warehouse',promptId:prompt.id,salePricingId:'other'}});
   assert.equal((await presets.get('b','configs',preset.id)).config.realPricingId,initial.id);
   const changed=await route('PUT',`/admin/real-pricing-profiles/${alternate.id}/default`);assert.equal(changed.status,200);
   assert.equal((await profiles.defaultReal('a')).id,alternate.id);assert.equal((await profiles.defaultReal('b')).id,alternate.id);
   const next=(await profiles.resolveConfig('b',{salePricingId:'other',realPricingId:'forged'})).salePricing;
   assert.equal(next.realPriceFormula,'黑标价 * 2');assert.equal(calculateSalePrice(next,input).finalPriceKopecks,'22384');
   assert.equal((await presets.get('b','configs',preset.id)).config.realPricingId,alternate.id);
   assert.equal(calculateSalePrice(frozen,input).finalPriceKopecks,'11692');
   await assert.rejects(profiles.resolveConfig('b',{salePricingId:'other',realPricingId:initial.id,realPricingUpdatedAt:initial.updatedAt}),{statusCode:409});
  });
  await t.test('cannot delete default; concurrent switches retain exactly one; stale edits and incompatible currencies are rejected',async()=>{
   assert.equal((await route('DELETE',`/admin/real-pricing-profiles/${alternate.id}`)).status,409);
   const third=await profiles.saveReal(null,{name:'三倍',currency:'CNY',realPriceFormula:'黑标价 * 3'});
   await Promise.all([profiles.setDefaultReal(third.id),profiles.setDefaultReal(alternate.id),profiles.setDefaultReal(third.id)]);
   assert.equal((await profiles.listReal()).filter(x=>x.isDefault).length,1);
   const chosen=await profiles.defaultReal();await profiles.saveReal(chosen.id,{...chosen,realPriceFormula:'黑标价 * 4'});
   await assert.rejects(profiles.saveReal(chosen.id,chosen),{statusCode:409});
   const rub=await profiles.save('b',null,{name:'卢布上架',currency:'RUB',salePriceFormula:'真实售价'});
   await assert.rejects(profiles.resolveConfig('b',{salePricingId:rub.id}),{statusCode:422});
   const independent=await profiles.save('b',null,{name:'独立上架',currency:'RUB',salePriceFormula:'黑标价'});
   assert.equal((await profiles.resolveConfig('b',{salePricingId:independent.id})).salePricing.realPriceFormula,undefined);
   assert.equal((await route('DELETE',`/admin/real-pricing-profiles/${initial.id}`)).status,200);
  });
  await t.test('new accounts use the existing global default without creating account rules',async()=>{
   await pool.query("INSERT INTO accounts(id) VALUES('new')");const expected=await profiles.defaultReal('a');
   assert.deepEqual(await profiles.defaultReal('new'),expected);
   assert.equal((await pool.query("SELECT count(*)::int n FROM real_pricing_profiles WHERE account_id='new'")).rows[0].n,0);
   assert.deepEqual((await pool.query('SELECT * FROM real_pricing_profiles ORDER BY id')).rows,legacy);
  });
 }finally{await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});
