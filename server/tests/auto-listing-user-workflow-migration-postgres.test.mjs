import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const dedicatedDatabaseUrl = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
const enabled = process.env.AUTO_LISTING_POSTGRES_TESTS === "1" && Boolean(dedicatedDatabaseUrl);
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;

async function rejectsCode(operation, expectedCode) {
  try {
    await operation();
    return false;
  } catch (error) {
    return error?.code === expectedCode;
  }
}

if (!enabled) {
  test("034 PostgreSQL checks require explicit opt-in and a dedicated disposable database", {
    skip: "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  }, () => {});
} else {
  test("034 creates valid scoped foreign keys and enforces import boundaries in disposable PostgreSQL", async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: dedicatedDatabaseUrl });
    const client = await pool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `auto_listing_user_034_${suffix}`;
    const accountA = `account-a-${suffix}`;
    const accountB = `account-b-${suffix}`;
    const storeA = `store-a-${suffix}`;
    const storeB = `store-b-${suffix}`;
    const warehouseA = `warehouse-a-${suffix}`;
    const warehouseB = `warehouse-b-${suffix}`;
    const importA = `import-a-${suffix}`;
    const rowA = `row-a-${suffix}`;
    try {
      await client.query(`CREATE SCHEMA ${quote(schema)}`);
      await client.query(`SET search_path TO ${quote(schema)}, public`);
      const migrations = (await readdir(migrationsDir))
        .filter((file) => /^\d{3}_.+\.sql$/.test(file) && Number(file.slice(0, 3)) <= 34)
        .sort();
      for (const migration of migrations) {
        await client.query(await readFile(path.join(migrationsDir, migration), "utf8"));
      }
      await client.query(await readFile(path.join(migrationsDir, "034_auto_listing_user_workflow.sql"), "utf8"));

      for (const accountId of [accountA, accountB]) {
        await client.query(
          "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
          [accountId, `user-${accountId}`],
        );
      }
      for (const [accountId, storeId, warehouseId, marker] of [
        [accountA, storeA, warehouseA, "a"],
        [accountB, storeB, warehouseB, "b"],
      ]) {
        await client.query(
          "INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id) VALUES ($1,$2,$2,$3,'active',$4)",
          [storeId, `Store ${marker}`, `client-${marker}-${suffix}`, accountId],
        );
        await client.query(
          "INSERT INTO warehouses (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived) VALUES ($1,$2,$3,'FBS','active',TRUE,FALSE)",
          [warehouseId, storeId, `warehouse-${marker}-${suffix}`],
        );
      }
      const snapshotA = `snapshot-a-${suffix}`;
      const autoJobA = `auto-job-a-${suffix}`;
      const autoItemA = `auto-item-a-${suffix}`;
      const snapshotOtherA = `snapshot-other-a-${suffix}`;
      const autoJobOtherA = `auto-job-other-a-${suffix}`;
      const autoItemOtherA = `auto-item-other-a-${suffix}`;
      const snapshotB = `snapshot-b-${suffix}`;
      const autoJobB = `auto-job-b-${suffix}`;
      const autoItemB = `auto-item-b-${suffix}`;
      await client.query(
        `INSERT INTO auto_listing_source_snapshots
           (id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash)
         VALUES ($1,$2,'EXCEL_SKU',$3,'1','{}'::JSONB,$4)`,
        [snapshotA, accountA, `source-${suffix}`, "e".repeat(64)],
      );
      await client.query(
        `INSERT INTO auto_listing_jobs
           (id,account_id,source_type,idempotency_key,config_hash,created_by,correlation_id)
         VALUES ($1,$2,'EXCEL_SKU',$3,$4,$2,$5)`,
        [autoJobA, accountA, `auto-job-${suffix}`, "f".repeat(64), `auto-corr-${suffix}`],
      );
      await client.query(
        `INSERT INTO auto_listing_job_items
           (id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [autoItemA, autoJobA, accountA, snapshotA, storeA, warehouseA],
      );
      for (const [snapshotId, jobId, itemId, accountId, storeId, warehouseId, marker] of [
        [snapshotOtherA, autoJobOtherA, autoItemOtherA, accountA, storeA, warehouseA, "other-a"],
        [snapshotB, autoJobB, autoItemB, accountB, storeB, warehouseB, "b"],
      ]) {
        await client.query(
          `INSERT INTO auto_listing_source_snapshots
             (id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash)
           VALUES ($1,$2,'EXCEL_SKU',$3,'1','{}'::JSONB,$4)`,
          [snapshotId, accountId, `source-${marker}-${suffix}`, "e".repeat(64)],
        );
        await client.query(
          `INSERT INTO auto_listing_jobs
             (id,account_id,source_type,idempotency_key,config_hash,created_by,correlation_id)
           VALUES ($1,$2,'EXCEL_SKU',$3,$4,$2,$5)`,
          [jobId, accountId, `auto-job-${marker}-${suffix}`, "f".repeat(64), `auto-corr-${marker}-${suffix}`],
        );
        await client.query(
          `INSERT INTO auto_listing_job_items
             (id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [itemId, jobId, accountId, snapshotId, storeId, warehouseId],
        );
      }
      const collectPrefillA = `collect-prefill-a-${suffix}`;
      await client.query(
        `INSERT INTO collect_items (id,account_id,source_sku,status)
         VALUES ($1,$2,'prefill','COLLECTED')`,
        [collectPrefillA, accountA],
      );

      await client.query(
        `INSERT INTO auto_listing_preferences (
           account_id,target_store_id,target_warehouse_id,stock,image_config,updated_by
         ) VALUES ($1,$2,$3,5,'{}'::jsonb,$1)`,
        [accountA, storeA, warehouseA],
      );
      const crossAccountPreferenceRejected = await rejectsCode(() => client.query(
        `INSERT INTO auto_listing_preferences (
           account_id,target_store_id,target_warehouse_id,stock,image_config,updated_by
         ) VALUES ($1,$2,$3,5,'{}'::jsonb,$1)`,
        [accountB, storeA, warehouseA],
      ), "23503");
      const crossStoreWarehouseRejected = await rejectsCode(() => client.query(
        "UPDATE auto_listing_preferences SET target_warehouse_id=$2 WHERE account_id=$1",
        [accountA, warehouseB],
      ), "23503");

      const initialFilePrefillRejected = {};
      for (const [column, value] of [
        ["ready_rows", 1],
        ["failed_rows", 1],
        ["generated_job_id", autoJobA],
        ["last_error_code", "FORGED"],
        ["last_error_safe", "forged"],
        ["completed_at", new Date("2026-08-05T00:00:00.000Z")],
      ]) {
        const id = `import-prefill-${column}-${suffix}`;
        initialFilePrefillRejected[column] = await rejectsCode(() => client.query(
          `INSERT INTO auto_listing_import_files (
             id,account_id,source_file_name,source_content_type,source_size_bytes,file_hash,object_key,
             total_rows,accepted_rows,status,config_snapshot,config_hash,idempotency_key,
             created_by,correlation_id,${column}
           ) VALUES ($1,$2,'skus.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
             128,$3,$4,1,1,'RECEIVED','{}'::jsonb,$5,$6,$2,$7,$8)`,
          [id, accountA, "1".repeat(64), `imports/${accountA}/${id}.xlsx`, "2".repeat(64), `idem-${id}`, `corr-${id}`, value],
        ), "23514");
      }

      await client.query(
        `INSERT INTO auto_listing_import_files (
           id,account_id,source_file_name,source_content_type,source_size_bytes,file_hash,object_key,
           total_rows,accepted_rows,duplicate_rows,status,config_snapshot,config_hash,idempotency_key,
           created_by,correlation_id
         ) VALUES ($1,$2,'skus.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
           128,$3,$4,2,1,1,'RECEIVED','{}'::jsonb,$5,$6,$2,$7)`,
        [importA, accountA, "a".repeat(64), `imports/${accountA}/${importA}.xlsx`, "b".repeat(64), `idem-${suffix}`, `corr-${suffix}`],
      );
      await client.query(
        "UPDATE auto_listing_import_files SET status='QUEUED',status_version=1 WHERE account_id=$1 AND id=$2",
        [accountA, importA],
      );
      const importFileEvidenceMutationRejected = await rejectsCode(() => client.query(
        "UPDATE auto_listing_import_files SET file_hash=$3 WHERE account_id=$1 AND id=$2",
        [accountA, importA, "f".repeat(64)],
      ), "23514");
      const importFileTransitionEvidenceMutationRejected = await rejectsCode(() => client.query(
        `UPDATE auto_listing_import_files
            SET status='COLLECTING',status_version=2,object_key=$3
          WHERE account_id=$1 AND id=$2`,
        [accountA, importA, `imports/${accountA}/forged.xlsx`],
      ), "23514");
      const importFileProgressOutsideCollectingRejected = await rejectsCode(() => client.query(
        "UPDATE auto_listing_import_files SET ready_rows=1 WHERE account_id=$1 AND id=$2",
        [accountA, importA],
      ), "23514");
      const initialRowPrefillRejected = {};
      let prefillRowNumber = 10;
      for (const [column, value] of [
        ["attempt_count", 7],
        ["collect_item_id", collectPrefillA],
        ["auto_listing_item_id", autoItemA],
        ["last_error_code", "FORGED"],
        ["last_error_safe", "forged"],
        ["completed_at", new Date("2026-08-05T00:00:00.000Z")],
      ]) {
        prefillRowNumber += 1;
        const id = `row-prefill-${column}-${suffix}`;
        initialRowPrefillRejected[column] = await rejectsCode(() => client.query(
          `INSERT INTO auto_listing_import_rows (
             id,account_id,import_file_id,row_number,raw_sku,normalized_sku,status,${column}
           ) VALUES ($1,$2,$3,$4,$5,$5,'PENDING',$6)`,
          [id, accountA, importA, prefillRowNumber, `prefill-${column}-${suffix}`, value],
        ), "23514");
      }
      const invalidRowWithoutErrorCodeRejected = await rejectsCode(() => client.query(
        `INSERT INTO auto_listing_import_rows (
           id,account_id,import_file_id,row_number,raw_sku,normalized_sku,status,completed_at
         ) VALUES ($1,$2,$3,29,'',NULL,'INVALID_SKU',NOW())`,
        [`row-invalid-without-error-${suffix}`, accountA, importA],
      ), "23514");
      await client.query(
        `INSERT INTO auto_listing_import_rows (
           id,account_id,import_file_id,row_number,raw_sku,normalized_sku,status,last_error_code,completed_at
         ) VALUES ($1,$2,$3,30,'duplicate','duplicate','DUPLICATE_IN_FILE','DUPLICATE_IN_FILE',NOW())`,
        [`row-valid-duplicate-${suffix}`, accountA, importA],
      );
      await client.query(
        `INSERT INTO auto_listing_import_rows (
           id,account_id,import_file_id,row_number,raw_sku,normalized_sku,status,last_error_code,completed_at
         ) VALUES ($1,$2,$3,31,'',NULL,'INVALID_SKU','SKU_COLUMN_MUST_BE_TEXT',NOW())`,
        [`row-valid-invalid-${suffix}`, accountA, importA],
      );
      await client.query(
        `INSERT INTO auto_listing_import_rows (
           id,account_id,import_file_id,row_number,raw_sku,normalized_sku,status
         ) VALUES ($1,$2,$3,2,' offer-ABC_01 ','offer-ABC_01','PENDING')`,
        [rowA, accountA, importA],
      );
      const importRowEvidenceMutationRejected = await rejectsCode(() => client.query(
        "UPDATE auto_listing_import_rows SET normalized_sku='forged' WHERE account_id=$1 AND id=$2",
        [accountA, rowA],
      ), "23514");
      const importRowTransitionEvidenceMutationRejected = await rejectsCode(() => client.query(
        `UPDATE auto_listing_import_rows
            SET status='COLLECTING',status_version=1,raw_sku='forged'
          WHERE account_id=$1 AND id=$2`,
        [accountA, rowA],
      ), "23514");
      const duplicateRow = `row-duplicate-${suffix}`;
      await client.query(
        `INSERT INTO auto_listing_import_rows (
           id,account_id,import_file_id,row_number,raw_sku,normalized_sku,status,last_error_code,completed_at
         ) VALUES ($1,$2,$3,3,'offer-ABC_01','offer-ABC_01','DUPLICATE_IN_FILE','DUPLICATE_IN_FILE',NOW())`,
        [duplicateRow, accountA, importA],
      );
      const duplicateImmutable = await rejectsCode(() => client.query(
        "UPDATE auto_listing_import_rows SET status='CANCELLED' WHERE account_id=$1 AND id=$2",
        [accountA, duplicateRow],
      ), "23514");
      const crossAccountRowRejected = await rejectsCode(() => client.query(
        `INSERT INTO auto_listing_import_rows (
           id,account_id,import_file_id,row_number,raw_sku,normalized_sku,status
         ) VALUES ($1,$2,$3,4,'foreign','foreign','PENDING')`,
        [`row-foreign-${suffix}`, accountB, importA],
      ), "23503");
      const unsafeNormalizedRejected = await rejectsCode(() => client.query(
        `INSERT INTO auto_listing_import_rows (
           id,account_id,import_file_id,row_number,raw_sku,normalized_sku,status
         ) VALUES ($1,$2,$3,4,$4,$4,'PENDING')`,
        [`row-control-${suffix}`, accountA, importA, "bad\nSKU"],
      ), "23514");
      const invisibleNormalizedRejected = await rejectsCode(() => client.query(
        `INSERT INTO auto_listing_import_rows (
           id,account_id,import_file_id,row_number,raw_sku,normalized_sku,status
         ) VALUES ($1,$2,$3,5,$4,$4,'PENDING')`,
        [`row-invisible-${suffix}`, accountA, importA, "bad\u200bSKU"],
      ), "23514");

      await client.query(
        `INSERT INTO collect_items (id,account_id,source_sku,status)
         VALUES ($1,$2,'foreign','COLLECTED')`,
        [`collect-b-${suffix}`, accountB],
      );
      await client.query(
        `INSERT INTO collect_items (id,account_id,source_sku,status)
         VALUES ($1,$2,'ready','COLLECTED')`,
        [`collect-a-${suffix}`, accountA],
      );
      await client.query(
        "UPDATE auto_listing_import_rows SET status='COLLECTING',status_version=1,attempt_count=1 WHERE account_id=$1 AND id=$2",
        [accountA, rowA],
      );
      const crossAccountCollectRejected = await rejectsCode(() => client.query(
        `UPDATE auto_listing_import_rows
            SET status='READY',status_version=2,collect_item_id=$3,completed_at=NOW()
          WHERE account_id=$1 AND id=$2`,
        [accountA, rowA, `collect-b-${suffix}`],
      ), "23503");

      const outboxId = `outbox-${suffix}`;
      await client.query(
        `INSERT INTO auto_listing_source_outbox (
           id,account_id,import_file_id,row_id,event_type,dedupe_key
         ) VALUES ($1,$2,$3,$4,'COLLECT_EXCEL_SKU',$5)`,
        [outboxId, accountA, importA, rowA, `dedupe-${suffix}`],
      );
      await client.query(
        `UPDATE auto_listing_source_outbox
            SET state='PROCESSING',state_version=1,attempts=1,lease_generation=1,
                lease_owner='worker',lease_token='lease',lease_expires_at=NOW()+INTERVAL '1 minute'
          WHERE account_id=$1 AND id=$2`,
        [accountA, outboxId],
      );
      await client.query(
        `UPDATE auto_listing_source_outbox
            SET state='COMPLETED',state_version=2,lease_cas_token='lease',
                lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,completed_at=NOW()
          WHERE account_id=$1 AND id=$2`,
        [accountA, outboxId],
      );
      const terminalOutboxImmutable = await rejectsCode(() => client.query(
        "UPDATE auto_listing_source_outbox SET attempts=attempts+1 WHERE account_id=$1 AND id=$2",
        [accountA, outboxId],
      ), "23514");

      const insertImportFile = async (marker) => {
        const id = `import-${marker}-${suffix}`;
        await client.query(
          `INSERT INTO auto_listing_import_files (
             id,account_id,source_file_name,source_content_type,source_size_bytes,file_hash,object_key,
             status,config_snapshot,config_hash,idempotency_key,created_by,correlation_id
           ) VALUES ($1,$2,'skus.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
             128,$3,$4,'RECEIVED','{}'::jsonb,$5,$6,$2,$7)`,
          [id, accountA, "c".repeat(64), `imports/${accountA}/${id}.xlsx`, "d".repeat(64), `idem-${id}`, `corr-${id}`],
        );
        return id;
      };
      const transitionFile = (id, status, version, terminal = false) => client.query(
        `UPDATE auto_listing_import_files
            SET status=$3,status_version=$4,completed_at=CASE WHEN $5 THEN NOW() ELSE NULL END
          WHERE account_id=$1 AND id=$2`,
        [accountA, id, status, version, terminal],
      );
      for (const terminal of ["READY", "PARTIAL", "BLOCKED", "CANCELLED", "FAILED"]) {
        const id = await insertImportFile(`collecting-${terminal.toLowerCase()}`);
        await transitionFile(id, "QUEUED", 1);
        await transitionFile(id, "COLLECTING", 2);
        await transitionFile(id, terminal, 3, true);
      }
      for (const terminal of ["CANCELLED", "FAILED"]) {
        const receivedId = await insertImportFile(`received-${terminal.toLowerCase()}`);
        await transitionFile(receivedId, terminal, 1, true);
        const queuedId = await insertImportFile(`queued-${terminal.toLowerCase()}`);
        await transitionFile(queuedId, "QUEUED", 1);
        await transitionFile(queuedId, terminal, 2, true);
      }
      const failedFile = await insertImportFile("illegal-reopen");
      await transitionFile(failedFile, "FAILED", 1, true);
      const importFileReopenRejected = await rejectsCode(
        () => transitionFile(failedFile, "RECEIVED", 2, false),
        "23514",
      );
      const importFileJumpRejected = await rejectsCode(
        async () => {
          const id = await insertImportFile("illegal-jump");
          return transitionFile(id, "READY", 1, true);
        },
        "23514",
      );

      let nextRowNumber = 100;
      const insertRow = async (marker, status = "PENDING", completed = false, importFileId = importA) => {
        const id = `row-${marker}-${suffix}`;
        nextRowNumber += 1;
        await client.query(
          `INSERT INTO auto_listing_import_rows (
             id,account_id,import_file_id,row_number,raw_sku,normalized_sku,status,completed_at
           ) VALUES ($1,$2,$3,$4,$5,$5,$6,CASE WHEN $7 THEN NOW() ELSE NULL END)`,
          [id, accountA, importFileId, nextRowNumber, `sku-${marker}-${suffix}`, status, completed],
        );
        return id;
      };
      const transitionRow = (id, status, version, terminal = false) => client.query(
        `UPDATE auto_listing_import_rows
            SET status=$3,status_version=$4,
                attempt_count=attempt_count + CASE WHEN status='PENDING' AND $3='COLLECTING' THEN 1 ELSE 0 END,
                completed_at=CASE WHEN $5 THEN NOW() ELSE NULL END
          WHERE account_id=$1 AND id=$2`,
        [accountA, id, status, version, terminal],
      );
      const acceptedRow = await insertRow("accepted", "ACCEPTED");
      await transitionRow(acceptedRow, "PENDING", 1);
      await transitionRow(acceptedRow, "COLLECTING", 2);
      await transitionRow(acceptedRow, "FAILED", 3, true);
      const acceptedCancelledRow = await insertRow("accepted-cancelled", "ACCEPTED");
      await transitionRow(acceptedCancelledRow, "CANCELLED", 1, true);
      const readyRow = await insertRow("ready");
      await transitionRow(readyRow, "COLLECTING", 1);
      await client.query(
        `UPDATE auto_listing_import_rows
            SET status='READY',status_version=2,collect_item_id=$3,completed_at=NOW()
          WHERE account_id=$1 AND id=$2`,
        [accountA, readyRow, `collect-a-${suffix}`],
      );
      const generatedJobNullLinkRejected = await rejectsCode(() => client.query(
        `UPDATE auto_listing_import_rows
            SET auto_listing_item_id=$3,status_version=3
          WHERE account_id=$1 AND id=$2 AND status='READY' AND status_version=2
            AND auto_listing_item_id IS NULL`,
        [accountA, readyRow, autoItemA],
      ), "23514");

      const linkImportId = await insertImportFile("ready-link");
      const linkRow = await insertRow("ready-link", "PENDING", false, linkImportId);
      await transitionFile(linkImportId, "QUEUED", 1);
      await transitionFile(linkImportId, "COLLECTING", 2);
      await client.query(
        `UPDATE auto_listing_import_files
            SET status='READY',status_version=3,generated_job_id=$3,completed_at=NOW()
          WHERE account_id=$1 AND id=$2`,
        [accountA, linkImportId, autoJobA],
      );
      await transitionRow(linkRow, "COLLECTING", 1);
      await client.query(
        `UPDATE auto_listing_import_rows
            SET status='READY',status_version=2,collect_item_id=$3,completed_at=NOW()
          WHERE account_id=$1 AND id=$2`,
        [accountA, linkRow, `collect-a-${suffix}`],
      );
      const wrongSameAccountJobLinkRejected = await rejectsCode(() => client.query(
        `UPDATE auto_listing_import_rows
            SET auto_listing_item_id=$3,status_version=3
          WHERE account_id=$1 AND id=$2 AND status='READY' AND status_version=2
            AND auto_listing_item_id IS NULL`,
        [accountA, linkRow, autoItemOtherA],
      ), "23514");
      const crossAccountJobLinkRejected = await rejectsCode(() => client.query(
        `UPDATE auto_listing_import_rows
            SET auto_listing_item_id=$3,status_version=3
          WHERE account_id=$1 AND id=$2 AND status='READY' AND status_version=2
            AND auto_listing_item_id IS NULL`,
        [accountA, linkRow, autoItemB],
      ), "23514");
      await client.query(
        `UPDATE auto_listing_import_rows
            SET auto_listing_item_id=$3,status_version=3
          WHERE account_id=$1 AND id=$2 AND status='READY' AND status_version=2
            AND auto_listing_item_id IS NULL`,
        [accountA, linkRow, autoItemA],
      );
      const readyLink = await client.query(
        "SELECT auto_listing_item_id,status_version FROM auto_listing_import_rows WHERE account_id=$1 AND id=$2",
        [accountA, linkRow],
      );
      const readyLinkReplayCount = (await client.query(
        `UPDATE auto_listing_import_rows
            SET auto_listing_item_id=$3,status_version=3
          WHERE account_id=$1 AND id=$2 AND status='READY' AND status_version=2
            AND auto_listing_item_id IS NULL`,
        [accountA, linkRow, autoItemA],
      )).rowCount;
      const readyLinkMutationRejected = await rejectsCode(() => client.query(
        `UPDATE auto_listing_import_rows
            SET auto_listing_item_id=$3,status_version=4
          WHERE account_id=$1 AND id=$2`,
        [accountA, linkRow, autoItemOtherA],
      ), "23514");
      for (const terminal of ["FAILED", "CANCELLED"]) {
        const id = await insertRow(`pending-${terminal.toLowerCase()}`);
        await transitionRow(id, terminal, 1, true);
        const collectingId = await insertRow(`collecting-${terminal.toLowerCase()}`);
        await transitionRow(collectingId, "COLLECTING", 1);
        await transitionRow(collectingId, terminal, 2, true);
      }
      const failedRow = await insertRow("illegal-row-reopen");
      await transitionRow(failedRow, "FAILED", 1, true);
      const importRowReopenRejected = await rejectsCode(
        () => transitionRow(failedRow, "PENDING", 2),
        "23514",
      );
      const importRowJumpRejected = await rejectsCode(
        async () => {
          const id = await insertRow("illegal-row-jump");
          return transitionRow(id, "READY", 1, true);
        },
        "23514",
      );

      const insertOutbox = async (marker, rowId = null) => {
        const id = `outbox-${marker}-${suffix}`;
        const sourceRowId = rowId || await insertRow(`source-${marker}`);
        await client.query(
          `INSERT INTO auto_listing_source_outbox (
             id,account_id,import_file_id,row_id,event_type,dedupe_key
           ) VALUES ($1,$2,$3,$4,'COLLECT_EXCEL_SKU',$5)`,
          [id, accountA, importA, sourceRowId, `dedupe-${id}`],
        );
        return id;
      };
      const infiniteLeaseOutboxId = await insertOutbox("infinite-lease");
      const infiniteLeaseRejected = await rejectsCode(() => client.query(
        `UPDATE auto_listing_source_outbox
            SET state='PROCESSING',state_version=1,attempts=1,lease_generation=1,
                lease_owner='worker',lease_token='infinite',lease_expires_at='infinity'::timestamptz
          WHERE account_id=$1 AND id=$2`,
        [accountA, infiniteLeaseOutboxId],
      ), "23514");
      const farLeaseOutboxId = await insertOutbox("far-lease");
      const farFutureLeaseRejected = await rejectsCode(() => client.query(
        `UPDATE auto_listing_source_outbox
            SET state='PROCESSING',state_version=1,attempts=1,lease_generation=1,
                lease_owner='worker',lease_token='far',lease_expires_at=statement_timestamp()+INTERVAL '5 minutes 1 millisecond'
          WHERE account_id=$1 AND id=$2`,
        [accountA, farLeaseOutboxId],
      ), "23514");
      const pastLeaseOutboxId = await insertOutbox("past-lease");
      const pastLeaseRejected = await rejectsCode(() => client.query(
        `UPDATE auto_listing_source_outbox
            SET state='PROCESSING',state_version=1,attempts=1,lease_generation=1,
                lease_owner='worker',lease_token='past',lease_expires_at=statement_timestamp()
          WHERE account_id=$1 AND id=$2`,
        [accountA, pastLeaseOutboxId],
      ), "23514");
      const boundaryLeaseOutboxId = await insertOutbox("boundary-lease");
      await client.query(
        `UPDATE auto_listing_source_outbox
            SET state='PROCESSING',state_version=1,attempts=1,lease_generation=1,
                lease_owner='worker',lease_token='boundary',
                lease_expires_at=statement_timestamp()+auto_listing_source_outbox_max_lease_duration()
          WHERE account_id=$1 AND id=$2`,
        [accountA, boundaryLeaseOutboxId],
      );
      await client.query(
        `UPDATE auto_listing_source_outbox
            SET state='COMPLETED',state_version=2,lease_cas_token='boundary',
                lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,completed_at=NOW()
          WHERE account_id=$1 AND id=$2`,
        [accountA, boundaryLeaseOutboxId],
      );
      const staleClockOutboxId = await insertOutbox("stale-clock");
      await client.query("BEGIN");
      await client.query("SELECT NOW()");
      await client.query("SELECT pg_sleep(0.03)");
      const staleTransactionClockRejected = await rejectsCode(() => client.query(
        `UPDATE auto_listing_source_outbox
            SET state='PROCESSING',state_version=1,attempts=1,lease_generation=1,
                lease_owner='worker',lease_token='stale-clock',lease_expires_at=NOW()+INTERVAL '10 milliseconds'
          WHERE account_id=$1 AND id=$2`,
        [accountA, staleClockOutboxId],
      ), "23514");
      await client.query("ROLLBACK");

      const retryRow = await insertRow("retry-recovery");
      const retryOutboxId = await insertOutbox("retry-recovery", retryRow);
      await client.query(
        `UPDATE auto_listing_source_outbox
            SET state='PROCESSING',state_version=1,attempts=1,lease_generation=1,
                lease_owner='worker-a',lease_token='retry-a',lease_expires_at=NOW()+INTERVAL '1 minute'
          WHERE account_id=$1 AND id=$2`,
        [accountA, retryOutboxId],
      );
      await transitionRow(retryRow, "COLLECTING", 1);
      const retryWithoutLeaseRejected = await rejectsCode(() => client.query(
        `UPDATE auto_listing_import_rows
            SET status='PENDING',status_version=2,last_error_code='OZON_TEMPORARY_UNAVAILABLE'
          WHERE account_id=$1 AND id=$2`,
        [accountA, retryRow],
      ), "23514");
      const retryWrongLeaseRejected = await rejectsCode(() => client.query(
        `UPDATE auto_listing_import_rows
            SET status='PENDING',status_version=2,last_error_code='OZON_TEMPORARY_UNAVAILABLE',
                source_lease_cas_token='wrong'
          WHERE account_id=$1 AND id=$2`,
        [accountA, retryRow],
      ), "23514");
      const retryWrongVersionRejected = await rejectsCode(() => client.query(
        `UPDATE auto_listing_import_rows
            SET status='PENDING',status_version=99,last_error_code='OZON_TEMPORARY_UNAVAILABLE',
                source_lease_cas_token='retry-a'
          WHERE account_id=$1 AND id=$2`,
        [accountA, retryRow],
      ), "23514");
      await client.query(
        `UPDATE auto_listing_import_rows
            SET status='PENDING',status_version=2,last_error_code='OZON_TEMPORARY_UNAVAILABLE',
                source_lease_cas_token='retry-a'
          WHERE account_id=$1 AND id=$2`,
        [accountA, retryRow],
      );
      await client.query(
        `UPDATE auto_listing_source_outbox
            SET state='PENDING',state_version=2,lease_cas_token='retry-a',available_at=NOW(),
                lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
                last_error_code='OZON_TEMPORARY_UNAVAILABLE'
          WHERE account_id=$1 AND id=$2`,
        [accountA, retryOutboxId],
      );
      await client.query(
        `UPDATE auto_listing_source_outbox
            SET state='PROCESSING',state_version=3,attempts=2,lease_generation=2,
                lease_owner='worker-b',lease_token='retry-b',lease_expires_at=NOW()+INTERVAL '1 minute'
          WHERE account_id=$1 AND id=$2`,
        [accountA, retryOutboxId],
      );
      await transitionRow(retryRow, "COLLECTING", 3);
      await client.query(
        `UPDATE auto_listing_import_rows
            SET status='READY',status_version=4,collect_item_id=$3,last_error_code=NULL,completed_at=NOW()
          WHERE account_id=$1 AND id=$2`,
        [accountA, retryRow, `collect-a-${suffix}`],
      );
      const recoveredRetryRow = await client.query(
        "SELECT status,status_version,attempt_count,last_error_code FROM auto_listing_import_rows WHERE account_id=$1 AND id=$2",
        [accountA, retryRow],
      );
      const expiredRetryRow = await insertRow("retry-expired");
      const expiredRetryOutboxId = await insertOutbox("retry-expired", expiredRetryRow);
      await client.query(
        `UPDATE auto_listing_source_outbox
            SET state='PROCESSING',state_version=1,attempts=1,lease_generation=1,
                lease_owner='worker-a',lease_token='retry-expired-a',
                lease_expires_at=clock_timestamp()+INTERVAL '10 milliseconds'
          WHERE account_id=$1 AND id=$2`,
        [accountA, expiredRetryOutboxId],
      );
      await transitionRow(expiredRetryRow, "COLLECTING", 1);
      await client.query("SELECT pg_sleep(0.03)");
      const expiredRowLeaseRejected = await rejectsCode(() => client.query(
        `UPDATE auto_listing_import_rows
            SET status='PENDING',status_version=2,last_error_code='OZON_TEMPORARY_UNAVAILABLE',
                source_lease_cas_token='retry-expired-a'
          WHERE account_id=$1 AND id=$2`,
        [accountA, expiredRetryRow],
      ), "23514");
      await client.query(
        `UPDATE auto_listing_source_outbox
            SET state_version=2,attempts=2,lease_generation=2,
                lease_owner='worker-b',lease_token='retry-expired-b',lease_expires_at=NOW()+INTERVAL '1 minute'
          WHERE account_id=$1 AND id=$2`,
        [accountA, expiredRetryOutboxId],
      );
      await client.query(
        `UPDATE auto_listing_import_rows
            SET status='PENDING',status_version=2,last_error_code='OZON_TEMPORARY_UNAVAILABLE',
                source_lease_cas_token='retry-expired-b'
          WHERE account_id=$1 AND id=$2`,
        [accountA, expiredRetryRow],
      );

      const directOutboxCompletionId = await insertOutbox("direct-complete");
      const directOutboxCompletionRejected = await rejectsCode(() => client.query(
        `UPDATE auto_listing_source_outbox
            SET state='COMPLETED',state_version=1,completed_at=NOW()
          WHERE account_id=$1 AND id=$2`,
        [accountA, directOutboxCompletionId],
      ), "23514");

      const leaseOutboxId = await insertOutbox("lease-guards");
      const outboxClaimEvidenceMutationRejected = await rejectsCode(() => client.query(
        `UPDATE auto_listing_source_outbox
            SET state='PROCESSING',state_version=1,attempts=1,lease_generation=1,
                lease_owner='worker-a',lease_token='token-a',lease_expires_at=NOW()+INTERVAL '1 minute',
                dedupe_key='forged-dedupe'
          WHERE account_id=$1 AND id=$2`,
        [accountA, leaseOutboxId],
      ), "23514");
      await client.query(
        `UPDATE auto_listing_source_outbox
            SET state='PROCESSING',state_version=1,attempts=1,lease_generation=1,
                lease_owner='worker-a',lease_token='token-a',lease_expires_at=NOW()+INTERVAL '1 minute'
          WHERE account_id=$1 AND id=$2`,
        [accountA, leaseOutboxId],
      );
      const unexpiredLeaseTheftRejected = await rejectsCode(() => client.query(
        `UPDATE auto_listing_source_outbox
            SET state_version=2,attempts=2,lease_generation=2,
                lease_owner='worker-b',lease_token='token-b',lease_expires_at=NOW()+INTERVAL '1 minute'
          WHERE account_id=$1 AND id=$2`,
        [accountA, leaseOutboxId],
      ), "23514");
      const wrongLeaseTokenRejected = await rejectsCode(() => client.query(
        `UPDATE auto_listing_source_outbox
            SET state='DEAD',state_version=2,lease_cas_token='wrong-token',
                lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,completed_at=NOW()
          WHERE account_id=$1 AND id=$2`,
        [accountA, leaseOutboxId],
      ), "23514");
      await client.query(
        `UPDATE auto_listing_source_outbox
            SET state='PENDING',state_version=2,lease_cas_token='token-a',available_at=NOW(),
                lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
          WHERE account_id=$1 AND id=$2`,
        [accountA, leaseOutboxId],
      );
      await client.query(
        `UPDATE auto_listing_source_outbox
            SET state='PROCESSING',state_version=3,attempts=2,lease_generation=2,
                lease_owner='worker-b',lease_token='token-b',lease_expires_at=NOW()+INTERVAL '1 minute'
          WHERE account_id=$1 AND id=$2`,
        [accountA, leaseOutboxId],
      );
      await client.query(
        `UPDATE auto_listing_source_outbox
            SET state='DEAD',state_version=4,lease_cas_token='token-b',
                lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,completed_at=NOW()
          WHERE account_id=$1 AND id=$2`,
        [accountA, leaseOutboxId],
      );

      const expiredOutboxId = await insertOutbox("expired");
      await client.query(
        `UPDATE auto_listing_source_outbox
            SET state='PROCESSING',state_version=1,attempts=1,lease_generation=1,
                lease_owner='worker-a',lease_token='expired-a',lease_expires_at=clock_timestamp()+INTERVAL '10 milliseconds'
          WHERE account_id=$1 AND id=$2`,
        [accountA, expiredOutboxId],
      );
      await client.query("SELECT pg_sleep(0.03)");
      const infiniteReclaimRejected = await rejectsCode(() => client.query(
        `UPDATE auto_listing_source_outbox
            SET state_version=2,attempts=2,lease_generation=2,
                lease_owner='worker-b',lease_token='expired-infinite',lease_expires_at='infinity'::timestamptz
          WHERE account_id=$1 AND id=$2`,
        [accountA, expiredOutboxId],
      ), "23514");
      await client.query(
        `UPDATE auto_listing_source_outbox
            SET state_version=2,attempts=2,lease_generation=2,
                lease_owner='worker-b',lease_token='expired-b',lease_expires_at=NOW()+INTERVAL '1 minute'
          WHERE account_id=$1 AND id=$2`,
        [accountA, expiredOutboxId],
      );

      const concurrentOutboxId = await insertOutbox("concurrent");
      const claimantA = await pool.connect();
      const claimantB = await pool.connect();
      let concurrentClaimCount;
      try {
        await claimantA.query(`SET search_path TO ${quote(schema)}, public`);
        await claimantB.query(`SET search_path TO ${quote(schema)}, public`);
        const claim = (connection, owner, token) => connection.query(
          `UPDATE auto_listing_source_outbox
              SET state='PROCESSING',state_version=1,attempts=1,lease_generation=1,
                  lease_owner=$3,lease_token=$4,lease_expires_at=NOW()+INTERVAL '1 minute'
            WHERE account_id=$1 AND id=$2 AND state='PENDING' AND state_version=0`,
          [accountA, concurrentOutboxId, owner, token],
        );
        const results = await Promise.all([
          claim(claimantA, "worker-a", "concurrent-a"),
          claim(claimantB, "worker-b", "concurrent-b"),
        ]);
        concurrentClaimCount = results.reduce((sum, result) => sum + result.rowCount, 0);
      } finally {
        claimantA.release();
        claimantB.release();
      }
      const completionReplayCount = (await client.query(
        `UPDATE auto_listing_source_outbox
            SET state='COMPLETED',state_version=3,lease_cas_token='lease',
                lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,completed_at=NOW()
          WHERE account_id=$1 AND id=$2 AND state='PROCESSING' AND lease_token='lease'`,
        [accountA, outboxId],
      )).rowCount;
      const accountMismatchClaimCount = (await client.query(
        `UPDATE auto_listing_source_outbox
            SET state='PROCESSING',state_version=1,attempts=1,lease_generation=1,
                lease_owner='foreign',lease_token='foreign',lease_expires_at=NOW()+INTERVAL '1 minute'
          WHERE account_id=$1 AND id=$2 AND state='PENDING'`,
        [accountB, concurrentOutboxId],
      )).rowCount;

      const unvalidated = await client.query(
        `SELECT c.conname
           FROM pg_constraint c
           JOIN pg_class t ON t.oid=c.conrelid
          WHERE t.relname = ANY($1::text[]) AND c.contype='f' AND c.convalidated=FALSE`,
        [["auto_listing_preferences", "auto_listing_import_files", "auto_listing_import_rows", "auto_listing_source_outbox"]],
      );
      const binaryColumns = await client.query(
        `SELECT table_name,column_name,data_type
           FROM information_schema.columns
          WHERE table_schema=$1
            AND table_name = ANY($2::text[])
            AND (data_type='bytea' OR column_name ~* '(base64|file_bytes|binary|workbook_data)')`,
        [schema, ["auto_listing_import_files", "auto_listing_import_rows"]],
      );

      assert.deepEqual({
        crossAccountPreferenceRejected,
        crossStoreWarehouseRejected,
        initialFilePrefillRejected,
        initialRowPrefillRejected,
        invalidRowWithoutErrorCodeRejected,
        duplicateImmutable,
        crossAccountRowRejected,
        unsafeNormalizedRejected,
        invisibleNormalizedRejected,
        crossAccountCollectRejected,
        terminalOutboxImmutable,
        importFileEvidenceMutationRejected,
        importFileTransitionEvidenceMutationRejected,
        importFileProgressOutsideCollectingRejected,
        importRowEvidenceMutationRejected,
        importRowTransitionEvidenceMutationRejected,
        outboxClaimEvidenceMutationRejected,
        generatedJobNullLinkRejected,
        wrongSameAccountJobLinkRejected,
        crossAccountJobLinkRejected,
        readyLink: readyLink.rows[0],
        readyLinkReplayCount,
        readyLinkMutationRejected,
        importFileReopenRejected,
        importFileJumpRejected,
        importRowReopenRejected,
        importRowJumpRejected,
        directOutboxCompletionRejected,
        unexpiredLeaseTheftRejected,
        wrongLeaseTokenRejected,
        infiniteLeaseRejected,
        farFutureLeaseRejected,
        pastLeaseRejected,
        staleTransactionClockRejected,
        infiniteReclaimRejected,
        retryWithoutLeaseRejected,
        retryWrongLeaseRejected,
        retryWrongVersionRejected,
        expiredRowLeaseRejected,
        recoveredRetryRow: recoveredRetryRow.rows[0],
        concurrentClaimCount,
        completionReplayCount,
        accountMismatchClaimCount,
        allForeignKeysValidated: unvalidated.rowCount === 0,
        noWorkbookBinaryColumns: binaryColumns.rowCount === 0,
      }, {
        crossAccountPreferenceRejected: true,
        crossStoreWarehouseRejected: true,
        initialFilePrefillRejected: {
          ready_rows: true,
          failed_rows: true,
          generated_job_id: true,
          last_error_code: true,
          last_error_safe: true,
          completed_at: true,
        },
        initialRowPrefillRejected: {
          attempt_count: true,
          collect_item_id: true,
          auto_listing_item_id: true,
          last_error_code: true,
          last_error_safe: true,
          completed_at: true,
        },
        invalidRowWithoutErrorCodeRejected: true,
        duplicateImmutable: true,
        crossAccountRowRejected: true,
        unsafeNormalizedRejected: true,
        invisibleNormalizedRejected: true,
        crossAccountCollectRejected: true,
        terminalOutboxImmutable: true,
        importFileEvidenceMutationRejected: true,
        importFileTransitionEvidenceMutationRejected: true,
        importFileProgressOutsideCollectingRejected: true,
        importRowEvidenceMutationRejected: true,
        importRowTransitionEvidenceMutationRejected: true,
        outboxClaimEvidenceMutationRejected: true,
        generatedJobNullLinkRejected: true,
        wrongSameAccountJobLinkRejected: true,
        crossAccountJobLinkRejected: true,
        readyLink: { auto_listing_item_id: autoItemA, status_version: "3" },
        readyLinkReplayCount: 0,
        readyLinkMutationRejected: true,
        importFileReopenRejected: true,
        importFileJumpRejected: true,
        importRowReopenRejected: true,
        importRowJumpRejected: true,
        directOutboxCompletionRejected: true,
        unexpiredLeaseTheftRejected: true,
        wrongLeaseTokenRejected: true,
        infiniteLeaseRejected: true,
        farFutureLeaseRejected: true,
        pastLeaseRejected: true,
        staleTransactionClockRejected: true,
        infiniteReclaimRejected: true,
        retryWithoutLeaseRejected: true,
        retryWrongLeaseRejected: true,
        retryWrongVersionRejected: true,
        expiredRowLeaseRejected: true,
        recoveredRetryRow: {
          status: "READY",
          status_version: "4",
          attempt_count: 2,
          last_error_code: null,
        },
        concurrentClaimCount: 1,
        completionReplayCount: 0,
        accountMismatchClaimCount: 0,
        allForeignKeysValidated: true,
        noWorkbookBinaryColumns: true,
      });
    } finally {
      try {
        await client.query("RESET search_path");
        await client.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
      } finally {
        client.release();
        await pool.end();
      }
    }
  });
}
