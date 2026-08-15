import "../env.mjs";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { createPostgresCollectorAuthRepository } from "../collector-auth-repository.mjs";
import { createPostgresAccountSharedOzonCategoryRepository } from "../account-shared-ozon-category-repository.mjs";
import { closePostgresPool, getPostgresPool, postgresEnabled } from "../db/connection.mjs";
import { runMigrations } from "../db/migrate.mjs";
import { readLegacyDataCollectionStoresForAudit } from "../legacy-data-collection-store.mjs";

if (!postgresEnabled()) {
  console.log("account deletion PostgreSQL integration skipped: PostgreSQL is not configured");
  process.exit(0);
}

const suffix = crypto.randomUUID();
const adminAccountId = `delete_admin_${suffix}`;
const adminSessionToken = `delete_admin_session_${suffix}`;
const accountId = `delete_account_${suffix}`;
const accountSessionToken = `delete_account_session_${suffix}`;
const storeId = `delete_store_${suffix}`;
const accountBStoreId = `delete_store_b_${suffix}`;
const snapshotId = `delete_snapshot_${suffix}`;
const jobId = `delete_job_${suffix}`;
const auditEntityId = `delete_audit_${suffix}`;
const collectItemId = `delete_collect_item_${suffix}`;
const accountBCollectItemId = `delete_collect_item_b_${suffix}`;
const rawPayloadId = `delete_raw_payload_${suffix}`;
const accountBRawPayloadId = `delete_raw_payload_b_${suffix}`;
const productDraftId = `delete_product_draft_${suffix}`;
const accountBProductDraftId = `delete_product_draft_b_${suffix}`;
const collectRequestId = `delete_collect_request_${suffix}`;
const legacyDataStoreId = `delete_legacy_data_store_${suffix}`;
const legacyVerificationRequestId = `delete_legacy_verification_${suffix}`;
const accountBId = `delete_account_b_${suffix}`;
const accountBSessionToken = `delete_account_b_session_${suffix}`;
const legacyDataStoreBId = `delete_legacy_data_store_b_${suffix}`;
const accountBVerificationRequestId = `keep_b_verification_${suffix}`;
const accountTicketHash = crypto.createHash("sha256").update(`delete-ticket-${suffix}`).digest("hex");
const accountCollectorTokenHash = crypto.createHash("sha256").update(`delete-session-${suffix}`).digest("hex");
const accountBTicketHash = crypto.createHash("sha256").update(`keep-b-ticket-${suffix}`).digest("hex");
const accountBCollectorTokenHash = crypto.createHash("sha256").update(`keep-b-session-${suffix}`).digest("hex");
const preLockTicketHash = crypto.createHash("sha256").update(`pre-lock-ticket-${suffix}`).digest("hex");
const preLockCollectorTokenHash = crypto.createHash("sha256").update(`pre-lock-session-${suffix}`).digest("hex");
const postLockTicketHash = crypto.createHash("sha256").update(`post-lock-ticket-${suffix}`).digest("hex");
const postLockCollectorTokenHash = crypto.createHash("sha256").update(`post-lock-session-${suffix}`).digest("hex");
const pool = await getPostgresPool();

async function waitForBlockedQueries(pids, timeoutMs = 3000) {
  const expected = [...new Set(pids.map(Number).filter(Number.isInteger))];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT pid,cardinality(pg_blocking_pids(pid))::int AS blocker_count
       FROM pg_stat_activity
       WHERE pid=ANY($1::int[])`,
      [expected],
    );
    if (
      result.rows.length === expected.length
      && result.rows.every((row) => Number(row.blocker_count) > 0)
    ) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

async function waitForBlockedStoreDeletion(timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT pid
       FROM pg_stat_activity
       WHERE datname=current_database()
         AND query LIKE '%DELETE FROM stores WHERE owner_account_id%'
         AND cardinality(pg_blocking_pids(pid))>0`,
    );
    if (result.rowCount > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

async function requestApi(handle, {
  method,
  pathname,
  authorization = "",
}) {
  const req = Readable.from([]);
  req.method = method;
  req.url = pathname;
  req.headers = authorization ? { authorization } : {};
  const res = {
    status: 0,
    body: "",
    writeHead(status) {
      this.status = status;
    },
    end(text = "") {
      this.body = String(text || "");
    },
  };
  try {
    await handle(req, res);
  } catch (error) {
    res.writeHead(Number(error?.status || 500));
    res.end(JSON.stringify({
      ok: false,
      code: error?.code || "LOCAL_ERROR",
      message: error?.message || "本地服务异常",
    }));
  }
  return {
    status: res.status,
    body: JSON.parse(res.body || "{}"),
  };
}

async function requestDeleteAccount(handle) {
  return requestApi(handle, {
    method: "DELETE",
    pathname: `/local/accounts/${encodeURIComponent(accountId)}`,
    authorization: `Bearer ${adminSessionToken}`,
  });
}

try {
  await runMigrations(pool);
  await pool.query(
    "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,'Delete Admin','admin','active')",
    [adminAccountId, `delete-admin-${suffix}`],
  );
  await pool.query(
    "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,'Delete Test','user','active')",
    [accountId, `delete-${suffix}`],
  );
  await pool.query(
    "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,'Keep B','user','active')",
    [accountBId, `keep-b-${suffix}`],
  );
  for (const [token, ownerAccountId] of [
    [adminSessionToken, adminAccountId],
    [accountSessionToken, accountId],
    [accountBSessionToken, accountBId],
  ]) {
    await pool.query(
      `INSERT INTO sessions (token,account_id,issued_at,expires_at,last_seen_at)
       VALUES ($1,$2,NOW(),TIMESTAMPTZ '2099-01-01T00:00:00.000Z',NOW())`,
      [token, ownerAccountId],
    );
  }
  await pool.query(
    `INSERT INTO collector_auth_tickets (
       id,ticket_hash,account_id,parent_session_token,permissions,expires_at
     ) VALUES
       ($1,$2,$3,$4,'["collector.upload"]'::jsonb,TIMESTAMPTZ '2099-01-01T00:00:00.000Z'),
       ($5,$6,$7,$8,'["collector.upload"]'::jsonb,TIMESTAMPTZ '2099-01-01T00:00:00.000Z'),
       ($9,$10,$3,$4,'["collector.upload"]'::jsonb,TIMESTAMPTZ '2099-01-01T00:00:00.000Z')`,
    [
      `delete-ticket-${suffix}`,
      accountTicketHash,
      accountId,
      accountSessionToken,
      `keep-b-ticket-${suffix}`,
      accountBTicketHash,
      accountBId,
      accountBSessionToken,
      `pre-lock-ticket-${suffix}`,
      preLockTicketHash,
    ],
  );
  await pool.query(
    `INSERT INTO collector_sessions (
       id,token_hash,account_id,parent_session_token,device_fingerprint,
       extension_version,permissions,expires_at
     ) VALUES
       ($1,$2,$3,$4,$5,'3.0.0-test','["collector.upload"]'::jsonb,TIMESTAMPTZ '2099-01-01T00:00:00.000Z'),
       ($6,$7,$8,$9,$10,'3.0.0-test','["collector.upload"]'::jsonb,TIMESTAMPTZ '2099-01-01T00:00:00.000Z'),
       ($11,$12,$3,$4,$13,'3.0.0-test','["collector.upload"]'::jsonb,TIMESTAMPTZ '2099-01-01T00:00:00.000Z')`,
    [
      `delete-collector-session-${suffix}`,
      accountCollectorTokenHash,
      accountId,
      accountSessionToken,
      `private-delete-device-${suffix}`,
      `keep-b-collector-session-${suffix}`,
      accountBCollectorTokenHash,
      accountBId,
      accountBSessionToken,
      `keep-b-device-${suffix}`,
      `pre-lock-collector-session-${suffix}`,
      preLockCollectorTokenHash,
      `pre-lock-device-${suffix}`,
    ],
  );
  await pool.query(
    "INSERT INTO stores (id,owner_account_id,label,client_id,status) VALUES ($1,$2,'Delete Store',$3,'active')",
    [storeId, accountId, `delete-client-${suffix}`],
  );
  await pool.query(
    "INSERT INTO stores (id,owner_account_id,label,client_id,status) VALUES ($1,$2,'Keep B Store',$3,'active')",
    [accountBStoreId, accountBId, `keep-b-client-${suffix}`],
  );
  await pool.query(
    "INSERT INTO data_collection_stores (id,seller_company_id) VALUES ($1,$2)",
    [legacyDataStoreId, `delete-seller-${suffix}`],
  );
  await pool.query(
    `INSERT INTO account_data_collection_stores (
       account_id,data_collection_store_id,label,is_current
     ) VALUES ($1,$2,'Delete legacy evidence',TRUE)`,
    [accountId, legacyDataStoreId],
  );
  await pool.query(
    `INSERT INTO collection_store_verifications (
       account_id,data_collection_store_id,seller_company_id,matched,request_id
     ) VALUES ($1,$2,$3,TRUE,$4)`,
    [accountId, legacyDataStoreId, `delete-seller-${suffix}`, legacyVerificationRequestId],
  );
  await pool.query(
    "INSERT INTO data_collection_stores (id,seller_company_id) VALUES ($1,$2)",
    [legacyDataStoreBId, `keep-b-seller-${suffix}`],
  );
  await pool.query(
    `INSERT INTO account_data_collection_stores (
       account_id,data_collection_store_id,label,is_current
     ) VALUES ($1,$2,'Keep B legacy evidence',TRUE)`,
    [accountBId, legacyDataStoreBId],
  );
  await pool.query(
    `INSERT INTO collection_store_verifications (
       account_id,data_collection_store_id,seller_company_id,matched,request_id
     ) VALUES ($1,$2,$3,TRUE,$4)`,
    [
      accountBId,
      legacyDataStoreId,
      `delete-seller-${suffix}`,
      accountBVerificationRequestId,
    ],
  );

  assert.deepEqual(
    (await readLegacyDataCollectionStoresForAudit(pool, { accountId }))
      .map((record) => record.id)
      .sort(),
    [legacyDataStoreId],
  );
  assert.deepEqual(
    (await readLegacyDataCollectionStoresForAudit(pool, { accountId: accountBId }))
      .map((record) => record.id)
      .sort(),
    [legacyDataStoreBId],
  );
  await pool.query(
    `INSERT INTO collect_items (id, account_id, store_id, source, identity_key, source_sku, summary)
     VALUES ($1, $2, $3, 'ozon', $4, 'delete-sku', '{}'::jsonb)`,
    [collectItemId, accountId, storeId, `delete-identity-${suffix}`],
  );
  await pool.query(
    `INSERT INTO collect_raw_payloads (
       id, collect_item_id, account_id, store_id, payload_hash, payload
     ) VALUES ($1, $2, $3, $4, $5, '{}'::jsonb)`,
    [rawPayloadId, collectItemId, accountId, storeId, `delete-payload-${suffix}`],
  );
  await pool.query(
    `INSERT INTO product_drafts (
       id,collect_item_id,source_payload_id,version,data_hash,data,updated_by
     ) VALUES ($1,$2,$3,1,$4,'{}'::jsonb,$5)`,
    [productDraftId, collectItemId, rawPayloadId,
      crypto.createHash("sha256").update(`delete-draft-${suffix}`).digest("hex"), accountId],
  );
  await pool.query(
    "UPDATE collect_items SET current_draft_id=$1 WHERE account_id=$2 AND id=$3",
    [productDraftId, accountId, collectItemId],
  );
  await pool.query(
    `INSERT INTO collect_items (id,account_id,store_id,source,identity_key,source_sku,summary)
     VALUES ($1,$2,$3,'ozon',$4,'keep-b-sku','{}'::jsonb)`,
    [accountBCollectItemId, accountBId, accountBStoreId, `keep-b-identity-${suffix}`],
  );
  await pool.query(
    `INSERT INTO collect_raw_payloads (
       id,collect_item_id,account_id,store_id,payload_hash,payload
     ) VALUES ($1,$2,$3,$4,$5,'{}'::jsonb)`,
    [accountBRawPayloadId, accountBCollectItemId, accountBId, accountBStoreId,
      `keep-b-payload-${suffix}`],
  );
  await pool.query(
    `INSERT INTO product_drafts (
       id,collect_item_id,source_payload_id,version,data_hash,data,updated_by
     ) VALUES ($1,$2,$3,1,$4,'{}'::jsonb,$5)`,
    [accountBProductDraftId, accountBCollectItemId, accountBRawPayloadId,
      crypto.createHash("sha256").update(`keep-b-draft-${suffix}`).digest("hex"), accountBId],
  );
  await pool.query(
    "UPDATE collect_items SET current_draft_id=$1 WHERE account_id=$2 AND id=$3",
    [accountBProductDraftId, accountBId, accountBCollectItemId],
  );
  const categoryRepository = createPostgresAccountSharedOzonCategoryRepository({ pool });
  for (const [ownerAccountId, ownerCollectItemId, requestSuffix] of [
    [accountId, collectItemId, "delete"],
    [accountBId, accountBCollectItemId, "keep-b"],
  ]) {
    await categoryRepository.confirmManualCategory({
      accountId: ownerAccountId,
      collectItemId: ownerCollectItemId,
      expectedSourceVersion: "draft:1",
      currentDescriptionCategoryId: 17028788,
      currentTypeId: 95555,
      taxonomyFingerprint: crypto.createHash("sha256").update(`taxonomy-${requestSuffix}-${suffix}`).digest("hex"),
      validatedAt: "2026-07-30T08:00:00.000Z",
      actorId: ownerAccountId,
      correlationId: `${requestSuffix}-manual-correlation-${suffix}`,
      idempotencyKey: `${requestSuffix}-manual-idempotency-${suffix}`,
      requestHash: crypto.createHash("sha256").update(`manual-request-${requestSuffix}-${suffix}`).digest("hex"),
    });
  }
  await pool.query(
    `INSERT INTO collect_requests (
       id, idempotency_key, account_id, store_id, source, source_sku, request_hash, content_hash, collect_item_id
     ) VALUES ($1, $2, $3, $4, 'ozon', 'delete-sku', $5, $6, $7)`,
    [collectRequestId, `delete-request-${suffix}`, accountId, storeId, `delete-request-hash-${suffix}`, `delete-content-hash-${suffix}`, collectItemId],
  );
  await pool.query(
    `INSERT INTO submission_snapshots (
       id,account_id,store_id,idempotency_key,snapshot_hash,items
     ) VALUES ($1,$2,$3,$4,$5,'[]'::jsonb)`,
    [snapshotId, accountId, storeId, `delete-key-${suffix}`, `delete-hash-${suffix}`],
  );
  await pool.query(
    `INSERT INTO submission_jobs (
       id,snapshot_id,account_id,store_id,correlation_id
     ) VALUES ($1,$2,$3,$4,$5)`,
    [jobId, snapshotId, accountId, storeId, `delete-correlation-${suffix}`],
  );
  await pool.query(
    `INSERT INTO audit_events (
       account_id,store_id,action,entity_type,entity_id
     ) VALUES ($1,$2,'TEST_ACCOUNT_DELETE','account',$3)`,
    [accountId, storeId, auditEntityId],
  );

  const keepBArchiveRecord = {
    archiveKey: `${accountBId}:${legacyDataStoreBId}`,
    accountId: accountBId,
    dataCollectionStoreId: legacyDataStoreBId,
    archivedAt: "2026-07-29T10:00:00.000Z",
    sourceTimestamp: "2026-07-28T10:00:00.000Z",
    wasCurrent: true,
    sourceFields: ["dataCollectionStores"],
    legacySnapshot: {
      id: legacyDataStoreBId,
      ownerAccountId: accountBId,
      sellerCompanyId: `keep-b-seller-${suffix}`,
    },
  };
  const state = {
    token: adminSessionToken,
    currentAccountId: adminAccountId,
    sessionIssuedAt: "2026-07-30T08:00:00.000Z",
    accounts: [
      { id: adminAccountId, username: `delete-admin-${suffix}`, role: "admin", status: "active" },
      { id: accountId, username: `delete-${suffix}`, role: "user", status: "active" },
      { id: accountBId, username: `keep-b-${suffix}`, role: "user", status: "active" },
    ],
    stores: [{
      id: storeId,
      ownerAccountId: accountId,
      label: "Delete Store",
      clientId: `delete-client-${suffix}`,
      status: "active",
    }],
    sessions: {
      [adminSessionToken]: {
        token: adminSessionToken,
        accountId: adminAccountId,
        issuedAt: "2026-07-30T08:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      [accountSessionToken]: {
        token: accountSessionToken,
        accountId,
        issuedAt: "2026-07-30T08:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      [accountBSessionToken]: {
        token: accountBSessionToken,
        accountId: accountBId,
        issuedAt: "2026-07-30T08:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    },
    collectorAuthTickets: [],
    collectorSessions: [],
    hashes: {},
    leases: {},
    browserAgents: {},
    jobs: {},
    reports: [],
    caches: { files: [], warehouses: [], products: [], postings: [], collectBox: [] },
    currentStoreIdsByAccount: { [accountId]: storeId },
    legacyDataCollectionStoreAuditArchive: {
      schemaVersion: 1,
      readOnly: true,
      records: [{
        archiveKey: `${accountId}:${legacyDataStoreId}`,
        accountId,
        dataCollectionStoreId: legacyDataStoreId,
        archivedAt: "2026-07-29T10:00:00.000Z",
        sourceTimestamp: "2026-07-28T10:00:00.000Z",
        wasCurrent: true,
        sourceFields: ["dataCollectionStores"],
        legacySnapshot: {
          id: legacyDataStoreId,
          ownerAccountId: accountId,
          sellerCompanyId: `delete-seller-${suffix}`,
        },
      }, keepBArchiveRecord],
      accountRecordCounts: { [accountId]: 1, [accountBId]: 1 },
    },
  };
  await pool.query(
    `INSERT INTO local_state (id,state,version)
     VALUES ('local-state',$1::jsonb,1)
     ON CONFLICT (id) DO UPDATE SET state=EXCLUDED.state,version=EXCLUDED.version`,
    [JSON.stringify(state)],
  );
  process.env.QH_LOCAL_NO_LISTEN = "1";
  process.env.QH_LOCAL_NO_DOTENV = "1";
  const { handle } = await import("../index.mjs");
  const healthResponse = await requestApi(handle, {
    method: "GET",
    pathname: "/health",
  });
  assert.equal(healthResponse.status, 200);
  const storeBlocker = await pool.connect();
  const ticketWriter = await pool.connect();
  const sessionWriter = await pool.connect();
  let storeBlockerOpen = false;
  let deletionPromise;
  let ticketWritePromise;
  let sessionWritePromise;
  let deletionReachedBlockedStore = false;
  let concurrentWritesBlocked = false;
  let deletionResponse;
  let ticketWriteResult;
  let sessionWriteResult;
  try {
    await storeBlocker.query("BEGIN");
    storeBlockerOpen = true;
    await storeBlocker.query("SELECT id FROM stores WHERE id=$1 FOR UPDATE", [storeId]);
    deletionPromise = requestDeleteAccount(handle);
    deletionReachedBlockedStore = await waitForBlockedStoreDeletion();

    const ticketWriterPid = Number(
      (await ticketWriter.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
    );
    const sessionWriterPid = Number(
      (await sessionWriter.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
    );
    const ticketRepository = createPostgresCollectorAuthRepository({
      pool: { query: (sql, values) => ticketWriter.query(sql, values) },
    });
    const sessionRepository = createPostgresCollectorAuthRepository({
      pool: { query: (sql, values) => sessionWriter.query(sql, values) },
    });
    ticketWritePromise = ticketRepository.createTicket({
      id: `post-lock-ticket-${suffix}`,
      ticketHash: postLockTicketHash,
      accountId,
      parentSessionToken: accountSessionToken,
      permissions: ["collector.upload"],
      expiresAt: "2099-01-01T00:00:00.000Z",
      consumedAt: null,
      createdAt: "2026-07-30T08:00:00.000Z",
    }).then(
      (value) => ({ status: "resolved", value }),
      (error) => ({ status: "rejected", code: error?.code || "" }),
    );
    sessionWritePromise = sessionRepository.createSession({
      id: `post-lock-collector-session-${suffix}`,
      tokenHash: postLockCollectorTokenHash,
      accountId,
      parentSessionToken: accountSessionToken,
      deviceFingerprint: `post-lock-device-${suffix}`,
      extensionVersion: "3.0.0-test",
      permissions: ["collector.upload"],
      expiresAt: "2099-01-01T00:00:00.000Z",
      revokedAt: null,
      revokedReason: "",
      lastSeenAt: "2026-07-30T08:00:00.000Z",
      createdAt: "2026-07-30T08:00:00.000Z",
    }).then(
      (value) => ({ status: "resolved", value }),
      (error) => ({ status: "rejected", code: error?.code || "" }),
    );
    concurrentWritesBlocked = await waitForBlockedQueries([
      ticketWriterPid,
      sessionWriterPid,
    ]);
  } finally {
    if (storeBlockerOpen) {
      await storeBlocker.query("COMMIT");
      storeBlockerOpen = false;
    }
    deletionResponse = deletionPromise ? await deletionPromise : null;
    ticketWriteResult = ticketWritePromise ? await ticketWritePromise : null;
    sessionWriteResult = sessionWritePromise ? await sessionWritePromise : null;
    storeBlocker.release();
    ticketWriter.release();
    sessionWriter.release();
  }
  assert.equal(deletionReachedBlockedStore, true);
  assert.equal(concurrentWritesBlocked, true);
  for (const writeResult of [ticketWriteResult, sessionWriteResult]) {
    assert.equal(
      writeResult.status === "resolved"
        ? writeResult.value === null
        : writeResult.code === "COLLECTOR_AUTH_PERSISTENCE_FAILED",
      true,
    );
  }
  assert.equal(deletionResponse.status, 200);
  assert.equal(deletionResponse.body.ok, true);

  const counts = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM accounts WHERE id=$1) account_count,
       (SELECT COUNT(*)::int FROM stores WHERE id=$2) store_count,
       (SELECT COUNT(*)::int FROM submission_jobs WHERE id=$3) job_count,
       (SELECT COUNT(*)::int FROM submission_snapshots WHERE id=$4) snapshot_count,
       (SELECT COUNT(*)::int FROM collect_items WHERE id=$5) collect_item_count,
       (SELECT COUNT(*)::int FROM collect_raw_payloads WHERE id=$6) raw_payload_count,
       (SELECT COUNT(*)::int FROM collect_requests WHERE id=$7) collect_request_count,
       (SELECT COUNT(*)::int FROM audit_events WHERE entity_id=$8) audit_count,
       (SELECT account_id FROM audit_events WHERE entity_id=$8 LIMIT 1) audit_account_id,
       (SELECT store_id FROM audit_events WHERE entity_id=$8 LIMIT 1) audit_store_id,
       (SELECT COUNT(*)::int FROM data_collection_stores WHERE id=$9) legacy_store_count,
       (SELECT COUNT(*)::int FROM account_data_collection_stores
        WHERE data_collection_store_id=$9) legacy_membership_count,
       (SELECT COUNT(*)::int FROM collection_store_verifications
        WHERE request_id=$10) legacy_verification_count,
       (SELECT COUNT(*)::int FROM audit_events
        WHERE action='LEGACY_DATA_COLLECTION_STORE_PURGED' AND entity_id=$1) legacy_purge_audit_count,
       (SELECT account_id FROM audit_events
        WHERE action='LEGACY_DATA_COLLECTION_STORE_PURGED' AND entity_id=$1) legacy_purge_audit_account_id,
       (SELECT metadata FROM audit_events
        WHERE action='LEGACY_DATA_COLLECTION_STORE_PURGED' AND entity_id=$1) legacy_purge_metadata,
       (SELECT COUNT(*)::int FROM data_collection_stores WHERE id=$11) account_b_legacy_store_count,
       (SELECT COUNT(*)::int FROM account_data_collection_stores
        WHERE account_id=$12 AND data_collection_store_id=$11) account_b_legacy_membership_count,
       (SELECT COUNT(*)::int FROM collection_store_verifications
        WHERE account_id=$12 AND request_id=$13) account_b_verification_count,
       (SELECT data_collection_store_id FROM collection_store_verifications
        WHERE account_id=$12 AND request_id=$13) account_b_verification_store_id,
       (SELECT COUNT(*)::int FROM collector_auth_tickets WHERE account_id=$1) collector_ticket_count,
       (SELECT COUNT(*)::int FROM collector_sessions WHERE account_id=$1) collector_session_count,
       (SELECT COUNT(*)::int FROM collector_auth_tickets WHERE account_id=$12) account_b_collector_ticket_count,
       (SELECT COUNT(*)::int FROM collector_sessions WHERE account_id=$12) account_b_collector_session_count,
       (SELECT COUNT(*)::int FROM collect_ozon_category_manual_confirmation_evidence
        WHERE account_id=$1) manual_confirmation_count,
       (SELECT COUNT(*)::int FROM collect_ozon_category_manual_confirmation_evidence
        WHERE account_id=$12) account_b_manual_confirmation_count,
       (SELECT metadata FROM audit_events
        WHERE action='ACCOUNT_DELETED' AND entity_id=$1) account_deleted_metadata,
       (SELECT state->'legacyDataCollectionStoreAuditArchive'
        FROM local_state WHERE id='local-state') local_state_legacy_archive,
       (SELECT state->'collectorAuthTickets'
        FROM local_state WHERE id='local-state') local_state_collector_tickets,
       (SELECT state->'collectorSessions'
        FROM local_state WHERE id='local-state') local_state_collector_sessions,
       (SELECT event->'metadata'
        FROM local_state
        CROSS JOIN LATERAL jsonb_array_elements(state->'auditEvents') event
        WHERE id='local-state'
          AND event->>'action'='ACCOUNT_DELETED'
          AND event->>'entityId'=$1
        LIMIT 1) local_state_account_deleted_metadata`,
    [
      accountId,
      storeId,
      jobId,
      snapshotId,
      collectItemId,
      rawPayloadId,
      collectRequestId,
      auditEntityId,
      legacyDataStoreId,
      legacyVerificationRequestId,
      legacyDataStoreBId,
      accountBId,
      accountBVerificationRequestId,
    ],
  );
  assert.deepEqual(counts.rows[0], {
    account_count: 0,
    store_count: 0,
    job_count: 0,
    snapshot_count: 0,
    collect_item_count: 0,
    raw_payload_count: 0,
    collect_request_count: 0,
    audit_count: 1,
    audit_account_id: null,
    audit_store_id: null,
    legacy_store_count: 0,
    legacy_membership_count: 0,
    legacy_verification_count: 0,
    legacy_purge_audit_count: 1,
    legacy_purge_audit_account_id: null,
    legacy_purge_metadata: {
      reason: "ACCOUNT_DELETION_PRIVACY_ERASURE",
      legacyRecordCount: 1,
      verificationDeletedCount: 1,
      membershipDeletedCount: 1,
      orphanStoreDeletedCount: 1,
    },
    account_b_legacy_store_count: 1,
    account_b_legacy_membership_count: 1,
    account_b_verification_count: 1,
    account_b_verification_store_id: null,
    collector_ticket_count: 0,
    collector_session_count: 0,
    account_b_collector_ticket_count: 1,
    account_b_collector_session_count: 1,
    manual_confirmation_count: 0,
    account_b_manual_confirmation_count: 1,
    account_deleted_metadata: {
      deletedFileCount: 0,
      deletedStoreIds: [storeId],
      deletedStoreCount: 1,
      legacyArchivePurgedCount: 1,
      deletedCollectorAuthTicketCount: 2,
      deletedCollectorSessionCount: 2,
      deletedCollectorOzonEnrichmentCacheCount: 0,
      deletedCollectorOzonEnrichmentJobCount: 0,
      deletedCollectOzonCategorySourceEvidenceCount: 1,
      deletedAccountOzonSharedCategoryCount: 1,
      deletedAccountOzonSharedCategoryEventCount: 1,
      deletedAccountOzonCategoryConfirmationCount: 0,
      deletedCollectOzonCategoryLookupEvidenceCount: 0,
      deletedCollectOzonCategoryCurrentSourceCount: 1,
      deletedCollectOzonCategoryManualConfirmationEvidenceCount: 1,
    },
    local_state_legacy_archive: {
      schemaVersion: 1,
      readOnly: true,
      records: [keepBArchiveRecord],
      accountRecordCounts: { [accountBId]: 1 },
    },
    local_state_collector_tickets: [],
    local_state_collector_sessions: [],
    local_state_account_deleted_metadata: {
      deletedFileCount: 0,
      deletedStoreIds: [storeId],
      deletedStoreCount: 1,
      legacyArchivePurgedCount: 1,
      deletedCollectorAuthTicketCount: 2,
      deletedCollectorSessionCount: 2,
      deletedCollectorOzonEnrichmentCacheCount: 0,
      deletedCollectorOzonEnrichmentJobCount: 0,
      deletedCollectOzonCategorySourceEvidenceCount: 1,
      deletedAccountOzonSharedCategoryCount: 1,
      deletedAccountOzonSharedCategoryEventCount: 1,
      deletedAccountOzonCategoryConfirmationCount: 0,
      deletedCollectOzonCategoryLookupEvidenceCount: 0,
      deletedCollectOzonCategoryCurrentSourceCount: 1,
      deletedCollectOzonCategoryManualConfirmationEvidenceCount: 1,
    },
  });
  assert.doesNotMatch(
    JSON.stringify(counts.rows[0].local_state_legacy_archive),
    new RegExp(`${accountId}|delete-seller-${suffix}`),
  );
  assert.doesNotMatch(
    JSON.stringify({
      tickets: counts.rows[0].local_state_collector_tickets,
      sessions: counts.rows[0].local_state_collector_sessions,
    }),
    new RegExp(`${accountId}|${accountSessionToken}|private-delete-device-${suffix}`),
  );
  console.log("account deletion PostgreSQL integration passed");
} finally {
  await pool.query("DELETE FROM audit_events WHERE entity_id=$1", [auditEntityId]).catch(() => {});
  await pool.query(
    "DELETE FROM audit_events WHERE action='LEGACY_DATA_COLLECTION_STORE_PURGED' AND entity_id=$1",
    [accountId],
  ).catch(() => {});
  await pool.query("DELETE FROM audit_events WHERE action='ACCOUNT_DELETED' AND entity_id=$1", [accountId]).catch(() => {});
  await pool.query("DELETE FROM accounts WHERE id=$1", [adminAccountId]).catch(() => {});
  await pool.query("DELETE FROM accounts WHERE id=$1", [accountBId]).catch(() => {});
  await pool.query("DELETE FROM data_collection_stores WHERE id=$1", [legacyDataStoreBId]).catch(() => {});
  await closePostgresPool();
}
