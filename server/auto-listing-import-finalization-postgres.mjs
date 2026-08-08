const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;

function finalizationError(code, status = 422, retryable = false) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  return error;
}

function id(value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(result)) throw finalizationError("AUTO_LISTING_IMPORT_FINALIZATION_INVALID");
  return result;
}

function integer(value, { min = 0, max = 2_147_483_646 } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw finalizationError("AUTO_LISTING_IMPORT_FINALIZATION_INVALID");
  }
  return value;
}

function mapFile(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id, accountId: row.account_id, status: row.status,
    statusVersion: Number(row.status_version), acceptedRows: Number(row.accepted_rows),
    readyRows: Number(row.ready_rows), failedRows: Number(row.failed_rows),
    generatedJobId: row.generated_job_id || null,
  });
}

function links(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw finalizationError("AUTO_LISTING_IMPORT_FINALIZATION_INVALID");
  }
  const output = value.map((entry) => ({ rowId: id(entry?.rowId), itemId: id(entry?.itemId) }));
  if (new Set(output.map((entry) => entry.rowId)).size !== output.length
    || new Set(output.map((entry) => entry.itemId)).size !== output.length) {
    throw finalizationError("AUTO_LISTING_IMPORT_FINALIZATION_INVALID");
  }
  return output;
}

function sameLinks(rows, expected, accountId, jobId) {
  if (!Array.isArray(rows) || rows.length !== expected.length) return false;
  const found = new Map();
  for (const row of rows) {
    if (row.account_id !== accountId || row.job_id !== jobId || row.source_type !== "EXCEL_SKU"
      || found.has(row.source_record_id)) return false;
    found.set(row.source_record_id, row.item_id);
  }
  return expected.every((entry) => found.get(entry.rowId) === entry.itemId);
}

async function rollback(client) {
  try { await client.query("ROLLBACK"); } catch { /* best effort */ }
}

export function createPostgresAutoListingImportFinalizationRepository({ pool } = {}) {
  if (typeof pool?.query !== "function" || typeof pool?.connect !== "function") {
    throw finalizationError("AUTO_LISTING_IMPORT_FINALIZATION_INVALID");
  }

  async function transaction(work) {
    let client;
    try { client = await pool.connect(); } catch {
      throw finalizationError("AUTO_LISTING_IMPORT_FINALIZATION_PERSIST_FAILED", 503, true);
    }
    let committed = false;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '25s'");
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
      const result = await work(client);
      await client.query("COMMIT");
      committed = true;
      return result;
    } catch (error) {
      if (!committed) await rollback(client);
      if (typeof error?.code === "string" && error.code.startsWith("AUTO_LISTING_IMPORT_FINALIZATION_")) throw error;
      throw finalizationError("AUTO_LISTING_IMPORT_FINALIZATION_PERSIST_FAILED", 503, true);
    } finally {
      try { client.release(); } catch { /* best effort */ }
    }
  }

  return Object.freeze({
    async listFinalizableAccountIds(input = {}) {
      const cursor = input.cursor === null || input.cursor === undefined || input.cursor === ""
        ? null : id(input.cursor);
      const limit = integer(input.limit ?? 100, { min: 1, max: 500 });
      let result;
      try {
        result = await pool.query(
          `SELECT DISTINCT account_id FROM auto_listing_import_files
            WHERE ((status='COLLECTING' AND ready_rows+failed_rows=accepted_rows)
                OR (status='QUEUED' AND accepted_rows=0))
              AND ($1::TEXT IS NULL OR account_id>$1)
            ORDER BY account_id LIMIT $2`,
          [cursor, limit],
        );
      } catch {
        throw finalizationError("AUTO_LISTING_IMPORT_FINALIZATION_PERSIST_FAILED", 503, true);
      }
      return Object.freeze((result.rows || []).map((row) => id(row.account_id)));
    },

    async listFinalizableImports(input = {}) {
      const accountId = id(input.accountId);
      const limit = integer(input.limit ?? 20, { min: 1, max: 100 });
      let result;
      try {
        result = await pool.query(
          `SELECT id,account_id,status,status_version,accepted_rows,ready_rows,failed_rows,generated_job_id
             FROM auto_listing_import_files
            WHERE account_id=$1 AND (
              (status='COLLECTING' AND ready_rows+failed_rows=accepted_rows)
              OR (status='QUEUED' AND accepted_rows=0)
            )
            ORDER BY created_at,id LIMIT $2`,
          [accountId, limit],
        );
      } catch {
        throw finalizationError("AUTO_LISTING_IMPORT_FINALIZATION_PERSIST_FAILED", 503, true);
      }
      return Object.freeze((result.rows || []).map((row) => {
        const mapped = mapFile(row);
        if (mapped.accountId !== accountId) {
          throw finalizationError("AUTO_LISTING_IMPORT_FINALIZATION_PERSIST_FAILED", 503, true);
        }
        return mapped;
      }));
    },

    async finalizeWithoutJob(input = {}) {
      const accountId = id(input.accountId);
      const importFileId = id(input.importFileId);
      const expectedStatusVersion = integer(input.expectedStatusVersion);
      return transaction(async (client) => {
        const locked = await client.query(
          `SELECT * FROM auto_listing_import_files
            WHERE account_id=$1 AND id=$2 FOR UPDATE`,
          [accountId, importFileId],
        );
        const file = mapFile(locked.rows?.[0]);
        if (file?.status === "FAILED" && file.generatedJobId === null) {
          return { status: "FAILED", jobId: null, duplicate: true };
        }
        if (!file || file.accountId !== accountId || file.status !== "QUEUED"
          || file.statusVersion !== expectedStatusVersion || file.acceptedRows !== 0
          || file.readyRows !== 0 || file.failedRows !== 0 || file.generatedJobId !== null) {
          throw finalizationError("AUTO_LISTING_IMPORT_FINALIZATION_CONFLICT", 409, true);
        }
        const updated = await client.query(
          `UPDATE auto_listing_import_files
              SET status='FAILED',status_version=status_version+1,
                  last_error_code='AUTO_LISTING_IMPORT_NO_ACCEPTED_SKUS',last_error_safe=NULL,
                  updated_at=statement_timestamp(),completed_at=statement_timestamp()
            WHERE account_id=$1 AND id=$2 AND status='QUEUED' AND status_version=$3
            RETURNING *`,
          [accountId, importFileId, expectedStatusVersion],
        );
        if (updated.rowCount !== 1) throw finalizationError("AUTO_LISTING_IMPORT_FINALIZATION_CONFLICT", 409, true);
        return { status: "FAILED", jobId: null, duplicate: false };
      });
    },

    async finalizeWithJob(input = {}) {
      const accountId = id(input.accountId);
      const importFileId = id(input.importFileId);
      const expectedStatusVersion = integer(input.expectedStatusVersion);
      const jobId = id(input.jobId);
      const itemLinks = links(input.itemLinks);
      return transaction(async (client) => {
        const locked = await client.query(
          `SELECT * FROM auto_listing_import_files
            WHERE account_id=$1 AND id=$2 FOR UPDATE`,
          [accountId, importFileId],
        );
        const file = mapFile(locked.rows?.[0]);
        if (file && ["READY", "PARTIAL"].includes(file.status) && file.generatedJobId === jobId) {
          return { status: file.status, jobId, duplicate: true };
        }
        if (!file || file.accountId !== accountId || file.status !== "COLLECTING"
          || file.statusVersion !== expectedStatusVersion
          || file.readyRows + file.failedRows !== file.acceptedRows
          || file.readyRows !== itemLinks.length || file.readyRows < 1 || file.generatedJobId !== null) {
          throw finalizationError("AUTO_LISTING_IMPORT_FINALIZATION_CONFLICT", 409, true);
        }
        const job = await client.query(
          `SELECT j.id AS job_id,j.account_id,j.source_type,i.id AS item_id,s.source_record_id
             FROM auto_listing_jobs j
             JOIN auto_listing_job_items i ON i.job_id=j.id AND i.account_id=j.account_id
             JOIN auto_listing_source_snapshots s ON s.id=i.snapshot_id AND s.account_id=j.account_id
            WHERE j.account_id=$1 AND j.id=$2
            FOR SHARE OF j,i,s`,
          [accountId, jobId],
        );
        if (!sameLinks(job.rows, itemLinks, accountId, jobId)) {
          throw finalizationError("AUTO_LISTING_IMPORT_FINALIZATION_CONFLICT", 409, true);
        }
        const ready = await client.query(
          `SELECT id,status,auto_listing_item_id FROM auto_listing_import_rows
            WHERE account_id=$1 AND import_file_id=$2 AND status='READY'
            ORDER BY row_number,id FOR UPDATE`,
          [accountId, importFileId],
        );
        if (ready.rows.length !== itemLinks.length
          || !itemLinks.every((entry) => ready.rows.some((row) => row.id === entry.rowId
            && row.status === "READY" && row.auto_listing_item_id === null))) {
          throw finalizationError("AUTO_LISTING_IMPORT_FINALIZATION_CONFLICT", 409, true);
        }
        const status = file.failedRows === 0 ? "READY" : "PARTIAL";
        const fileUpdated = await client.query(
          `UPDATE auto_listing_import_files
              SET status=$5,status_version=status_version+1,generated_job_id=$4,
                  last_error_code=NULL,last_error_safe=NULL,updated_at=statement_timestamp(),
                  completed_at=statement_timestamp()
            WHERE account_id=$1 AND id=$2 AND status='COLLECTING' AND status_version=$3
            RETURNING *`,
          [accountId, importFileId, expectedStatusVersion, jobId, status],
        );
        if (fileUpdated.rowCount !== 1) throw finalizationError("AUTO_LISTING_IMPORT_FINALIZATION_CONFLICT", 409, true);
        for (const entry of itemLinks) {
          const linked = await client.query(
            `UPDATE auto_listing_import_rows
                SET auto_listing_item_id=$3,status_version=status_version+1,updated_at=statement_timestamp()
              WHERE account_id=$1 AND id=$2 AND import_file_id=$4
                AND status='READY' AND auto_listing_item_id IS NULL
              RETURNING id`,
            [accountId, entry.rowId, entry.itemId, importFileId],
          );
          if (linked.rowCount !== 1) throw finalizationError("AUTO_LISTING_IMPORT_FINALIZATION_CONFLICT", 409, true);
        }
        return { status, jobId, duplicate: false };
      });
    },
  });
}
