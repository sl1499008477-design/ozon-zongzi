import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createPostgresAutoListingImportRecoveryRepository } from "../auto-listing-import-recovery-postgres.mjs";
import { createPostgresAutoListingImportCleanupRepository } from "../auto-listing-import-cleanup-postgres.mjs";

const connectionString = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
const enabled = process.env.AUTO_LISTING_POSTGRES_TESTS === "1" && Boolean(connectionString);
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;

if (!enabled) {
  test("import recovery PostgreSQL concurrency requires explicit disposable database opt-in", {
    skip: "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  }, () => {});
} else {
  test("PostgreSQL permits only one immutable retry successor across concurrent command keys", {
    timeout: 60_000,
  }, async () => {
    const { Pool } = await import("pg");
    const bootstrapPool = new Pool({ connectionString });
    const bootstrap = await bootstrapPool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `auto_listing_import_recovery_042_${suffix}`;
    const accountId = `account-${suffix}`;
    const importId = `import-${suffix}`;
    try {
      await bootstrap.query(`CREATE SCHEMA ${quote(schema)}`);
      await bootstrap.query(`SET search_path TO ${quote(schema)}, public`);
      const migrations = (await readdir(migrationsDir))
        .filter((file) => /^\d{3}_.+\.sql$/u.test(file) && Number(file.slice(0, 3)) <= 42)
        .sort();
      for (const migration of migrations) {
        await bootstrap.query(await readFile(path.join(migrationsDir, migration), "utf8"));
      }
      await bootstrap.query(
        "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
        [accountId, `user-${suffix}`],
      );
      const now = "2026-08-08T00:00:00.000Z";
      await bootstrap.query(
        `INSERT INTO auto_listing_import_files (
           id,account_id,source_file_name,source_content_type,source_size_bytes,file_hash,object_key,
           worksheet_name,total_rows,accepted_rows,rejected_rows,duplicate_rows,ready_rows,failed_rows,
           status,status_version,config_snapshot,config_hash,idempotency_key,created_by,correlation_id,
           created_at,updated_at,completed_at
         ) VALUES ($1,$2,'skus.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',10,
                   $3,$4,'SKU',1,1,0,0,0,0,'RECEIVED',0,'{}'::JSONB,$5,'initial',$2,'initial-corr',$6,$6,NULL)`,
        [importId, accountId, "a".repeat(64),
          `auto-listing/imports/v1/${accountId}/${importId}/workbook.xlsx`, "b".repeat(64), now],
      );
      await bootstrap.query(
        `INSERT INTO auto_listing_import_rows (
           id,account_id,import_file_id,row_number,raw_sku,normalized_sku,status,status_version,
           attempt_count,created_at,updated_at,completed_at
         ) VALUES ($1,$2,$3,2,'SKU-1','SKU-1','PENDING',0,0,$4,$4,NULL)`,
        [`row-${suffix}`, accountId, importId, now],
      );
      await bootstrap.query(
        "UPDATE auto_listing_import_files SET status='QUEUED',status_version=1,updated_at=updated_at WHERE account_id=$1 AND id=$2",
        [accountId, importId],
      );
      await bootstrap.query(
        "UPDATE auto_listing_import_files SET status='COLLECTING',status_version=2,updated_at=updated_at WHERE account_id=$1 AND id=$2",
        [accountId, importId],
      );
      await bootstrap.query(
        `UPDATE auto_listing_import_rows
            SET status='FAILED',status_version=1,last_error_code='OZON_SKU_COLLECTION_FAILED',completed_at=$3
          WHERE account_id=$1 AND import_file_id=$2`,
        [accountId, importId, now],
      );
      await bootstrap.query(
        `UPDATE auto_listing_import_files
            SET status='PARTIAL',status_version=3,failed_rows=1,completed_at=$3,updated_at=$3
          WHERE account_id=$1 AND id=$2`,
        [accountId, importId, now],
      );

      const scopedPool = new Pool({ connectionString, options: `-c search_path=${schema},public` });
      try {
        const repository = createPostgresAutoListingImportRecoveryRepository({ pool: scopedPool });
        const settled = await Promise.allSettled([
          repository.retryFailedRows({ accountId, actorId: accountId, importId, expectedStatusVersion: 3,
            idempotencyKey: `retry-a-${suffix}`, correlationId: `corr-a-${suffix}` }),
          repository.retryFailedRows({ accountId, actorId: accountId, importId, expectedStatusVersion: 3,
            idempotencyKey: `retry-b-${suffix}`, correlationId: `corr-b-${suffix}` }),
        ]);
        assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
        const rejected = settled.find((result) => result.status === "rejected");
        assert.equal(rejected?.reason?.code, "AUTO_LISTING_IMPORT_ALREADY_RETRIED");
        const evidence = await bootstrap.query(
          `SELECT command.retry_import_file_id,row.retry_source_row_id
             FROM auto_listing_import_retry_commands AS command
             JOIN auto_listing_import_rows AS row
               ON row.account_id=command.account_id AND row.import_file_id=command.retry_import_file_id
            WHERE command.account_id=$1 AND command.import_file_id=$2`,
          [accountId, importId],
        );
        assert.equal(evidence.rows.length, 1);
        assert.equal(evidence.rows[0].retry_source_row_id, `row-${suffix}`);

        const cleanupRepository = createPostgresAutoListingImportCleanupRepository({ pool: scopedPool,
          token: () => `lease-${suffix}` });
        const cleanup = await cleanupRepository.enqueueObjectCleanup({
          accountId, importId,
          objectKey: `auto-listing/imports/v1/${accountId}/${importId}/workbook.xlsx`,
          reasonCode: "AUTO_LISTING_IMPORT_ORPHANED_WORKBOOK",
        });
        assert.deepEqual(await cleanupRepository.listRunnableCleanupAccountIds({
          afterAccountId: null, limit: 100,
        }), [accountId]);
        const [claimed] = await cleanupRepository.claimObjectCleanup({
          accountId, workerId: `worker-${suffix}`, limit: 1, leaseMs: 60_000,
        });
        assert.equal(claimed.id, cleanup.id);
        const cleanupDecision = await cleanupRepository.prepareObjectCleanup({
          accountId, id: cleanup.id, workerId: `worker-${suffix}`, leaseToken: claimed.leaseToken,
        });
        assert.equal(cleanupDecision.deleteRequired, false);
        assert.equal(cleanupDecision.cleanup.status, "COMPLETED");

        const orphanImportId = `orphan-${suffix}`;
        const orphan = await cleanupRepository.enqueueObjectCleanup({
          accountId, importId: orphanImportId,
          objectKey: `auto-listing/imports/v1/${accountId}/${orphanImportId}/workbook.xlsx`,
          reasonCode: "AUTO_LISTING_IMPORT_ORPHANED_WORKBOOK",
        });
        const [claimedOrphan] = await cleanupRepository.claimObjectCleanup({
          accountId, workerId: `worker-${suffix}`, limit: 1, leaseMs: 60_000,
        });
        assert.equal(claimedOrphan.id, orphan.id);
        const orphanDecision = await cleanupRepository.prepareObjectCleanup({
          accountId, id: orphan.id, workerId: `worker-${suffix}`, leaseToken: claimedOrphan.leaseToken,
        });
        assert.equal(orphanDecision.deleteRequired, true);
        assert.equal(orphanDecision.cleanup.status, "PROCESSING");
        assert.equal((await cleanupRepository.completeObjectCleanup({ accountId, id: orphan.id,
          workerId: `worker-${suffix}`, leaseToken: claimedOrphan.leaseToken })).status, "COMPLETED");
      } finally {
        await scopedPool.end();
      }
    } finally {
      try { await bootstrap.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`); } catch { /* best effort */ }
      bootstrap.release();
      await bootstrapPool.end();
    }
  });

  test("migration 042 backfills valid history and rejects duplicates or non-failed sources before DDL", {
    timeout: 60_000,
  }, async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString });
    const client = await pool.connect();
    for (const { childCount, sourceFailed } of [
      { childCount: 1, sourceFailed: true },
      { childCount: 2, sourceFailed: true },
      { childCount: 1, sourceFailed: false },
    ]) {
      const suffix = crypto.randomUUID().replaceAll("-", "");
      const schema = `auto_listing_import_upgrade_042_${suffix}`;
      const accountId = `account-${suffix}`;
      const parentId = `parent-${suffix}`;
      const now = "2026-08-08T00:00:00.000Z";
      try {
        await client.query(`CREATE SCHEMA ${quote(schema)}`);
        await client.query(`SET search_path TO ${quote(schema)}, public`);
        const migrations = (await readdir(migrationsDir))
          .filter((file) => /^\d{3}_.+\.sql$/u.test(file) && Number(file.slice(0, 3)) <= 41)
          .sort();
        for (const migration of migrations) {
          await client.query(await readFile(path.join(migrationsDir, migration), "utf8"));
        }
        await client.query(
          "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
          [accountId, `user-${suffix}`],
        );
        const insertReceived = async ({ id, idempotencyKey, retryOfImportId = null }) => client.query(
          `INSERT INTO auto_listing_import_files (
             id,account_id,source_file_name,source_content_type,source_size_bytes,file_hash,object_key,
             worksheet_name,total_rows,accepted_rows,rejected_rows,duplicate_rows,ready_rows,failed_rows,
             status,status_version,config_snapshot,config_hash,idempotency_key,created_by,correlation_id,
             retry_of_import_id,created_at,updated_at,completed_at
           ) VALUES ($1,$2,'skus.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',10,
                     $3,$4,'SKU',1,1,0,0,0,0,'RECEIVED',0,'{}'::JSONB,$5,$6,$2,$7,$8,$9,$9,NULL)`,
          [id, accountId, "a".repeat(64),
            `auto-listing/imports/v1/${accountId}/${parentId}/workbook.xlsx`, "b".repeat(64),
            idempotencyKey, `corr-${id}`, retryOfImportId, now],
        );
        await insertReceived({ id: parentId, idempotencyKey: `parent-key-${suffix}` });
        const sourceRowId = `source-row-${suffix}`;
        await client.query(
          `INSERT INTO auto_listing_import_rows (
             id,account_id,import_file_id,row_number,raw_sku,normalized_sku,status,status_version,
             attempt_count,created_at,updated_at,completed_at
           ) VALUES ($1,$2,$3,2,' SKU-1 ','SKU-1','PENDING',0,0,$4,$4,NULL)`,
          [sourceRowId, accountId, parentId, now],
        );
        await client.query("UPDATE auto_listing_import_files SET status='QUEUED',status_version=1 WHERE account_id=$1 AND id=$2", [accountId, parentId]);
        await client.query("UPDATE auto_listing_import_files SET status='COLLECTING',status_version=2 WHERE account_id=$1 AND id=$2", [accountId, parentId]);
        if (sourceFailed) {
          await client.query("UPDATE auto_listing_import_rows SET status='FAILED',status_version=1,last_error_code='OZON_SKU_COLLECTION_FAILED',completed_at=$3 WHERE account_id=$1 AND id=$2", [accountId, sourceRowId, now]);
        }
        await client.query("UPDATE auto_listing_import_files SET status='PARTIAL',status_version=3,failed_rows=1,completed_at=$3 WHERE account_id=$1 AND id=$2", [accountId, parentId, now]);

        for (let index = 1; index <= childCount; index += 1) {
          const childId = `child-${index}-${suffix}`;
          const childRowId = `child-row-${index}-${suffix}`;
          await insertReceived({ id: childId, idempotencyKey: `child-key-${index}-${suffix}`, retryOfImportId: parentId });
          await client.query(
            `INSERT INTO auto_listing_import_rows (
               id,account_id,import_file_id,row_number,raw_sku,normalized_sku,status,status_version,
               attempt_count,created_at,updated_at,completed_at
             ) VALUES ($1,$2,$3,2,' SKU-1 ','SKU-1','PENDING',0,0,$4,$4,NULL)`,
            [childRowId, accountId, childId, now],
          );
          await client.query("UPDATE auto_listing_import_files SET status='QUEUED',status_version=1 WHERE account_id=$1 AND id=$2", [accountId, childId]);
          await client.query("UPDATE auto_listing_import_files SET status='COLLECTING',status_version=2 WHERE account_id=$1 AND id=$2", [accountId, childId]);
          await client.query("UPDATE auto_listing_import_rows SET status='FAILED',status_version=1,last_error_code='OZON_SKU_COLLECTION_FAILED',completed_at=$3 WHERE account_id=$1 AND id=$2", [accountId, childRowId, now]);
          await client.query("UPDATE auto_listing_import_files SET status='PARTIAL',status_version=3,failed_rows=1,completed_at=$3 WHERE account_id=$1 AND id=$2", [accountId, childId, now]);
          await client.query(
            `INSERT INTO auto_listing_import_retry_commands (
               id,account_id,import_file_id,retry_import_file_id,expected_status_version,idempotency_key,
               correlation_id,actor_id,retried_row_count,created_at
             ) VALUES ($1,$2,$3,$4,3,$5,$6,$2,1,$7)`,
            [`command-${index}-${suffix}`, accountId, parentId, childId,
              `retry-${index}-${suffix}`, `corr-${index}-${suffix}`, now],
          );
        }

        const migration042 = await readFile(path.join(migrationsDir, "042_auto_listing_import_retry_lineage.sql"), "utf8");
        if (childCount === 1 && sourceFailed) {
          await client.query(migration042);
          const lineage = await client.query(
            `SELECT row.retry_source_row_id,audit.source_row_id
               FROM auto_listing_import_rows AS row
               JOIN auto_listing_import_retry_lineage_backfill_audit AS audit
                 ON audit.account_id=row.account_id AND audit.child_row_id=row.id
              WHERE row.account_id=$1 AND row.import_file_id=$2`,
            [accountId, `child-1-${suffix}`],
          );
          assert.deepEqual(lineage.rows, [{ retry_source_row_id: sourceRowId, source_row_id: sourceRowId }]);
        } else if (childCount === 2) {
          await assert.rejects(client.query(migration042), (error) => error?.code === "P4202"
            && error?.message === "AUTO_LISTING_IMPORT_RETRY_HISTORY_CONFLICT"
            && /approved tenant-scoped history repair/iu.test(error?.hint || ""));
          const preserved = await client.query(
            "SELECT COUNT(*)::INTEGER AS count FROM auto_listing_import_files WHERE account_id=$1 AND retry_of_import_id=$2",
            [accountId, parentId],
          );
          assert.equal(preserved.rows[0].count, 2);
        } else {
          await assert.rejects(client.query(migration042), (error) => error?.code === "P4203"
            && error?.message === "AUTO_LISTING_IMPORT_RETRY_LINEAGE_SOURCE_INVALID"
            && /approved tenant-scoped procedure/iu.test(error?.hint || ""));
          const ddl = await client.query(
            `SELECT COUNT(*)::INTEGER AS count
               FROM information_schema.columns
              WHERE table_schema=$1 AND table_name='auto_listing_import_rows'
                AND column_name='retry_source_row_id'`,
            [schema],
          );
          assert.equal(ddl.rows[0].count, 0);
          const audit = await client.query("SELECT to_regclass($1) AS relation", [
            `${schema}.auto_listing_import_retry_lineage_backfill_audit`,
          ]);
          assert.equal(audit.rows[0].relation, null);
        }
      } finally {
        try { await client.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`); } catch { /* best effort */ }
      }
    }
    client.release();
    await pool.end();
  });
}
