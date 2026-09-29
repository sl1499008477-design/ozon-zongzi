import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from 'pg';
import {readProductCatalogPage} from '../local-state-reader.mjs';
import {hydratedProductRow} from '../formal-persistence.mjs';
import {productCatalogPage,productStatusMeta} from '../../shared/product-catalog.mjs';

const enabled=process.env.SONLI_POSTGRES_TESTS==='1';
test('existing catalog data preserves exact filtering and page identities without reading other stores',{skip:!enabled},async t=>{
 const client=new Client({connectionString:process.env.DATABASE_URL});await client.connect();t.after(async()=>{await client.query('ROLLBACK');await client.end();});
 await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
 const chosen=(await client.query('SELECT s.id,s.owner_account_id FROM stores s JOIN products p ON p.store_id=s.id GROUP BY s.id,s.owner_account_id ORDER BY COUNT(*) DESC LIMIT 1')).rows[0];
 assert.ok(chosen,'existing database must have catalog products');
 const products=(await client.query('SELECT * FROM products WHERE store_id=$1 ORDER BY updated_at DESC,id',[chosen.id])).rows.map(hydratedProductRow);
 for(const status of new Set(products.map(product=>productStatusMeta(product).label)))for(const stock of ['全部','缺货','低库存'])for(const pageSize of [5,10,20,50]){
  const options={status,stock,page:2,pageSize};
  const actual=await readProductCatalogPage({pool:client,accountId:chosen.owner_account_id,storeId:chosen.id,options});
  const expected=productCatalogPage(products,options);
  assert.deepEqual(actual,{...expected,storeId:chosen.id});
 }
 const probe=products.find(p=>p.sku);assert.ok(probe);
 const options={q:probe.sku,status:productStatusMeta(probe).label,page:1,pageSize:5};
 assert.deepEqual(await readProductCatalogPage({pool:client,accountId:chosen.owner_account_id,storeId:chosen.id,options}),{...productCatalogPage(products,options),storeId:chosen.id});
 await assert.rejects(readProductCatalogPage({pool:client,accountId:'not-the-owner',storeId:chosen.id,options}),{status:404});
});

test('legacy raw catalog identities, status and stock fallbacks survive the small page index',{skip:!enabled},async t=>{
 const client=new Client({connectionString:process.env.DATABASE_URL});await client.connect();t.after(()=>client.end());
 await client.query('CREATE TEMP TABLE stores AS SELECT * FROM public.stores WITH NO DATA;CREATE TEMP TABLE products AS SELECT * FROM public.products WITH NO DATA');
 await client.query("INSERT INTO stores(id,owner_account_id) VALUES('legacy','a')");
 const raw={id:'raw-id',product_id:'raw-product',sku:'raw-sku',offer_id:'raw-offer',name:'原始名称',status:'selling',visibility:'visible',stock:4,barcode:'raw-barcode'};
 await client.query("INSERT INTO products(id,store_id,raw,updated_at) VALUES('database-id','legacy',$1,now())",[raw]);
 const products=(await client.query("SELECT * FROM products WHERE store_id='legacy'")).rows.map(hydratedProductRow);
 for(const q of ['raw-id','raw-product','raw-sku','raw-offer','原始名称','raw-barcode']){
  const options={page:1,pageSize:5,status:'销售中',stock:'低库存',q};
  assert.deepEqual(await readProductCatalogPage({pool:client,accountId:'a',storeId:'legacy',options}),{...productCatalogPage(products,options),storeId:'legacy'});
 }
});
