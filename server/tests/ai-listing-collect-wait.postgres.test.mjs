// Explicit opt-in: restored audit database or the isolated fixture network. No dotenv or migrations.
import "./support/dedicated-postgres-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { createAiListingService } from "../ai-listing-service.mjs";
import { createAiListingRepository } from "../ai-listing-repository.mjs";
import { loadAiListingCollectSources } from "../ai-listing-runtime.mjs";

const enabled = process.env.SONLI_POSTGRES_TESTS === "1";
const databaseUrl = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
if (enabled) {
  let url;
  try { url = new URL(databaseUrl); } catch { /* Report only the gate, never credentials. */ }
  const isolated=process.env.SONLI_TEST_NETWORK_ISOLATED==='1'&&url?.hostname==='ozon-pipeline-repair-qa-db'&&url?.pathname==='/ozon_pipeline_fixture';
  if (!url || !["postgres:", "postgresql:"].includes(url.protocol) || (!isolated&&(url.hostname !== "127.0.0.1"
    || url.pathname !== "/sonli_audit_20260910")) || process.env.DATABASE_URL !== databaseUrl) {
    throw new Error("Requires SONLI_POSTGRES_TESTS=1 and explicit SONLI_MIGRATION_TEST_DATABASE_URL for 127.0.0.1/sonli_audit_20260910");
  }
}

test("Postgres collect handoff preserves exact identity across waiting, restart, replay and source deletion (transaction rollback)",
  { skip: !enabled, timeout: 30000 }, async t => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, application_name: "ai-collect-wait-rollback-test" });
    const client = await pool.connect();
    const prefix = `ai-collect-wait-${randomUUID()}`;
    const accountId = `${prefix}-owner`, otherAccount = `${prefix}-other`;
    const retainedAccount = `${prefix}-retained-owner`, retainedId = `${prefix}-retained-task`;
    const isolatedFixture = process.env.SONLI_TEST_NETWORK_ISOLATED === "1";
    const fixtureAccounts = [accountId, otherAccount, ...(isolatedFixture ? [retainedAccount] : [])];
    const collectId = `${prefix}-collect`, siblingCollectId = `${prefix}-sibling`, otherCollectId = `${prefix}-foreign`;
    const calls = [], submissions = [], billingCalls = [], reads = [];
    // A clock before all retained audit tasks isolates the real production claim query.
    // The precondition below fails before fixtures if any historical row could be claimed.
    let now = -1_000_000_000_000;
    const config = { targetStoreId: "fixture-store", targetWarehouseId: "fixture-warehouse", manualReview: true, prompt: "frozen fixture prompt" };
    const local = { query: (...args) => client.query(...args),
      connect: async()=>({query:(sql,args)=>client.query(({BEGIN:"SAVEPOINT ai_claim",COMMIT:"RELEASE SAVEPOINT ai_claim",ROLLBACK:"ROLLBACK TO SAVEPOINT ai_claim"})[sql]||sql,args),release(){}}) };
    const repository = createAiListingRepository({ pool: local });
    const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    async function createCollect(id, owner, sku) {
      const snapshot = { name: "Collect handoff fixture", images: [`https://source.test/${sku}.jpg`],
        sourceCategory: { description_category_id: 10, type_id: 20 }, enrichment: { status: "PENDING_ENRICHMENT" } };
      const draft = { sku, currencyCode: "RUB", price: "123.45", logistics: { depth: 120, width: 130, height: 140 },
        variants: [{ sku, images: snapshot.images }] };
      await client.query("INSERT INTO collect_items(id,account_id,source,source_sku,summary) VALUES($1,$2,'ozon',$3,$4)", [id, owner, sku, snapshot]);
      await client.query("INSERT INTO product_drafts(id,collect_item_id,data_hash,data) VALUES($1,$2,$3,$4)", [id + "-draft", id, hash(draft), draft]);
      await client.query("UPDATE collect_items SET current_draft_id=$2 WHERE id=$1 AND account_id=$3", [id, id + "-draft", owner]);
    }
    async function job(id, owner, collect, sku, status, createdAt) {
      await client.query(`INSERT INTO collector_ozon_enrichment_jobs
        (id,account_id,request_id,collect_item_id,sku,status,refresh_bundle,deadline_at,result_json,error_json,completed_at,created_at)
        VALUES($1,$2,$1,$3,$4,$5,'{}',now()+interval '1 day',$6,$7,$8,$9)`,
      [id, owner, collect, sku, status, status === "SUCCESS" ? { status: "COMPLETE" } : null,
        status === "FAILED" ? { code: "FIXTURE_FAILURE" } : null,
        ["FAILED", "SUCCESS"].includes(status) ? new Date("2020-01-01") : null, createdAt]);
    }
    const loadSources = input => loadAiListingCollectSources({ ...input, pool: local,
      // Public collect preview boundary; rows and draft versions below are real persisted fixtures.
      readCollectItems: async ({ accountId: owner, ids, limit }) => {
        reads.push({ accountId: owner, ids: [...ids] });
        const rows = (await client.query(`SELECT c.id,c.account_id,c.source_sku,c.summary,d.data,d.version
          FROM collect_items c JOIN product_drafts d ON d.id=c.current_draft_id
          WHERE c.account_id=$1 AND c.id=ANY($2::text[]) AND c.deleted_at IS NULL ORDER BY c.id LIMIT $3`, [owner, ids, limit])).rows;
        return rows.map(row => ({ ...row.summary, id: row.id, accountId: row.account_id, sku: row.source_sku,
          listingDraft: row.data, draftVersion: row.version }));
      },
      buildListingItems: snapshot => snapshot.listingDraft.variants.map(variant => ({
        scraped_sku: variant.sku, offer_id: variant.sku, currency_code: snapshot.listingDraft.currencyCode,
        price: snapshot.listingDraft.price, ...snapshot.listingDraft.logistics, images: variant.images,
      })),
    });
    const ports = { repository, loadSources, clock: () => now,
      collectSku: async () => { throw new Error("Excel/Seller recollection must not be called"); },
      generateImage: async input => { calls.push(input); return { generatedUrl: `https://generated.test/${input.sku}.jpg` }; },
      submitListing: async input => { submissions.push(input); return { submissionId: "fixture-submission" }; },
      readSubmission: async () => ({ status: "COMPLETED" }),
      billing: { reconcile: async input => { billingCalls.push(input); return { funded: true }; } },
    };
    let task, initial, initialConfig;
    try {
      assert.equal((await client.query("SELECT current_database() AS name")).rows[0].name, new URL(databaseUrl).pathname.slice(1));
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='3s'");
      await client.query("SET LOCAL statement_timeout='10s'");
      assert.equal(Number((await client.query(`SELECT count(*) AS n FROM ai_image_listing_tasks
        WHERE status IN ('QUEUED','COLLECTING','GENERATING','READY_TO_SUBMIT','SUBMITTING','SUBMITTED')
        AND next_run_at <= $1`, [now + 1_000_000])).rows[0].n), 0, "historical tasks must be outside the fixture clock");
      await client.query("INSERT INTO accounts(id,username,role) VALUES($1,$1,'admin'),($2,$2,'admin')", [accountId, otherAccount]);
      if (isolatedFixture) {
        // Restore a representative legacy frozen row directly, without passing it through
        // today's task writer. Its collect row is physically removed, as in the audit DB.
        await client.query("INSERT INTO accounts(id,username,role) VALUES($1,$1,'admin')", [retainedAccount]);
        const retainedCollectId = `${prefix}-retained-collect`, sku = "175924375";
        await createCollect(retainedCollectId, retainedAccount, sku);
        const sourceUrl = `https://source.test/${sku}.jpg`, generatedUrl = `https://generated.test/${sku}.jpg`;
        const body = { id: retainedId, accountId: retainedAccount, dedupeKey: retainedId,
          sourceType: "COLLECT_BOX", sourceId: retainedCollectId, sku, name: "Сохранённый светильник",
          requestHash: hash({ retainedCollectId, config }), config: structuredClone(config),
          source: { collectItemId: retainedCollectId, sku, sourceSnapshot: { source: "ozon", legacyEvidence: "retained" },
            items: [{ sku, images: [sourceUrl], listingItem: { offer_id: "原货号-175924375", name: "Сохранённый светильник",
              price: "123.45", currency_code: "RUB", weight: 250, depth: 120, width: 130, height: 140 } }] },
          images: [{ sku, index: 0, sourceUrl, generatedUrl, status: "COMPLETED" }],
          status: "AWAITING_REVIEW", createdAt: Date.parse("2020-01-01"), updatedAt: Date.parse("2020-01-02") };
        await client.query(`INSERT INTO ai_image_listing_tasks(id,account_id,dedupe_key,status,body,next_run_at,created_at,work_phase)
          VALUES($1,$2,$1,'AWAITING_REVIEW',$3,$4,$4,'idle')`, [retainedId, retainedAccount, body, body.createdAt]);
        await client.query("DELETE FROM collect_items WHERE id=$1 AND account_id=$2", [retainedCollectId, retainedAccount]);
      }
      await createCollect(collectId, accountId, "175924376");
      await createCollect(siblingCollectId, accountId, "175924376");
      await createCollect(otherCollectId, otherAccount, "175924376");
      await job(prefix + "-old", accountId, collectId, "175924376", "SUCCESS", "2020-01-01");
      await job(prefix + "-active", accountId, collectId, "175924376", "PENDING", "2020-01-02");
      await job(prefix + "-sibling-job", accountId, siblingCollectId, "175924376", "FAILED", "2020-01-03");
      await job(prefix + "-foreign-job", otherAccount, otherCollectId, "175924376", "FAILED", "2020-01-04");
      const service = createAiListingService(ports);
      const request = { accountId, collectItemIds: [collectId], idempotencyKey: "same-click", config };
      await t.test("latest real jobs bind account plus collect ID plus SKU; concurrent same-key creation returns one task", async () => {
        const loaded = await loadSources({ accountId, collectItemIds: [collectId, siblingCollectId, otherCollectId], config });
        assert.deepEqual(loaded.map(source => [source.collectItemId, source.enrichmentJobs]), [
          [collectId, [{ sku: "175924376", status: "PENDING" }]],
          [siblingCollectId, [{ sku: "175924376", status: "FAILED" }]],
        ]);
        const created = await Promise.all([service.createFromCollect(request), service.createFromCollect(request)]);
        task = created[0][0]; assert.equal(created[1][0].id, task.id); assert.equal(task.status, "COLLECTING");
        const rows = await repository.getMany({ accountId, taskIds: [task.id] }); assert.equal(rows.length, 1);
        initial = structuredClone(rows[0].collectWait.initialSource); initialConfig = structuredClone(rows[0].config);
        assert.deepEqual(rows[0].collectWait.selectedSkus, ["175924376"]);
        assert.equal(rows[0].source, null); assert.deepEqual(rows[0].images, []);
        assert.deepEqual(await repository.getMany({ accountId: otherAccount, taskIds: [task.id] }), []);
      });
      await t.test("PENDING and PROCESSING polls release real leases for 30 seconds with zero images, quotes or charges", async () => {
        await service.processNext();
        let stored = await repository.get({ accountId, taskId: task.id });
        assert.equal(stored.leaseToken, null); assert.equal(stored.leaseExpiresAt, null); assert.equal(stored.nextRunAt, now + 30000);
        now += 29999; assert.equal(await service.processNext(), null);
        await client.query("UPDATE collector_ozon_enrichment_jobs SET status='PROCESSING' WHERE id=$1 AND account_id=$2", [prefix + "-active", accountId]);
        now++; assert.equal((await createAiListingService(ports).processNext()).status, "COLLECTING");
        stored = await repository.get({ accountId, taskId: task.id }); assert.equal(stored.nextRunAt, now + 30000); assert.equal(stored.leaseToken, null);
        assert.deepEqual(calls, []); assert.deepEqual(submissions, []); assert.deepEqual(billingCalls, []);
        for (const table of ["ai_task_billing", "ai_wallet_entries", "ai_user_channel_requests"]) {
          assert.equal(Number((await client.query(`SELECT count(*) AS n FROM ${table} WHERE account_id=$1`, [accountId])).rows[0].n), 0);
        }
      });
      await t.test("restart freezes the completed draft only for original SKUs, then keeps manual review and creation config", async () => {
        await client.query(`UPDATE product_drafts SET data=jsonb_set(data,'{logistics,weight}','375'::jsonb),version=version+1
          WHERE id=$1`, [collectId + "-draft"]);
        await client.query(`UPDATE product_drafts SET data=jsonb_set(data,'{variants}',data->'variants'||$2::jsonb)
          WHERE id=$1`, [collectId + "-draft", JSON.stringify([{ sku: "new-unselected", images: ["https://source.test/new.jpg"] }])]);
        await client.query(`UPDATE collector_ozon_enrichment_jobs SET status='SUCCESS',result_json='{"status":"COMPLETE"}',completed_at=now()
          WHERE id=$1 AND account_id=$2`, [prefix + "-active", accountId]);
        await job(prefix + "-added-sku", accountId, collectId, "new-unselected", "PENDING", "2020-01-05");
        config.prompt = "later preset edit must not leak";
        now += 30000; assert.equal((await createAiListingService(ports).processNext()).status, "AWAITING_REVIEW");
        const stored = await repository.get({ accountId, taskId: task.id });
        assert.deepEqual(stored.source.items.map(row => row.sku), ["175924376"]);
        assert.equal(stored.source.items[0].listingItem.weight, 375);
        assert.deepEqual(stored.collectWait.initialSource, initial); assert.deepEqual(stored.config, initialConfig);
        assert.deepEqual(calls.map(call => call.sku), ["175924376"]); assert.equal(calls[0].prompt, "frozen fixture prompt");
        assert.equal(submissions.length, 0);
      });
      await t.test("physical source deletion cannot block same-key replay or a frozen task's approved submission", async () => {
        await client.query("DELETE FROM collect_items WHERE id=$1 AND account_id=$2", [collectId, accountId]);
        reads.length = 0;
        const restarted = createAiListingService(ports);
        const replay = { ...request, config: initialConfig };
        assert.equal((await restarted.createFromCollect(replay))[0].id, task.id);
        await assert.rejects(restarted.createFromCollect({ ...replay, config: { ...initialConfig, stock: 999 } }), { code: "AI_LISTING_IDEMPOTENCY_CONFLICT" });
        assert.equal(reads.length, 0);
        await restarted.approveTask({ accountId, taskId: task.id });
        assert.equal((await restarted.processNext()).status, "SUBMITTED"); assert.equal(reads.length, 0);
        assert.deepEqual(submissions[0].source.items.map(row => row.sku), ["175924376"]);
        assert.equal(submissions[0].config.targetStoreId, "fixture-store");
        assert.equal(submissions[0].source.items[0].listingItem.currency_code, "RUB");
        now += 15000; assert.equal((await restarted.processNext()).status, "COMPLETED");
        assert.equal(calls.length, 1); assert.equal(submissions.length, 1);
      });
      await t.test("deletion while still waiting stops without collection or billing and retains admission evidence", async () => {
        const pendingId = prefix + "-pending-delete";
        await createCollect(pendingId, accountId, "2157503620");
        await job(prefix + "-pending-delete-job", accountId, pendingId, "2157503620", "PENDING", "2020-01-06");
        const request = { accountId, collectItemIds: [pendingId], idempotencyKey: "pending-delete", config: initialConfig };
        const [pending] = await service.createFromCollect(request);
        const before = await repository.get({ accountId, taskId: pending.id });
        const bills = billingCalls.length;
        await client.query("DELETE FROM collect_items WHERE id=$1 AND account_id=$2", [pendingId, accountId]);
        const stopped = await createAiListingService(ports).processNext();
        assert.equal(stopped.status, "COLLECTION_FAILED"); assert.match(stopped.errorMessage, /来源.*删除/);
        const after = await repository.get({ accountId, taskId: pending.id });
        assert.equal(after.source, null); assert.equal(after.leaseToken, null);
        assert.deepEqual(after.collectWait.initialSource, before.collectWait.initialSource);
        assert.equal(billingCalls.length, bills); assert.equal(calls.length, 1); assert.equal(submissions.length, 1);
        reads.length = 0;
        assert.equal((await service.createFromCollect(request))[0].id, pending.id); assert.equal(reads.length, 0);
      });
      await t.test("a manually repaired draft with a retained FAILED job can freeze and replay after source deletion", async () => {
        const repairedCollectId=prefix+"-repaired";
        await createCollect(repairedCollectId,accountId,"175924377");
        await job(prefix+"-repaired-job",accountId,repairedCollectId,"175924377","FAILED","2020-01-04");
        await client.query("UPDATE product_drafts SET data=jsonb_set(data,'{logistics,weight}','250'::jsonb) WHERE id=$1", [repairedCollectId + "-draft"]);
        const request = { accountId, collectItemIds: [repairedCollectId], idempotencyKey: "legacy-shape", config: initialConfig };
        const [legacyTask] = await service.createFromCollect(request);
        assert.equal((await repository.get({ accountId, taskId: legacyTask.id })).collectWait, undefined);
        assert.equal((await client.query("SELECT status FROM collector_ozon_enrichment_jobs WHERE id=$1 AND account_id=$2",
          [prefix + "-repaired-job", accountId])).rows[0].status, "FAILED");
        await client.query("UPDATE ai_image_listing_tasks SET body=body #- '{source,enrichmentJobs}' WHERE id=$1 AND account_id=$2", [legacyTask.id, accountId]);
        await client.query("DELETE FROM collect_items WHERE id=$1 AND account_id=$2", [repairedCollectId, accountId]);
        reads.length = 0;
        assert.equal((await service.createFromCollect(request))[0].id, legacyTask.id);
        assert.equal((await createAiListingService(ports).processNext()).status, "AWAITING_REVIEW");
        assert.equal(reads.length, 0);
        // Read a persisted retained task without changing it or requiring its deleted collect row.
        const retained = (await client.query(`SELECT id,account_id,body FROM ai_image_listing_tasks
          WHERE account_id<>ALL($1::text[]) AND body->'source' IS NOT NULL AND body->'source'<>'null'::jsonb
          AND ($2::text IS NULL OR id=$2)
          ORDER BY created_at,id LIMIT 1`, [[accountId, otherAccount], isolatedFixture ? retainedId : null])).rows[0];
        assert.ok(retained, "requires a persisted historical task from restored audit data or the isolated fixture");
        const retainedBefore = (await client.query("SELECT to_jsonb(t) AS row FROM ai_image_listing_tasks t WHERE id=$1", [retained.id])).rows[0].row;
        const [read] = await repository.getMany({ accountId: retained.account_id, taskIds: [retained.id] });
        assert.deepEqual(read.source, retained.body.source);
        assert.equal(read.requestHash, retained.body.requestHash);
        assert.deepEqual(await repository.getMany({ accountId, taskIds: [retained.id] }), []);
        assert.deepEqual((await client.query("SELECT to_jsonb(t) AS row FROM ai_image_listing_tasks t WHERE id=$1", [retained.id])).rows[0].row, retainedBefore);
        if (isolatedFixture) assert.equal((await client.query("SELECT count(*)::int n FROM collect_items WHERE id=$1", [read.sourceId])).rows[0].n, 0);
      });
    } finally {
      await client.query("ROLLBACK");
      assert.equal(Number((await client.query("SELECT count(*) AS n FROM accounts WHERE id=ANY($1::text[])", [fixtureAccounts])).rows[0].n), 0);
      client.release(); await pool.end();
    }
  });
