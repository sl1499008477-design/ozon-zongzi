import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {getPostgresPool,closePostgresPool} from '../db/connection.mjs';
import {createCollectorTask,updateCollectorTask,queueCollectorTaskRun,getCollectorTaskForAccount} from '../collector-desktop-service.mjs';
import {createSalePricingProfiles} from '../sale-pricing-profiles.mjs';

test('collector creation, editing, run and failed-only retry use the correct frozen pricing', {skip:process.env.SONLI_POSTGRES_TESTS!=='1'},async()=>{
 const accountId='pricing-collector-'+randomUUID(),otherAccountId='pricing-other-'+randomUUID();let pool;
 try{
  assert.ok(process.env.SONLI_MIGRATION_TEST_DATABASE_URL);
  assert.ok(!['/postgres','/sonli_local','/template0','/template1'].includes(new URL(process.env.DATABASE_URL).pathname));
  await getCollectorTaskForAccount(accountId,'missing'); // Exercises all migrations against the isolated test database.
  pool=await getPostgresPool();
  await pool.query("INSERT INTO accounts(id,username,role) VALUES($1,$1,'user'),($2,$2,'user')",[accountId,otherAccountId]);
  const profiles=createSalePricingProfiles(pool);
  let profile=await profiles.save(accountId,null,{name:'original',currency:'CNY',realPriceFormula:'黑标价',salePriceFormula:'真实售价 * 2'});
  const configuration={autoSendToAiListing:true,autoStartAiGeneration:true,aiListingConfigSnapshot:{id:'preset',config:{salePricingId:profile.id,salePricingUpdatedAt:profile.updatedAt}}};
  const original=await createCollectorTask({accountId,taskType:'MARKET',configuration});
  const run=(await queueCollectorTaskRun({accountId,taskId:original.id})).run;
  assert.equal(run.configurationSnapshot.configuration.aiListingConfigSnapshot.config.salePricing.salePriceFormula,'真实售价 * 2');
  await pool.query("UPDATE collector_task_runs SET status='FAILED' WHERE id=$1",[run.id]);
  await pool.query("UPDATE collector_tasks SET status='FAILED' WHERE id=$1",[original.id]);
  profile=await profiles.save(accountId,profile.id,{...profile,salePriceFormula:'真实售价 * 3'});
  const edited=await updateCollectorTask({accountId,taskId:original.id,patch:{configuration:{...configuration,aiListingConfigSnapshot:{id:'preset',config:{salePricingId:profile.id,salePricingUpdatedAt:profile.updatedAt}}}}});
  assert.equal(edited.configuration.aiListingConfigSnapshot.config.salePricing.salePriceFormula,'真实售价 * 3');
  const retryInput={accountId,taskType:'MARKET',configuration:{...run.configurationSnapshot.configuration,retryFromRunId:run.id}};
  const retry=await createCollectorTask(retryInput);
  assert.equal(retry.configuration.aiListingConfigSnapshot.config.salePricing.salePriceFormula,'真实售价 * 2');
  await profiles.remove(accountId,profile.id);
  const deletedRetry=await createCollectorTask({...retryInput,configuration:{retryFromRunId:run.id,aiListingConfigSnapshot:{config:{salePricing:{salePriceFormula:'1'}}}}});
  assert.deepEqual(deletedRetry.configuration.aiListingConfigSnapshot,run.configurationSnapshot.configuration.aiListingConfigSnapshot);
  await assert.rejects(createCollectorTask({...retryInput,accountId:otherAccountId}),{status:404});
  const retriedRun=(await queueCollectorTaskRun({accountId,taskId:deletedRetry.id})).run;
  assert.equal(retriedRun.configurationSnapshot.configuration.aiListingConfigSnapshot.config.salePricing.salePriceFormula,'真实售价 * 2');
  const legacy=await createCollectorTask({accountId,taskType:'MARKET',configuration:{aiListingConfigSnapshot:{config:{priceMultiplier:'5',priceAdjustmentKopecks:-1000}}}});
  const legacyRun=(await queueCollectorTaskRun({accountId,taskId:legacy.id})).run;
  await pool.query("UPDATE collector_task_runs SET status='FAILED' WHERE id=$1",[legacyRun.id]);
  const legacyRetry=await createCollectorTask({...retryInput,configuration:{retryFromRunId:legacyRun.id,salePricingId:profile.id}});
  assert.deepEqual(legacyRetry.configuration.aiListingConfigSnapshot,legacyRun.configurationSnapshot.configuration.aiListingConfigSnapshot);
 }finally{
  if(pool){
   await pool.query('UPDATE collector_tasks SET current_run_id=NULL WHERE account_id=ANY($1::text[])',[[accountId,otherAccountId]]);
   await pool.query('DELETE FROM collector_task_runs WHERE account_id=ANY($1::text[])',[[accountId,otherAccountId]]);
   await pool.query('DELETE FROM collector_tasks WHERE account_id=ANY($1::text[])',[[accountId,otherAccountId]]);
   await pool.query('DELETE FROM pricing_config_versions WHERE scope_id=ANY($1::text[])',[[accountId,otherAccountId]]);
   await pool.query('DELETE FROM accounts WHERE id=ANY($1::text[])',[[accountId,otherAccountId]]);
  }
  await closePostgresPool();
 }
});
