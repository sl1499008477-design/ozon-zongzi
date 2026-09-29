import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createAccountOzonRouteService,pinOzonCredential} from '../account-ozon-route.mjs';
import {readStoreCredentialV3} from '../listing-pipeline.mjs';
import {encryptSecret} from '../crypto-secrets.mjs';
import {callOzonSellerApi} from '../ozon-client.mjs';

test('migration preserves started requests; account CAS and credential selection survive service recreation', {skip:process.env.SONLI_POSTGRES_TESTS!=='1'},async()=>{
 assert.ok(process.env.SONLI_MIGRATION_TEST_DATABASE_URL);assert.match(new URL(process.env.DATABASE_URL).hostname,/^(127\.0\.0\.1|localhost)$/);
 const schema='route_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:process.env.DATABASE_URL});let pool;
 const fetchBefore=globalThis.fetch,urls=[];globalThis.fetch=async url=>{urls.push(url);return new Response('{}');};
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`});
  await pool.query(`CREATE TABLE accounts(id TEXT PRIMARY KEY);INSERT INTO accounts VALUES('a'),('b');
   CREATE TABLE stores(id TEXT PRIMARY KEY,owner_account_id TEXT,client_id TEXT,status TEXT);
   INSERT INTO stores VALUES('sa','a','client-a','active'),('sb','b','client-b','active');
   CREATE TABLE store_credentials(store_id TEXT,encrypted_api_key TEXT,iv TEXT,auth_tag TEXT,algorithm TEXT,key_version TEXT);
   CREATE TABLE submission_jobs(id TEXT,status TEXT);INSERT INTO submission_jobs VALUES('queued','QUEUED'),('sent','CHECKING');
   CREATE TABLE ozon_promotion_runs(status TEXT,body JSONB);INSERT INTO ozon_promotion_runs VALUES('UNCERTAIN','{}'),
    ('QUEUED','{"case":"not-sent","items":[{"status":"PLANNED"}]}'),
    ('QUEUED','{"case":"partial-success","items":[{"status":"SUCCEEDED"},{"status":"PLANNED"}]}'),
    ('QUEUED','{"case":"partial-unknown","items":[{"status":"UNCERTAIN"},{"status":"PLANNED"}]}'),
    ('QUEUED','{"case":"partial-sent","items":[{"status":"SUBMITTED"},{"status":"PLANNED"}]}'),
    ('QUEUED','{"case":"rejected-before-retry","items":[{"status":"FAILED","submittedAt":"2026-09-01T00:00:00Z"},{"status":"PLANNED"}]}');
   CREATE TABLE ozon_stock_changes(status TEXT,body JSONB);INSERT INTO ozon_stock_changes VALUES('RUNNING','{}');
   CREATE TABLE ai_image_listing_submissions(body JSONB);INSERT INTO ai_image_listing_submissions VALUES('{"config":{}}');
   CREATE TABLE ai_image_listing_tasks(body JSONB);INSERT INTO ai_image_listing_tasks VALUES('{"submissionStarted":true,"config":{}}');
   CREATE TABLE ozon_message_records(status TEXT,body JSONB);INSERT INTO ozon_message_records VALUES
    ('PENDING','{"case":"not-sent"}'),('PENDING','{"case":"chat-ready","phase":"CHAT_READY"}'),
    ('PENDING','{"case":"chat-start","phase":"CHAT_START"}'),('PENDING','{"case":"send","phase":"SEND"}'),
    ('PENDING','{"case":"send-time","sendStartedAt":1234}');
   CREATE TABLE ozon_order_management_sync(state JSONB);INSERT INTO ozon_order_management_sync VALUES('{"status":"RUNNING"}');`);
  const secret=encryptSecret('fixture-secret');
  await pool.query('INSERT INTO store_credentials VALUES($1,$2,$3,$4,$5,$6),($7,$2,$3,$4,$5,$6)',['sa',secret.ciphertext,secret.iv,secret.authTag,secret.algorithm,secret.keyVersion,'sb']);
  await pool.query(await readFile(new URL('../db/migrations/152_account_ozon_routes.sql',import.meta.url),'utf8'));
  assert.deepEqual((await pool.query('SELECT id,ozon_route FROM submission_jobs ORDER BY id')).rows,[{id:'queued',ozon_route:null},{id:'sent',ozon_route:'LEGACY'}]);
  assert.equal((await pool.query("SELECT body FROM ozon_promotion_runs WHERE status='UNCERTAIN'")).rows[0].body.ozonRoute,'LEGACY');
  assert.equal((await pool.query('SELECT body FROM ozon_stock_changes')).rows[0].body.ozonRoute,'LEGACY');
  const migratedPromotions=(await pool.query("SELECT body FROM ozon_promotion_runs WHERE status='QUEUED'")).rows;
  for(const {body} of migratedPromotions)assert.equal(body.ozonRoute,body.case==='not-sent'?undefined:'LEGACY',body.case);
  const migratedMessages=(await pool.query('SELECT body FROM ozon_message_records')).rows;
  for(const {body} of migratedMessages)assert.equal(body.ozonRoute,body.case==='not-sent'?undefined:'LEGACY',body.case);
  for(const table of ['ai_image_listing_submissions','ai_image_listing_tasks'])assert.equal((await pool.query(`SELECT body FROM ${table}`)).rows[0].body.config.ozonRoute,'LEGACY');
  const service=createAccountOzonRouteService({pool});
  assert.equal((await service.read('a')).route,'CN');
  assert.equal((await readStoreCredentialV3('sa','b',pool)),null);
  const initial=await readStoreCredentialV3('sa','a',pool),journal={};
  assert.equal(initial.ozonRoute,'CN');assert.equal(initial.apiKey,'fixture-secret');
  pinOzonCredential(initial,journal);await callOzonSellerApi(initial,'/first',{});
  const saved=await service.save('a',{route:'RU',revision:0});assert.equal(saved.revision,1);
  const again=createAccountOzonRouteService({pool});assert.equal((await again.read('a')).route,'RU');assert.equal((await again.read('b')).route,'CN');
  const current=await readStoreCredentialV3('sa','a',pool);assert.equal(current.ozonRoute,'RU');
  await callOzonSellerApi(pinOzonCredential(current,JSON.parse(JSON.stringify(journal))),'/resume',{});
  await callOzonSellerApi(current,'/new',{});
  const results=await Promise.allSettled([again.save('a',{route:'CN',revision:1}),service.save('a',{route:'RU',revision:1})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
  assert.equal((await service.read('a')).revision,2);assert.equal((await service.read('b')).revision,0);
  assert.equal(journal.ozonRoute,'CN');
  assert.deepEqual(urls,['https://api-seller.ozon.ru/first','https://api-seller.ozon.ru/resume','https://api-seller.ozon.ru/new']);
  await pool.query("DELETE FROM accounts WHERE id='a'");assert.equal((await pool.query('SELECT * FROM account_ozon_routes')).rowCount,0);
 }finally{globalThis.fetch=fetchBefore;await pool?.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});

test('new persisted AI tasks freeze the account route when queued and ignore later switches',{skip:process.env.SONLI_POSTGRES_TESTS!=='1'},async()=>{
 const {createAiListingRepository}=await import('../ai-listing-repository.mjs');
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL}),accountId='route-ai-'+randomUUID();
 try{
  await pool.query("INSERT INTO accounts(id,username,role) VALUES($1,$1,'admin')",[accountId]);
  const settings=createAccountOzonRouteService({pool}),repository=createAiListingRepository({pool}),now=Date.now();
  const task=id=>({id,accountId,dedupeKey:id,status:'QUEUED',config:{},sourceId:id,images:[],source:null,nextRunAt:now,createdAt:now,updatedAt:now});
  const first=await repository.create(task(accountId+'-first'));assert.equal(first.config.ozonRoute,'CN');
  await settings.save(accountId,{route:'RU',revision:0});
  assert.equal((await repository.get({accountId,taskId:first.id})).config.ozonRoute,'CN');
  const second=await repository.create(task(accountId+'-second'));assert.equal(second.config.ozonRoute,'RU');
  assert.equal(await repository.get({accountId:'other',taskId:first.id}),null);
 }finally{await pool.query('DELETE FROM accounts WHERE id=$1',[accountId]);await pool.end();}
});
