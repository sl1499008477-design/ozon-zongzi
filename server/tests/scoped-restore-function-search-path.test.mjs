import './support/dedicated-postgres-test-environment.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';

const migrationUrl = new URL('../db/migrations/122_scoped_restore_function_search_path.sql', import.meta.url);
const quote = value => `"${value.replaceAll('"', '""')}"`;

test('122 restores schema-local SQL helpers under an empty restore search_path without touching other signatures', {
  skip: process.env.SONLI_POSTGRES_TESTS !== '1',
}, async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  const suffix = randomUUID().replaceAll('-', '');
  const scoped = `restore "scope ${suffix}`;
  const missing = `restore_missing_${suffix}`;
  const wrongType = `restore_integer_${suffix}`;
  const otherLanguage = `restore_plpgsql_${suffix}`;
  try {
    await client.query('BEGIN');
    const publicBefore = (await client.query("SELECT proconfig FROM pg_proc WHERE oid='public.auto_listing_ai_runtime_safe_identifier(text)'::regprocedure")).rows[0].proconfig;
    for (const schema of [scoped, missing, wrongType, otherLanguage]) {
      await client.query(`CREATE SCHEMA ${quote(schema)}`);
    }
    for (const schema of [scoped, otherLanguage]) {
      await client.query(`CREATE FUNCTION ${quote(schema)}.auto_listing_ai_runtime_is_ip(value text)
        RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT value='blocked-by-local-helper' $$`);
    }
    await client.query(`CREATE FUNCTION ${quote(scoped)}.auto_listing_ai_runtime_safe_identifier(value text)
      RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT NOT auto_listing_ai_runtime_is_ip(value) $$`);
    await client.query(`CREATE FUNCTION ${quote(scoped)}.auto_listing_ai_runtime_safe_identifier(value integer)
      RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT value>0 $$`);
    await client.query(`CREATE FUNCTION ${quote(scoped)}.unrelated_identifier(value text)
      RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT value IS NOT NULL $$`);
    await client.query(`CREATE FUNCTION ${quote(wrongType)}.auto_listing_ai_runtime_is_ip(value integer)
      RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT false $$`);
    for (const schema of [missing, wrongType]) {
      await client.query(`CREATE FUNCTION ${quote(schema)}.auto_listing_ai_runtime_safe_identifier(value text)
        RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT value IS NOT NULL $$`);
    }
    await client.query(`CREATE FUNCTION ${quote(otherLanguage)}.auto_listing_ai_runtime_safe_identifier(value text)
      RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN RETURN value IS NOT NULL; END $$`);
    const functionStates = async () => (await client.query(`SELECT n.nspname AS schema,p.proname AS name,
      pg_get_function_identity_arguments(p.oid) AS arguments,p.prosrc,p.proconfig
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=ANY($1::text[]) ORDER BY n.nspname,p.proname,p.proargtypes`,
    [[scoped, missing, wrongType, otherLanguage]])).rows;
    const before = await functionStates();
    const sql = await readFile(migrationUrl, 'utf8');
    await client.query(sql);

    // Reproduce pg_restore's ordinary empty search_path, never a workaround that
    // supplies a schema to the restore session. The function must supply its own.
    await client.query("SET LOCAL search_path=''");
    await client.query(`CREATE TABLE ${quote(scoped)}.restored_rows (
      value text CHECK (${quote(scoped)}.auto_listing_ai_runtime_safe_identifier(value)))`);
    await assert.doesNotReject(client.query(`INSERT INTO ${quote(scoped)}.restored_rows VALUES ('safe-value')`));
    await client.query('SAVEPOINT local_helper');
    await assert.rejects(client.query(`INSERT INTO ${quote(scoped)}.restored_rows VALUES ('blocked-by-local-helper')`),
      { code: '23514' });
    await client.query('ROLLBACK TO SAVEPOINT local_helper');
    assert.equal((await client.query(`SELECT count(*)::int AS count FROM ${quote(scoped)}.restored_rows`)).rows[0].count, 1);

    const after = await functionStates();
    for (let index = 0; index < before.length; index += 1) {
      const expected = before[index];
      if (expected.schema === scoped && expected.name === 'auto_listing_ai_runtime_safe_identifier'
        && expected.arguments === 'value text') {
        assert.deepEqual(after[index], { ...expected, proconfig: [`search_path=${quote(scoped)}, pg_temp`] });
      } else assert.deepEqual(after[index], expected);
    }
    assert.deepEqual((await client.query("SELECT proconfig FROM pg_proc WHERE oid='public.auto_listing_ai_runtime_safe_identifier(text)'::regprocedure")).rows[0].proconfig,
      publicBefore, 'public keeps migration 120 behavior');
    await client.query(sql);
    assert.deepEqual(await functionStates(), after, 'reapplying 122 is idempotent');
    assert.equal((await client.query(`SELECT count(*)::int AS count FROM ${quote(scoped)}.restored_rows`)).rows[0].count, 1);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
