import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {readCollectSummaryPage} from '../collect-read-summary.mjs';

const enabled=process.env.SONLI_POSTGRES_TESTS==='1';
test('200 existing groups and 1852 variants use lightweight stable pages with account-scoped partial-success exclusion',{skip:!enabled,timeout:60000},async()=>{
 const schema='collect_summary_'+randomUUID().replaceAll('-','');const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});let pool;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`});
  await pool.query(`CREATE TABLE collect_items(id text PRIMARY KEY,account_id text,source text,source_sku text,source_url text,created_at timestamptz,updated_at timestamptz,deleted_at timestamptz,status text,summary jsonb,current_draft_id text);
   CREATE TABLE product_drafts(id text PRIMARY KEY,collect_item_id text,data jsonb);
   CREATE TABLE collect_raw_payloads(id text PRIMARY KEY,account_id text,collect_item_id text,created_at timestamptz,payload jsonb);
   CREATE TABLE ai_image_listing_tasks(account_id text,status text,body jsonb);
   CREATE TABLE ozon_web_collection_jobs(id text,account_id text,sku text,scope text,status text,message text,error_code text,result jsonb,created_at timestamptz,updated_at timestamptz);
   CREATE TABLE collector_ozon_enrichment_jobs(id text,account_id text,collect_item_id text,sku text,status text,attempt_count integer,next_attempt_at timestamptz,claim_expires_at timestamptz,last_error_json jsonb,error_json jsonb,created_at timestamptz);`);
  const fixtures=Array.from({length:200},(_,i)=>{
   const id='group-'+String(i).padStart(3,'0');const variants=Array.from({length:i<52?10:9},(_,n)=>({sku:id+'-'+n,name:'已保存商品 '+i+' '+n,images:Array.from({length:13},(_,image)=>`https://source.invalid/${id}/${n}/image-${image}.jpg`),aspectValues:{颜色:'蓝色',规格:String(n)},price:'123.45',currency:'RUB',description:'历史富内容'.repeat(1000),attributes:Array.from({length:30},(_,n)=>({id:n,values:[{value:'existing fact'}]}))}));
   return {id,accountId:'owner',sku:variants[0].sku,variants,status:'COMPLETE'};
  });
  const extra=[{...fixtures[0],id:'foreign',accountId:'other'}, {...fixtures[0],id:'deleted',deleted:true}];
  const all=[...fixtures,...extra];
  await pool.query(`INSERT INTO collect_items SELECT value->>'id',value->>'accountId','ozon',value->>'sku','https://www.ozon.ru/product/'||(value->>'sku'),'2026-09-01'::timestamptz,'2026-09-16'::timestamptz,CASE WHEN value->>'deleted'='true' THEN NOW() END,value->>'status',jsonb_build_object('name','Saved group','image','https://image.invalid/root.jpg','enrichment',jsonb_build_object('status','COMPLETE')),'draft-'||(value->>'id') FROM jsonb_array_elements($1::jsonb) value`,[JSON.stringify(all)]);
  await pool.query(`INSERT INTO product_drafts SELECT 'draft-'||(value->>'id'),value->>'id',jsonb_build_object('variants',value->'variants','fullDraftMarker','MUST_NOT_TRANSFER') FROM jsonb_array_elements($1::jsonb) value`,[JSON.stringify(all)]);
  await pool.query(`INSERT INTO collect_raw_payloads SELECT 'raw-'||(value->>'id'),value->>'accountId',value->>'id',NOW(),jsonb_build_object('rawMarker','MUST_NOT_TRANSFER','normalized',jsonb_build_object('name','Saved title','price','777.88','currency','RUB','variants',value->'variants','images',jsonb_build_array('https://image.invalid/first.jpg','https://image.invalid/second.jpg'))) FROM jsonb_array_elements($1::jsonb) value`,[JSON.stringify(all)]);
  await pool.query(`INSERT INTO ai_image_listing_tasks VALUES
   ('owner','COMPLETED',$1),('owner','SUBMISSION_FAILED',$2),('other','COMPLETED',$3)`,[
   JSON.stringify({source:{items:fixtures[0].variants.map(({sku})=>({sku,description:'do not transfer task bodies'}))}}),
   JSON.stringify({submissionResults:[{sku:'group-199-0',importStatus:'SUCCEEDED'},{sku:'group-199-1',importStatus:'FAILED'}]}),
   JSON.stringify({source:{items:[{sku:'group-199-1'}]}}),
  ]);
  await pool.query(`INSERT INTO collector_ozon_enrichment_jobs VALUES ('job','owner','group-199','group-199-1','FAILED',2,NULL,NULL,NULL,'{"code":"ZONGZI_ENRICH_INCOMPLETE","message":"missing actual package"}',NOW())`);
  // A saved CNY listing quote is separate from its original RUB collection price.
  // Draft membership/order remains authoritative even when its display fields are sparse.
  await pool.query(`UPDATE product_drafts SET data=jsonb_build_object('variants',$1::jsonb) WHERE id='draft-group-198'`,[
   JSON.stringify([{sku:'group-198-3',name:'Edited third',sellPrice:'70.00',currencyCode:'CNY'},
    {sku:'group-198-1',name:'Edited first',sellPrice:'80.00',currencyCode:'CNY'}]),
  ]);
  const reads=[];const readCategories=async scope=>{reads.push(scope);return [];};
  const page=await readCollectSummaryPage({pool,accountId:'owner',limit:20,readCategories});
  assert.equal(page.total,199);assert.equal(page.counts['全部'],199);assert.equal(page.counts['待处理'],199);assert.equal(page.items.length,20);
  assert.equal(page.items[0].id,'group-199');assert.equal(page.items[0].variants.length,8);assert(page.items[0].variants.some(v=>v.sku==='group-199-1'));
  assert.equal(page.items[0].enrichment.executionState,'FAILED');assert.equal(page.items[0].price,'777.88');assert.equal(page.items[0].variants[0].image,'https://source.invalid/group-199/1/image-0.jpg');
  const edited=page.items.find(item=>item.id==='group-198');
  assert.deepEqual(edited.variants.map(row=>row.sku),['group-198-3','group-198-1']);
  assert.deepEqual(edited.variants.map(row=>[row.price,row.currency]),[['123.45','RUB'],['123.45','RUB']]);
  assert.equal(edited.variants[0].name,'Edited third');assert.equal(edited.variants[0].aspectValues.规格,'3');
  assert.equal(edited.variants[0].image,'https://source.invalid/group-198/3/image-0.jpg');
  assert.equal(reads[0].collectItemIds.length,20);assert(!JSON.stringify(page).includes('MUST_NOT_TRANSFER'));assert(!JSON.stringify(page).includes('历史富内容'));assert(!JSON.stringify(page).includes('attributes'));
  const next=await readCollectSummaryPage({pool,accountId:'owner',limit:20,offset:20,readCategories});assert(!next.items.some(item=>page.items.some(first=>first.id===item.id)));assert.equal(next.items[0].id,'group-179');
  assert.equal((await readCollectSummaryPage({pool,accountId:'owner',variant:'单 SKU',readCategories})).total,0);
  assert.equal((await readCollectSummaryPage({pool,accountId:'other',readCategories})).total,1);
  const {rows:[{bytes}]}=await pool.query("SELECT SUM(octet_length(payload::text))::bigint AS bytes FROM collect_raw_payloads WHERE account_id='owner'");
  assert(Buffer.byteLength(JSON.stringify(page))*20<Number(bytes),'page transfers a small fraction of saved raw payload');
  console.log(JSON.stringify({kind:'collect-summary-200-groups',sourceGroups:200,sourceVariants:1852,totalVisible:page.total,pageBytes:Buffer.byteLength(JSON.stringify(page)),rawBytes:Number(bytes)}));
 }finally{await pool?.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
