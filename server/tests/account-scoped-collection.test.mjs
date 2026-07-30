import "../env.mjs";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import test, { after, before } from "node:test";
import {
  closePostgresPool,
  getPostgresPool,
  postgresEnabled,
} from "../db/connection.mjs";
import { runMigrations } from "../db/migrate.mjs";
import { ingestCollectRequestV4 } from "../collection-pipeline.mjs";
import {
  createSubmissionV3,
  hydrateLegacyStateWithV3,
  listCollectItemsV3,
  softDeleteCollectItemsForAccountV4,
  updateCollectItemDraftV4,
} from "../listing-pipeline.mjs";

process.env.QH_LOCAL_NO_LISTEN = "1";
process.env.SONLI_ADMIN_PASSWORD = "task4-test-admin-password";

if (!postgresEnabled()) {
  test("account-scoped collection PostgreSQL behavior", { skip: "PostgreSQL is not configured" }, () => {});
} else {
  const suffix = crypto.randomUUID();
  const accountA = `task4_account_a_${suffix}`;
  const accountB = `task4_account_b_${suffix}`;
  const storeA = `task4_store_a_${suffix}`;
  const requestId = `shared-request-${suffix}`;
  const sourceSku = `shared-sku-${suffix}`;
  const pool = await getPostgresPool();
  const collectItemIds = new Set();
  const collectorToken = `task4_collector_${suffix}`;
  const parentSessionToken = `task4_parent_${suffix}`;

  async function invokeCollector(method, url, body) {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const req = Readable.from(payload ? [Buffer.from(payload)] : []);
    req.method = method;
    req.url = url;
    req.headers = {
      authorization: `Collector ${collectorToken}`,
      ...(payload ? { "content-type": "application/json" } : {}),
    };
    const res = {
      status: 0,
      body: "",
      writeHead(status) { this.status = status; },
      end(text = "") { this.body = String(text || ""); },
    };
    const { handle } = await import("../index.mjs");
    await handle(req, res);
    return {
      status: res.status,
      body: res.body ? JSON.parse(res.body) : null,
    };
  }

  async function cleanup() {
    const jobs = await pool.query(
      "SELECT id,snapshot_id FROM submission_jobs WHERE account_id=ANY($1::text[])",
      [[accountA, accountB]],
    );
    const jobIds = jobs.rows.map((row) => row.id);
    const snapshotIds = jobs.rows.map((row) => row.snapshot_id);
    if (jobIds.length) {
      await pool.query("DELETE FROM outbox_events WHERE aggregate_id=ANY($1::text[])", [jobIds]);
      await pool.query("DELETE FROM audit_events WHERE entity_id=ANY($1::text[])", [jobIds]);
      await pool.query("DELETE FROM submission_jobs WHERE id=ANY($1::text[])", [jobIds]);
    }
    if (snapshotIds.length) {
      await pool.query("DELETE FROM submission_snapshots WHERE id=ANY($1::text[])", [snapshotIds]);
    }
    await pool.query(
      "DELETE FROM collect_requests WHERE account_id=ANY($1::text[])",
      [[accountA, accountB]],
    );
    await pool.query(
      "DELETE FROM collect_raw_payloads WHERE account_id=ANY($1::text[]) OR collect_item_id=ANY($2::text[])",
      [[accountA, accountB], [...collectItemIds]],
    );
    await pool.query(
      "DELETE FROM collect_items WHERE account_id=ANY($1::text[]) OR id=ANY($2::text[])",
      [[accountA, accountB], [...collectItemIds]],
    );
    await pool.query("DELETE FROM stores WHERE id=$1", [storeA]);
    await pool.query("DELETE FROM accounts WHERE id=ANY($1::text[])", [[accountA, accountB]]);
  }

  before(async () => {
    await runMigrations(pool);
    await cleanup();
    await pool.query(
      `INSERT INTO accounts (id,username,display_name,role,status)
       VALUES ($1,$2,$2,'admin','active'),($3,$4,$4,'user','active')`,
      [accountA, `task4-a-${suffix}`, accountB, `task4-b-${suffix}`],
    );
    await pool.query(
      "INSERT INTO sessions (token,account_id) VALUES ($1,$2)",
      [parentSessionToken, accountA],
    );
    await pool.query(
      `INSERT INTO collector_sessions (
         id,token_hash,account_id,parent_session_token,device_fingerprint,
         extension_version,permissions,expires_at
       ) VALUES ($1,$2,$3,$4,'task4-device','task4-test',$5::jsonb,NOW() + INTERVAL '1 hour')`,
      [
        `task4_collector_session_${suffix}`,
        crypto.createHash("sha256").update(collectorToken).digest("hex"),
        accountA,
        parentSessionToken,
        JSON.stringify([
          "collector.upload",
          "collector.job.read",
          "collector.config.read",
        ]),
      ],
    );
  });

  after(async () => {
    await cleanup();
    await closePostgresPool();
  });

  test("collection upload is account-owned, store-neutral, idempotent, and isolated", async () => {
    const input = {
      source: "ozon",
      sourceSku,
      sourceUrl: `https://www.ozon.ru/product/${sourceSku}/`,
      requestId,
      deviceFingerprint: `device-${suffix}`,
      capturedAt: "2026-07-29T00:00:00.000Z",
      payload: {
        sku: sourceSku,
        name: "Account A item",
        images: ["https://cdn.example.test/a.jpg"],
        listingDraft: {
          sku: sourceSku,
          title: "Account A draft",
          price: "100.00",
          variants: [{ sku: sourceSku, offerId: `offer-a-${suffix}` }],
        },
        collectorMetadata: {
          keep: "collector-source",
        },
      },
    };

    const first = await ingestCollectRequestV4({
      authenticatedAccount: { id: accountA },
      input,
    });
    collectItemIds.add(first.collectItemId);
    assert.equal(first.duplicate, false, "an account with zero operating stores can upload");
    const rawListingMetadata = await pool.query(
      `SELECT
         d.data #>> '{targetStore,clientId}' AS target_client_id,
         r.payload #>> '{normalized,collectorMetadata,clientId}' AS forged_collector_client_id
       FROM collect_items i
       JOIN product_drafts d ON d.id=i.current_draft_id
       JOIN LATERAL (
         SELECT payload FROM collect_raw_payloads
         WHERE collect_item_id=i.id AND account_id=i.account_id
         ORDER BY created_at DESC LIMIT 1
       ) r ON TRUE
       WHERE i.id=$1 AND i.account_id=$2`,
      [first.collectItemId, accountA],
    );
    assert.deepEqual(rawListingMetadata.rows[0], {
      target_client_id: null,
      forged_collector_client_id: null,
    }, "collection remains store-neutral until listing preparation");

    const persisted = await pool.query(
      `SELECT
         i.account_id AS item_account_id,
         i.store_id AS item_store_id,
         i.data_collection_store_id AS item_data_store_id,
         r.account_id AS raw_account_id,
         r.store_id AS raw_store_id,
         r.data_collection_store_id AS raw_data_store_id,
         q.account_id AS request_account_id,
         q.store_id AS request_store_id,
         q.data_collection_store_id AS request_data_store_id,
         r.request_id AS source_request_id
       FROM collect_items i
       JOIN collect_raw_payloads r ON r.collect_item_id=i.id
       JOIN collect_requests q ON q.collect_item_id=i.id
       WHERE i.id=$1 AND i.account_id=$2`,
      [first.collectItemId, accountA],
    );
    assert.deepEqual(persisted.rows[0], {
      item_account_id: accountA,
      item_store_id: null,
      item_data_store_id: null,
      raw_account_id: accountA,
      raw_store_id: null,
      raw_data_store_id: null,
      request_account_id: accountA,
      request_store_id: null,
      request_data_store_id: null,
      source_request_id: requestId,
    });

    const duplicate = await ingestCollectRequestV4({
      authenticatedAccount: { id: accountA },
      input: structuredClone(input),
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.collectItemId, first.collectItemId);
    assert.equal(duplicate.requestId, first.requestId);

    await assert.rejects(
      ingestCollectRequestV4({
        authenticatedAccount: { id: accountA },
        input: {
          ...input,
          payload: { ...input.payload, name: "conflicting replay" },
        },
      }),
      (error) => error?.status === 409 && error?.code === "COLLECT_REQUEST_CONFLICT",
    );

    const accountBResult = await ingestCollectRequestV4({
      authenticatedAccount: { id: accountB },
      input: {
        ...input,
        payload: {
          ...input.payload,
          name: "Account B item",
          listingDraft: {
            ...input.payload.listingDraft,
            title: "Account B draft",
          },
        },
      },
    });
    collectItemIds.add(accountBResult.collectItemId);
    assert.notEqual(accountBResult.collectItemId, first.collectItemId);

    await pool.query(
      `UPDATE collect_raw_payloads
       SET payload=jsonb_set(
         payload,
         '{normalized,legacyScope}',
         $3::jsonb,
         true
       )
       WHERE collect_item_id=$1 AND account_id=$2`,
      [
        first.collectItemId,
        accountA,
        JSON.stringify({
          operatingStoreId: `forged-operating-${suffix}`,
          dataCollectionStoreId: `forged-data-${suffix}`,
          sellerCompanyId: `forged-seller-${suffix}`,
          arbitrary: "forged",
        }),
      ],
    );
    const accountAItems = await listCollectItemsV3({ accountId: accountA });
    assert.equal(accountAItems.some((item) => item.id === accountBResult.collectItemId), false);
    const accountAItem = accountAItems.find((item) => item.id === first.collectItemId);
    assert.equal(Object.hasOwn(accountAItem, "legacyScope"), false, "forged raw JSON legacyScope is never trusted");
    assert.equal(accountAItem.listingDraft.targetStore, undefined);
    assert.deepEqual(accountAItem.collectorMetadata, { keep: "collector-source" });

    const hydrated = await hydrateLegacyStateWithV3({
      accounts: [{ id: accountA }],
      caches: { collectBox: [] },
      jobs: {},
    });
    const hydratedItem = hydrated.caches.collectBox.find((item) => item.id === first.collectItemId);
    assert.equal(hydratedItem.accountId, accountA, "trusted hydration restores Web account visibility");
    assert.equal(
      hydrated.caches.collectBox.some((item) => item.id === accountBResult.collectItemId),
      false,
      "trusted hydration keeps other accounts invisible",
    );

    const updatedTargetClientId = `updated-listing-client-${suffix}`;
    const updatedListing = await updateCollectItemDraftV4({
      collectItemId: first.collectItemId,
      accountId: accountA,
      patch: {
        listingDraft: {
          ...accountAItem.listingDraft,
          targetStore: {
            id: `listing-target-${suffix}`,
            label: "Listing target",
            clientId: updatedTargetClientId,
            currencyCode: "RUB",
          },
          sourceMetadata: {
            clientId: `forged-draft-source-client-${suffix}`,
            keep: "updated-draft-source",
          },
        },
        collectorMetadata: {
          clientId: `forged-update-client-${suffix}`,
          keep: "updated-source",
        },
      },
    });
    assert.equal(updatedListing.listingDraft.targetStore.clientId, updatedTargetClientId);
    assert.deepEqual(
      updatedListing.listingDraft.sourceMetadata,
      { keep: "updated-draft-source" },
      "the immediate update response strips non-target listing clientId values",
    );
    assert.deepEqual(updatedListing.collectorMetadata, { keep: "updated-source" });
    const persistedDraftMetadata = await pool.query(
      `SELECT
         d.data #>> '{targetStore,clientId}' AS target_client_id,
         d.data #>> '{sourceMetadata,clientId}' AS source_client_id,
         d.data #>> '{sourceMetadata,keep}' AS source_keep
       FROM collect_items i
       JOIN product_drafts d ON d.id=i.current_draft_id
       WHERE i.id=$1 AND i.account_id=$2`,
      [first.collectItemId, accountA],
    );
    assert.deepEqual(persistedDraftMetadata.rows[0], {
      target_client_id: updatedTargetClientId,
      source_client_id: null,
      source_keep: "updated-draft-source",
    });
    const listedAfterUpdate = (await listCollectItemsV3({ accountId: accountA }))
      .find((item) => item.id === first.collectItemId);
    assert.equal(listedAfterUpdate.listingDraft.targetStore.clientId, updatedTargetClientId);
    assert.deepEqual(
      listedAfterUpdate.listingDraft.sourceMetadata,
      { keep: "updated-draft-source" },
    );
    assert.equal(Object.hasOwn(listedAfterUpdate.collectorMetadata || {}, "clientId"), false);
    assert.equal(
      await updateCollectItemDraftV4({
        collectItemId: accountBResult.collectItemId,
        accountId: accountA,
        patch: { listingDraft: { title: "cross-account update" } },
      }),
      null,
    );
    assert.equal(
      await softDeleteCollectItemsForAccountV4(accountA, [accountBResult.collectItemId]),
      0,
    );

    await pool.query(
      `INSERT INTO stores (id,owner_account_id,label,client_id,status)
       VALUES ($1,$2,'Task 4 target store',$3,'active')`,
      [storeA, accountA, `task4-client-${suffix}`],
    );
    await assert.rejects(
      createSubmissionV3({
        collectItem: accountBResult.item,
        accountId: accountA,
        storeId: storeA,
        normalizedItems: [{
          offer_id: `offer-b-${suffix}`,
          name: "cross-account prepare",
          price: "100.00",
          currency_code: "CNY",
          images: ["https://cdn.example.test/b.jpg"],
          description_category_id: 1,
          type_id: 2,
          attributes: [],
        }],
      }),
      (error) => error?.status === 404 && error?.code === "COLLECT_ITEM_ACCOUNT_FORBIDDEN",
    );
  });

  test("client scope fields are rejected instead of honored", async () => {
    for (const field of [
      "accountId",
      "createdBy",
      "storeId",
      "operatingStoreId",
      "dataCollectionStoreId",
      "sellerCompanyId",
    ]) {
      await assert.rejects(
        ingestCollectRequestV4({
          authenticatedAccount: { id: accountA },
          input: {
            source: "ozon",
            sourceSku: `forbidden-${field}-${suffix}`,
            requestId: `forbidden-${field}-${suffix}`,
            payload: { sku: `forbidden-${field}-${suffix}` },
            [field]: `attacker-${suffix}`,
          },
        }),
        (error) => error?.status === 400 && error?.code === "COLLECTOR_SCOPE_FIELD_FORBIDDEN",
        field,
      );
    }
  });

  test("PostgreSQL batch route rejects forbidden envelope and payload scope fields", async () => {
    for (const field of [
      "accountId",
      "createdBy",
      "storeId",
      "operatingStoreId",
      "dataCollectionStoreId",
      "sellerCompanyId",
    ]) {
      const response = await invokeCollector("POST", "/sources/ozon/collect/batch", {
        [field]: `attacker-${field}-${suffix}`,
        items: [{
          source: "ozon",
          sourceSku: `route-envelope-${field}-${suffix}`,
          requestId: `route-envelope-${field}-${suffix}`,
          payload: { sku: `route-envelope-${field}-${suffix}` },
        }],
      });
      assert.equal(response.status, 400, `${field}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.code, "COLLECTOR_SCOPE_FIELD_FORBIDDEN", field);
    }

    const payloadControl = await invokeCollector("POST", "/sources/ozon/collect", {
      source: "ozon",
      sourceSku: `route-payload-control-${suffix}`,
      requestId: `route-payload-control-${suffix}`,
      payload: {
        sku: `route-payload-control-${suffix}`,
        storeId: `attacker-payload-store-${suffix}`,
      },
    });
    assert.equal(payloadControl.status, 400);
    assert.equal(payloadControl.body.code, "COLLECTOR_SCOPE_FIELD_FORBIDDEN");

    const inserted = await pool.query(
      "SELECT COUNT(*)::int AS count FROM collect_requests WHERE account_id=$1 AND source_sku LIKE $2",
      [accountA, `route-%-${suffix}`],
    );
    assert.equal(inserted.rows[0].count, 0);
  });
}
