import test from 'node:test';
import assert from 'node:assert/strict';
import * as persistence from '../formal-persistence.mjs';

const fixture = () => ({accounts:[{id:'a',username:'owner'}],stores:[
  {id:'s1',ownerAccountId:'a'},{id:'s2',ownerAccountId:'a'}],sessions:{},
  currentAccountId:'a',currentStoreId:'s1',caches:{products:[
    {id:'p1',product_id:'1',sku:'11',storeId:'s1',name:'one',price:'12.34',images:['https://example.com/1.jpg']},
    {id:'p2',product_id:'2',sku:'22',storeId:'s2',name:'two',price:'23.45'}],
    warehouses:[{warehouse_id:'w1',storeId:'s1'},{warehouse_id:'w2',storeId:'s2'}],
    postings:[{posting_number:'historic',storeId:'s2'}]},jobs:{},auditEvents:[]});
function sink(){const calls=[];return {calls,async query(sql,params=[]){calls.push({sql,params});return {rows:[],rowCount:1};}};}

test('saving a pricing setting does not rewrite accounts, catalogs or historical orders',async()=>{
  const state=fixture();persistence.captureFormalMirrorBaseline(state);state.pricing={margin:'12'};
  const client=sink();await persistence.mirrorStateToRelationalTablesInTransaction(client,state);
  assert.equal(client.calls.length,0);
});
test('a product sync writes and prunes only its changed store, retaining other stores',async()=>{
  const state=fixture();persistence.captureFormalMirrorBaseline(state);state.caches.products[0].price='15.00';
  const client=sink();await persistence.mirrorStateToRelationalTablesInTransaction(client,state);
  const products=client.calls.filter(c=>/INSERT INTO products\b/.test(c.sql));
  assert.equal(products.length,1);assert.equal(products[0].params[1],'s1');
  assert.equal(client.calls.some(c=>/INSERT INTO (orders|accounts|stores)\b/.test(c.sql)),false);
  assert.ok(client.calls.filter(c=>/DELETE FROM (products|warehouses)\b/.test(c.sql)).every(c=>c.params[0]==='s1'));
});
test('product identity lookup is batched instead of querying once per product',async()=>{
  const state=fixture();persistence.captureFormalMirrorBaseline(state);
  state.caches.products=Array.from({length:100},(_,i)=>({storeId:'s1',product_id:String(i+1),sku:String(i+100),price:'12.00'}));
  const client=sink();await persistence.mirrorStateToRelationalTablesInTransaction(client,state);
  assert.equal(client.calls.filter(c=>/SELECT.*(?:id|sku).*FROM products/s.test(c.sql)).length,1);
});
test('explicit key expiry is mirrored and unknown expiry remains unknown',async()=>{
  const state={accounts:[{id:'a',username:'owner'}],stores:[{id:'s1',ownerAccountId:'a',apiKeyCreatedAt:'2026-07-01'}]};
  const client=sink();await persistence.mirrorStateToRelationalTablesInTransaction(client,state);
  assert.equal(client.calls.find(c=>/INSERT INTO stores\b/.test(c.sql)).params[17],null);
});

test('a scoped warehouse snapshot replaces only the target store warehouses',async()=>{
  const state=fixture();persistence.captureFormalMirrorBaseline(state,{includeCatalog:false});
  state.caches.warehouses=[{warehouse_id:'w1-new',storeId:'s1'}];
  const client=sink();await persistence.mirrorStateToRelationalTablesInTransaction(client,state,{
    catalogMutation:{storeId:'s1',kind:'warehouses'},
  });
  assert.equal(client.calls.filter(c=>/INSERT INTO warehouses\b/.test(c.sql)).length,1);
  assert.equal(client.calls.filter(c=>/INSERT INTO products\b/.test(c.sql)).length,0);
  const deletes=client.calls.filter(c=>/DELETE FROM (products|warehouses)\b/.test(c.sql));
  assert.equal(deletes.length,1);assert.match(deletes[0].sql,/DELETE FROM warehouses\b/);
  assert.equal(deletes[0].params[0],'s1');
});

test('a scoped product snapshot replaces only target products and never prunes warehouses',async()=>{
  const state=fixture();persistence.captureFormalMirrorBaseline(state,{includeCatalog:false});
  state.caches.products=[{id:'p1-new',product_id:'1-new',sku:'11-new',storeId:'s1',
    warehouse_stocks:[{warehouse_id:'stock-w1',present:3}]}];
  const client=sink();await persistence.mirrorStateToRelationalTablesInTransaction(client,state,{
    catalogMutation:{storeId:'s1',kind:'products'},
  });
  assert.equal(client.calls.filter(c=>/INSERT INTO products\b/.test(c.sql)).length,1);
  const deletes=client.calls.filter(c=>/DELETE FROM (products|warehouses)\b/.test(c.sql));
  assert.equal(deletes.length,1);assert.match(deletes[0].sql,/DELETE FROM products\b/);
  assert.equal(deletes[0].params[0],'s1');
  assert.equal(client.calls.some(c=>c.params?.[0]==='s2' && /(?:INSERT|DELETE).*\b(products|warehouses)\b/s.test(c.sql)),false);
});
