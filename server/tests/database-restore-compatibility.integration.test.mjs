import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
test('restored constraints permit the owning account cascade while immutable settings stay protected', {skip:process.env.SONLI_POSTGRES_TESTS!=='1'}, async()=>{
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});const client=await pool.connect();
  const id='audit-restore-'+randomUUID();
  try{await client.query('BEGIN');await client.query("INSERT INTO accounts(id,username,role)VALUES($1,$1,'user')",[id]);
    await client.query('SAVEPOINT immutable_check');
    await assert.rejects(client.query('DELETE FROM auto_listing_category_strategy_account_settings WHERE account_id=$1',[id]),{code:'23514'});
    await client.query('ROLLBACK TO SAVEPOINT immutable_check');
    await client.query('DELETE FROM accounts WHERE id=$1',[id]);await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    assert.equal((await client.query('SELECT 1 FROM auto_listing_category_strategy_account_settings WHERE account_id=$1',[id])).rowCount,0);
    await client.query("SET LOCAL search_path='' ");
    assert.equal((await client.query("SELECT public.auto_listing_ai_runtime_safe_identifier('restore-fixture') AS valid")).rows[0].valid,true);
  }finally{await client.query('ROLLBACK');client.release();await pool.end();}
});
