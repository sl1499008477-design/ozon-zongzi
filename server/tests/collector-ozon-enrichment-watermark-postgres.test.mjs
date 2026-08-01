import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createPostgresCollectorOzonEnrichmentRepository } from "../collector-ozon-enrichment-repository.mjs";

const databaseUrl = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "../db/migrations");

function quoteIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded(promise, label, timeoutMs = 3_000) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForBlockedClient(pool, pid, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query(
      "SELECT cardinality(pg_blocking_pids($1::int))::int AS blocker_count",
      [pid],
    );
    if (Number(result.rows[0]?.blocker_count || 0) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

const OLD_CONTEXT = Object.freeze({
  sellerCompanyId: "2681910",
  revision: 1,
  observedAt: "2026-08-01T08:00:00.000Z",
});

const NEW_CONTEXT = Object.freeze({
  sellerCompanyId: "7311458",
  revision: 2,
  observedAt: "2026-08-01T08:00:02.000Z",
});

if (!databaseUrl) {
  test("PostgreSQL Seller watermark linearizes observation and terminal commits", {
    skip: "SONLI_MIGRATION_TEST_DATABASE_URL is not configured",
  }, () => {});
} else {
  test("PostgreSQL Seller watermark linearizes observation and terminal commits", {
    timeout: 15_000,
  }, async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    const setup = await pool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `ozon_seller_fence_${suffix}`;
    const schemaSql = quoteIdentifier(schema);
    const openClients = new Set();
    let releaseObservation = null;

    async function scopedClient() {
      const client = await pool.connect();
      await client.query(`SET search_path TO ${schemaSql}, public`);
      openClients.add(client);
      return client;
    }

    function releaseClient(client) {
      if (!openClients.delete(client)) return;
      client.release();
    }

    async function insertFixture(label, jobKinds) {
      const accountId = `account_${label}_${suffix}`;
      const webSession = `web_${label}_${suffix}`;
      const collectorSessionId = `collector_${label}_${suffix}`;
      const collectItemId = `collect_${label}_${suffix}`;
      await setup.query(
        "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'user','active')",
        [accountId, `user_${label}_${suffix}`],
      );
      await setup.query(
        `INSERT INTO sessions (token,account_id,issued_at,expires_at)
         VALUES ($1,$2,'2026-08-01T00:00:00.000Z','9999-12-31T23:59:59.999Z')`,
        [webSession, accountId],
      );
      await setup.query(
        `INSERT INTO collector_sessions (
           id,token_hash,account_id,parent_session_token,permissions,expires_at,
           seller_context_json,seller_context_updated_at
         ) VALUES ($1,$2,$3,$4,'["collector.ozon.read"]'::jsonb,
                   '9999-12-31T23:59:59.999Z',$5::jsonb,$6)`,
        [
          collectorSessionId,
          `token_hash_${label}_${suffix}`,
          accountId,
          webSession,
          JSON.stringify(OLD_CONTEXT),
          new Date(OLD_CONTEXT.observedAt),
        ],
      );
      await setup.query(
        `INSERT INTO collect_items (
           id,account_id,source,identity_key,source_sku,status,summary
         ) VALUES ($1,$2,'ozon',$3,$4,'PENDING_ENRICHMENT','{}'::jsonb)`,
        [collectItemId, accountId, `identity_${label}_${suffix}`, `sku-${label}-${suffix}`],
      );
      const jobs = {};
      for (const kind of jobKinds) {
        const jobId = `job_${kind}_${label}_${suffix}`;
        const sku = `sku-${kind}-${label}-${suffix}`;
        const claimFence = `claim-${kind}-${label}-${suffix}`;
        jobs[kind] = { jobId, sku, claimFence };
        await setup.query(
          `INSERT INTO collector_ozon_enrichment_jobs (
             id,account_id,collect_item_id,request_id,sku,status,refresh_bundle,claimed_session_id,
             claim_expires_at,claim_fence,capture_context_json,deadline_at,
             attempt_count,next_attempt_at,created_at,updated_at
           ) VALUES ($1,$2,$3,$4,$5,'PROCESSING','true'::jsonb,$6,
                     '2026-08-01T08:10:00.000Z',$7,$8::jsonb,
                     '9999-12-31T23:59:59.999Z',1,'2026-08-01T08:00:00.000Z',
                     '2026-08-01T08:00:00.000Z','2026-08-01T08:00:00.000Z')`,
          [
            jobId,
            accountId,
            collectItemId,
            `request_${kind}_${label}_${suffix}`,
            sku,
            collectorSessionId,
            claimFence,
            JSON.stringify(OLD_CONTEXT),
          ],
        );
      }
      return { accountId, collectorSessionId, collectItemId, jobs };
    }

    function terminalInput(fixture, kind) {
      const job = fixture.jobs[kind];
      return {
        accountId: fixture.accountId,
        collectorSessionId: fixture.collectorSessionId,
        jobId: job.jobId,
        key: {
          accountId: fixture.accountId,
          source: "ozon",
          sku: job.sku,
          contractVersion: "collector.ozon.enrichment.v1",
        },
        responseHash: `response-${kind}-${suffix}`,
        captureContext: OLD_CONTEXT,
        claimFence: job.claimFence,
        capturedAt: new Date("2026-08-01T08:00:03.000Z"),
        expiresAt: new Date("2026-08-01T14:00:03.000Z"),
        now: new Date("2026-08-01T08:00:03.000Z"),
      };
    }

    try {
      await setup.query(`CREATE SCHEMA ${schemaSql}`);
      await setup.query(`SET search_path TO ${schemaSql}, public`);
      const migrations = (await readdir(migrationsDir))
        .filter((file) => /^\d{3}_.+\.sql$/.test(file))
        .sort();
      for (const migration of migrations) {
        await setup.query(await readFile(path.join(migrationsDir, migration), "utf8"));
      }

      const switchedFirst = await insertFixture("switched_first", ["complete", "fail", "defer"]);
      const observeClient = await scopedClient();
      const commitReached = deferred();
      releaseObservation = deferred();
      const observeRepository = createPostgresCollectorOzonEnrichmentRepository({
        pool: {
          async connect() {
            return {
              async query(sql, params) {
                if (String(sql).trim() === "COMMIT") {
                  commitReached.resolve();
                  await releaseObservation.promise;
                }
                return observeClient.query(sql, params);
              },
              release() { releaseClient(observeClient); },
            };
          },
          async query(sql, params) { return observeClient.query(sql, params); },
        },
      });
      const observation = observeRepository.advanceSellerContext({
        accountId: switchedFirst.accountId,
        collectorSessionId: switchedFirst.collectorSessionId,
        captureContext: NEW_CONTEXT,
        now: new Date(NEW_CONTEXT.observedAt),
      });
      await bounded(Promise.race([
        commitReached.promise,
        observation.then(() => {
          throw new Error("Seller observation committed before the test release gate");
        }),
      ]), "Seller observation commit gate");

      const terminalClient = await scopedClient();
      const terminalPid = Number((await terminalClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      await terminalClient.query("SET default_transaction_isolation TO 'repeatable read'");
      await terminalClient.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      assert.equal((await terminalClient.query("SHOW transaction_isolation")).rows[0].transaction_isolation, "read committed");
      await terminalClient.query(
        "UPDATE collect_items SET status='COMPLETE' WHERE id=$1 AND account_id=$2",
        [switchedFirst.collectItemId, switchedFirst.accountId],
      );
      const terminalRepository = createPostgresCollectorOzonEnrichmentRepository({
        pool: terminalClient,
        transactionOwner: "caller",
      });
      const staleCompletion = terminalRepository.completeJobAndCache({
        ...terminalInput(switchedFirst, "complete"),
        result: { status: "COMPLETE", descriptionCategoryId: 123 },
      }).then(
        () => null,
        (error) => error,
      );
      try {
        assert.equal(await waitForBlockedClient(pool, terminalPid), true);
      } finally {
        releaseObservation.resolve();
      }
      await observation;
      const staleCompletionError = await staleCompletion;
      assert.equal(
        staleCompletionError?.code === "SELLER_CONTEXT_CHANGED"
          && staleCompletionError?.status === 409,
        true,
      );
      await terminalClient.query("ROLLBACK");

      await terminalClient.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await assert.rejects(terminalRepository.failJobAndCache({
        ...terminalInput(switchedFirst, "fail"),
        error: { status: 404, code: "OZON_ENRICH_NOT_FOUND" },
      }), (error) => error?.code === "SELLER_CONTEXT_CHANGED" && error?.status === 409);
      await terminalClient.query("ROLLBACK");

      await terminalClient.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await assert.rejects(terminalRepository.deferClaim({
        accountId: switchedFirst.accountId,
        collectorSessionId: switchedFirst.collectorSessionId,
        jobId: switchedFirst.jobs.defer.jobId,
        error: { status: 502, code: "OZON_ENRICH_UPSTREAM_FAILED" },
        captureContext: OLD_CONTEXT,
        claimFence: switchedFirst.jobs.defer.claimFence,
        now: new Date("2026-08-01T08:00:03.000Z"),
      }), (error) => error?.code === "SELLER_CONTEXT_CHANGED" && error?.status === 409);
      await terminalClient.query("ROLLBACK");
      releaseClient(terminalClient);

      const switchedRows = await setup.query(
        `SELECT status FROM collector_ozon_enrichment_jobs
          WHERE account_id=$1 ORDER BY id`,
        [switchedFirst.accountId],
      );
      assert.deepEqual(switchedRows.rows.map(({ status }) => status), [
        "PROCESSING",
        "PROCESSING",
        "PROCESSING",
      ]);
      assert.equal((await setup.query(
        "SELECT COUNT(*)::int AS count FROM collector_ozon_enrichment_cache WHERE account_id=$1",
        [switchedFirst.accountId],
      )).rows[0].count, 0);
      assert.equal((await setup.query(
        "SELECT status FROM collect_items WHERE id=$1",
        [switchedFirst.collectItemId],
      )).rows[0].status, "PENDING_ENRICHMENT");

      const committedFirst = await insertFixture("committed_first", ["complete"]);
      const commitClient = await scopedClient();
      const commitRepository = createPostgresCollectorOzonEnrichmentRepository({
        pool: commitClient,
        transactionOwner: "caller",
      });
      await commitClient.query("SET default_transaction_isolation TO 'repeatable read'");
      await commitClient.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      assert.equal((await commitClient.query("SHOW transaction_isolation")).rows[0].transaction_isolation, "read committed");
      await commitClient.query(
        "UPDATE collect_items SET status='COMPLETE' WHERE id=$1 AND account_id=$2",
        [committedFirst.collectItemId, committedFirst.accountId],
      );
      await commitRepository.completeJobAndCache({
        ...terminalInput(committedFirst, "complete"),
        result: { status: "COMPLETE", descriptionCategoryId: 456 },
      });

      const blockedObserver = await scopedClient();
      const observerPid = Number((await blockedObserver.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      const blockedObservationRepository = createPostgresCollectorOzonEnrichmentRepository({
        pool: {
          async connect() {
            return {
              query(sql, params) { return blockedObserver.query(sql, params); },
              release() { releaseClient(blockedObserver); },
            };
          },
          async query(sql, params) { return blockedObserver.query(sql, params); },
        },
      });
      const laterObservation = blockedObservationRepository.advanceSellerContext({
        accountId: committedFirst.accountId,
        collectorSessionId: committedFirst.collectorSessionId,
        captureContext: NEW_CONTEXT,
        now: new Date(NEW_CONTEXT.observedAt),
      });
      assert.equal(await waitForBlockedClient(pool, observerPid), true);
      await commitClient.query("COMMIT");
      releaseClient(commitClient);
      await laterObservation;

      const committedJob = await setup.query(
        "SELECT status FROM collector_ozon_enrichment_jobs WHERE id=$1",
        [committedFirst.jobs.complete.jobId],
      );
      assert.equal(committedJob.rows[0].status, "SUCCESS");
      assert.equal((await setup.query(
        "SELECT status FROM collector_ozon_enrichment_cache WHERE account_id=$1",
        [committedFirst.accountId],
      )).rows[0].status, "COMPLETE");
      assert.equal((await setup.query(
        "SELECT status FROM collect_items WHERE id=$1",
        [committedFirst.collectItemId],
      )).rows[0].status, "COMPLETE");
      assert.deepEqual((await setup.query(
        "SELECT seller_context_json FROM collector_sessions WHERE id=$1",
        [committedFirst.collectorSessionId],
      )).rows[0].seller_context_json, NEW_CONTEXT);
    } finally {
      releaseObservation?.resolve();
      for (const client of [...openClients]) {
        await client.query("ROLLBACK").catch(() => {});
        releaseClient(client);
      }
      await setup.query("RESET search_path").catch(() => {});
      await setup.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`).catch(() => {});
      setup.release();
      await pool.end();
    }
  });
}
