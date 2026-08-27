import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildGeneratedAssetObjectKey, sha256 } from "../auto-listing-asset-store.mjs";
import { evaluateGeneratedCheckerEvidence } from "../auto-listing-result-checker.mjs";
import { buildRichContentEvidenceIdentity } from "../auto-listing-rich-content.mjs";
import { createPostgresRichContentRepository } from "../auto-listing-rich-content-repository.mjs";

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
const hash = (character) => character.repeat(64);

export async function runRichContentPostgresFixture({ connectionString } = {}) {
  if (typeof connectionString !== "string" || !connectionString.trim()) {
    throw new Error("A dedicated PostgreSQL connection string is required");
  }
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const schema = `rich_content_031_${suffix}`;
  const accountId = `account-${suffix}`;
  const storeId = `store-${suffix}`;
  const warehouseId = `warehouse-${suffix}`;
  const snapshotId = `snapshot-${suffix}`;
  const strategyId = `strategy-${suffix}`;
  const jobId = `job-${suffix}`;
  const itemId = `item-${suffix}`;
  const profileId = `profile-${suffix}`;
  const planId = `plan-${suffix}`;
  const legacyId = `legacy-rich-${suffix}`;
  try {
    await client.query(`CREATE SCHEMA ${quote(schema)}`);
    await client.query(`SET search_path TO ${quote(schema)}, public`);
    const migrations = (await readdir(migrationsDir))
      .filter((file) => /^\d{3}_.+\.sql$/.test(file) && Number(file.slice(0, 3)) <= 30)
      .sort();
    for (const migration of migrations) {
      await client.query(await readFile(path.join(migrationsDir, migration), "utf8"));
    }

    await client.query(
      "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
      [accountId, `user-${suffix}`],
    );
    await client.query(
      "INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id) VALUES ($1,$2,$2,$3,'active',$4)",
      [storeId, `Store ${suffix}`, `client-${suffix}`, accountId],
    );
    await client.query(
      "INSERT INTO warehouses (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived) VALUES ($1,$2,$3,'FBS','active',TRUE,FALSE)",
      [warehouseId, storeId, `platform-${suffix}`],
    );
    await client.query(
      "INSERT INTO ai_content_strategy_versions (id,account_id,strategy_key,version,status,content,content_hash) VALUES ($1,$2,$3,1,'PUBLISHED','{}'::jsonb,$4)",
      [strategyId, accountId, `strategy-${suffix}`, hash("a")],
    );
    await client.query(
      "INSERT INTO auto_listing_source_snapshots (id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash) VALUES ($1,$2,'COLLECT_BOX',$3,'1','{}'::jsonb,$4)",
      [snapshotId, accountId, `record-${suffix}`, hash("b")],
    );
    await client.query(
      "INSERT INTO auto_listing_jobs (id,account_id,source_type,idempotency_key,config_hash,strategy_version_id) VALUES ($1,$2,'COLLECT_BOX',$3,$4,$5)",
      [jobId, accountId, `job-key-${suffix}`, hash("c"), strategyId],
    );
    await client.query(
      "INSERT INTO auto_listing_job_items (id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id) VALUES ($1,$2,$3,$4,$5,$6)",
      [itemId, jobId, accountId, snapshotId, storeId, warehouseId],
    );
    await client.query(
      `INSERT INTO ai_gateway_profiles (
         id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
         text_model,image_model,config_version
       ) VALUES ($1,$2,'Primary','https://gateway.invalid','AI_GATEWAY_KEY','SUB2API_RESPONSES',
         'SUB2API_OPENAI_IMAGES','text-model','image-model',1)`,
      [profileId, accountId],
    );
    await client.query(
      `INSERT INTO ai_content_plans (
         id,account_id,job_id,item_id,source_snapshot_id,strategy_version_id,profile_id,
         strategy_hash,config_hash,source_hash,input_hash,planner_model,profile_version,
         prompt_template_version,plan,plan_hash,visual_groups_hash,visual_groups,gateway_request_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'planner',1,'plan-v1','{}'::jsonb,
         $12,$13,'{"sourceHash":"source","groups":[],"reasonCodes":[],"visualGroupsHash":"hash"}'::jsonb,'plan-request')`,
      [planId, accountId, jobId, itemId, snapshotId, strategyId, profileId,
        hash("d"), hash("e"), hash("f"), hash("0"), hash("1"), hash("2")],
    );

    const legacyContent = { version: "LEGACY", blocks: [{ type: "TEXT", text: "история" }] };
    await client.query(
      `INSERT INTO ai_rich_content_results (
         id,account_id,job_id,item_id,plan_id,profile_id,source_hash,asset_hash,input_hash,
         attempt_no,model_name,profile_version,prompt_template_version,rich_content,output_hash,
         checker_result,status,accepted_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'legacy-source','legacy-assets','legacy-input',1,'legacy-model',1,
         'legacy-v1',$7::jsonb,'legacy-output','{"accepted":true}'::jsonb,'ACCEPTED',NOW())`,
      [legacyId, accountId, jobId, itemId, planId, profileId, JSON.stringify(legacyContent)],
    );
    const before = await client.query("SELECT * FROM ai_rich_content_results WHERE id=$1", [legacyId]);
    const migration031 = await readFile(path.join(migrationsDir, "031_auto_listing_rich_content_attempt_evidence.sql"), "utf8");
    await client.query(migration031);
    await client.query(migration031);
    const migration078 = await readFile(path.join(migrationsDir, "078_auto_listing_rich_embedded_numeric_evidence.sql"), "utf8");
    await client.query(migration078);
    await client.query(migration078);
    const after = await client.query("SELECT * FROM ai_rich_content_results WHERE id=$1", [legacyId]);
    const legacyTerminalPreserved = before.rows[0].status === after.rows[0].status
      && JSON.stringify(before.rows[0].rich_content) === JSON.stringify(after.rows[0].rich_content)
      && before.rows[0].accepted_at.getTime() === after.rows[0].accepted_at.getTime()
      && after.rows[0].plan_hash === null && after.rows[0].lease_token === null;

    let nullAcceptedRejected = false;
    try {
      await client.query(
        `INSERT INTO ai_rich_content_results (
           id,account_id,job_id,item_id,plan_id,profile_id,source_hash,asset_hash,input_hash,
           attempt_no,model_name,profile_version,prompt_template_version,rich_content,output_hash,
           checker_result,status,accepted_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,'text-model',1,'rich-v1','{"version":"x"}'::jsonb,
           $10,'{"accepted":true}'::jsonb,'ACCEPTED',NOW())`,
        [`null-accepted-${suffix}`, accountId, jobId, itemId, planId, profileId,
          hash("3"), hash("4"), hash("5"), hash("6")],
      );
    } catch (error) {
      nullAcceptedRejected = error?.code === "23514";
    }

    const factEvidence = [{
      factId: "fact.capacity", field: "capacity", kind: "CAPACITY",
      value: "500 мл", numericValue: 500, unit: "мл", sourcePath: "attributes.capacity",
    }];
    const sourceReference = {
      assetId: `source-${suffix}`, contentHash: hash("6"), contentType: "image/png",
      width: 768, height: 1024, size: 1024,
    };
    const imageCheckerResult = {
      matchesProduct: true, claimsVerified: true, russianText: true, quality: "PASS",
      prohibitedContent: false, reasons: [],
      evidence: {
        identity: { color: true, shape: true, accessoryCount: true, sourceAssetIds: [sourceReference.assetId] },
        claims: [{
          text: "Объём 500 мл", sourceFactId: factEvidence[0].factId, field: factEvidence[0].field,
          value: factEvidence[0].value, numericValue: factEvidence[0].numericValue, unit: factEvidence[0].unit,
        }],
        detectedTexts: ["Объём 500 мл"], language: "ru", qualityFlags: [], prohibitedFlags: [],
      },
    };
    const checkerModelEvidence = {
      requestedTextModel: "text-model", gatewayReportedTextModel: "text-model",
      gatewayReportedTextModelPresent: true,
    };
    const legacyObjectKey = (entry) => `auto-listing/${[
      entry.accountId, entry.jobId, entry.itemId, entry.planId, entry.visualGroupKey, entry.slotKey,
    ].map((value) => Buffer.from(value, "utf8").toString("base64url")).join("/")}/${entry.inputHash}/${entry.contentHash}.png`;
    const completeAssetEvidence = (index) => {
      const assetId = index === 0 ? "asset-main" : `asset-extra-${index}`;
      const slotKey = index === 0 ? "main:main:01" : `main:selling-point:0${index}`;
      const role = index === 0 ? "MAIN" : "SELLING_POINT";
      const contentHash = crypto.createHash("sha256").update(`asset-${index}`).digest("hex");
      const attemptIdentityHash = crypto.createHash("sha256").update(`attempt-${index}`).digest("hex");
      const assetInputHash = crypto.createHash("sha256").update(`asset-input-${index}`).digest("hex");
      const keyInput = {
        accountId, jobId, itemId, planId, visualGroupKey: "main", slotKey,
        attemptIdentityHash, attemptNo: 1, inputHash: assetInputHash, contentHash,
      };
      const checkerRequestId = `checker-${assetId}`;
      const checkerEvidence = evaluateGeneratedCheckerEvidence({
        checkerResult: imageCheckerResult, references: [sourceReference], facts: factEvidence,
        checkerModel: "text-model", profile: { id: profileId, accountId, configVersion: 1 },
        templateVersion: "image-v1", requestId: checkerRequestId, generatedHash: contentHash,
        checkerModelEvidence, textRequired: true,
      }).evidence;
      return {
        assetId, status: "ACCEPTED", accountId, jobId, itemId, planId, visualGroupKey: "main", slotKey, role,
        attemptIdentityHash, attemptNo: 1, inputHash: assetInputHash, generationSize: "768x1024",
        contentHash, objectKeyVersion: "ATTEMPT_V2", objectKey: buildGeneratedAssetObjectKey(keyInput),
        contentType: "image/png", width: 768, height: 1024, size: 2048,
        gatewayRequestId: `gateway-${assetId}`, checkerRequestId,
        modelEvidence: {
          requestedImageModel: "image-model", gatewayReportedImageModel: "image-model",
          gatewayReportedImageModelPresent: true, orchestratorModel: "",
        },
        profileId, profileVersion: 1, modelName: "image-model",
        planHash: hash("1"), sourceHash: hash("2"), strategyHash: hash("a"), configHash: hash("b"),
        visualGroupsHash: hash("c"), promptTemplateVersion: "image-v1",
        promptHash: crypto.createHash("sha256").update(`prompt-${index}`).digest("hex"),
        checkerEvidence, sourceAssetEvidence: [sourceReference], regeneration: null,
      };
    };
    const assetEvidence = Array.from({ length: 6 }, (_, index) => completeAssetEvidence(index));
    const evidenceValidation = await client.query(
      `SELECT auto_listing_rich_fact_evidence_valid($1::jsonb) AS fact_valid,
              auto_listing_rich_asset_evidence_valid($2::jsonb) AS asset_valid,
              auto_listing_rich_asset_evidence_matches(
                $2::jsonb,$1::jsonb,$3,$4,$5,$6,$7,$8,$9,$10,$11
              ) AS asset_matches`,
      [JSON.stringify(factEvidence), JSON.stringify(assetEvidence), accountId, jobId, itemId, planId,
        hash("1"), hash("2"), profileId, 1, "text-model"],
    );
    const assetValidation = await client.query(
      `SELECT BOOL_AND(auto_listing_rich_source_asset_evidence_valid(entry->'sourceAssetEvidence')) AS sources_valid,
              BOOL_AND(auto_listing_generation_object_key_v2_complete(
                entry->>'accountId',entry->>'jobId',entry->>'itemId',entry->>'planId',
                entry->>'visualGroupKey',entry->>'slotKey',entry->>'attemptIdentityHash',
                (entry->>'attemptNo')::integer,entry->>'inputHash',entry->>'contentHash',entry->>'objectKey'
              )) AS object_keys_valid,
              BOOL_AND(auto_listing_rich_asset_checker_evidence_valid(
                entry->'checkerEvidence',entry->'sourceAssetEvidence',entry->>'contentHash',
                entry->>'checkerRequestId',entry->'checkerEvidence'->>'checkerModel',entry->>'profileId',
                entry->>'accountId',(entry->>'profileVersion')::integer,entry->>'promptTemplateVersion'
              )) AS checker_valid
       FROM jsonb_array_elements($1::jsonb) AS assets(entry)`,
      [JSON.stringify(assetEvidence)],
    );
    const claimValidation = await client.query(
      `SELECT BOOL_AND(auto_listing_rich_text_matches_bindings(
                claim->>'text',jsonb_build_array(claim - 'text')
              )) AS text_bindings_valid
       FROM jsonb_array_elements($1::jsonb) AS assets(entry),
            jsonb_array_elements(entry->'checkerEvidence'->'checkerResult'->'evidence'->'claims') AS claims(claim)`,
      [JSON.stringify(assetEvidence)],
    );
    assert.deepEqual(claimValidation.rows[0], { text_bindings_valid: true });
    assert.deepEqual(assetValidation.rows[0], {
      sources_valid: true, object_keys_valid: true, checker_valid: true,
    });
    const embeddedNumericBinding = {
      sourceFactId: "fact.identity.name", field: "variants.name",
      value: "Терморегулятор до 3500Вт Для теплого пола", numericValue: null, unit: null,
    };
    const embeddedNumericValidation = await client.query(
      `SELECT auto_listing_rich_text_matches_bindings($1,$2::jsonb) AS binding_valid`,
      [embeddedNumericBinding.value, JSON.stringify([embeddedNumericBinding])],
    );
    assert.deepEqual(embeddedNumericValidation.rows[0], { binding_valid: true });
    assert.deepEqual(evidenceValidation.rows[0], {
      fact_valid: true, asset_valid: true, asset_matches: true,
    });
    const factBinding = {
      sourceFactId: "fact.capacity", field: "capacity", value: "500 мл", numericValue: 500, unit: "мл",
    };
    const richContent = {
      version: "AUTO_LISTING_RICH_CONTENT_V1", language: "ru", blocks: [
        { type: "HERO_IMAGE", assetId: "asset-main" },
        { type: "HEADING", text: "Объём 500 мл", sourceFactIds: ["fact.capacity"], factBindings: [factBinding] },
        { type: "TEXT", text: "Объём 500 мл", sourceFactIds: ["fact.capacity"], factBindings: [factBinding] },
      ],
    };
    const checkerResult = {
      accepted: true, validator: "AUTO_LISTING_RICH_CONTENT_V1",
      sourceFactIds: ["fact.capacity"], assetIds: ["asset-main"],
    };
    const modelEvidence = {
      requestedTextModel: "text-model", gatewayReportedTextModel: "text-model",
      gatewayReportedTextModelPresent: true,
    };
    const reservationIdentity = buildRichContentEvidenceIdentity({
      scope: { accountId, jobId, itemId, planId },
      planHash: hash("1"), sourceHash: hash("2"), sourceFactEvidence: factEvidence, assetEvidence,
      profileId, profileVersion: 1, modelName: "text-model", promptTemplateVersion: "rich-v1",
    });
    const inputHash = reservationIdentity.inputHash;
    const reservation = {
      accountId, jobId, itemId, planId, inputHash,
      planHash: hash("1"), sourceHash: hash("2"), factRegistryHash: reservationIdentity.factRegistryHash,
      assetHash: reservationIdentity.assetHash, promptHash: reservationIdentity.promptHash, profileId, profileVersion: 1,
      modelName: "text-model", promptTemplateVersion: "rich-v1",
      sourceFactEvidence: factEvidence,
      assetEvidence,
      requestEvidence: { requestKey: `auto-listing-rich-${inputHash}`, schemaVersion: "AUTO_LISTING_RICH_CONTENT_V1" },
      maxAttempts: 3,
    };
    const repository = createPostgresRichContentRepository({
      pool: { query: (...args) => client.query(...args) },
      token: () => `lease-${suffix}`, id: () => `rich-${suffix}`,
    });
    const lease = await repository.reserveRichContentAttempt(reservation);
    const concurrent = await repository.reserveRichContentAttempt(reservation);
    let wrongScopeRejected = false;
    try {
      await repository.completeRichContentAttempt({
        ...reservation, ...lease, accountId: `wrong-${accountId}`,
        richContent,
        outputHash: sha256(richContent), checkerResult, gatewayRequestId: "gateway-rich", modelEvidence,
      });
    } catch (error) {
      wrongScopeRejected = error?.code === "AUTO_LISTING_RICH_CONTENT_ATTEMPT_INVALID";
    }
    const accepted = await repository.completeRichContentAttempt({
      ...reservation, ...lease,
      richContent,
      outputHash: sha256(richContent), checkerResult, gatewayRequestId: "gateway-rich", modelEvidence,
    });
    const replay = await repository.reserveRichContentAttempt(reservation);

    const directAccepted = async (label, mutate = () => {}) => {
      const value = {
        inputHash: crypto.createHash("sha256").update(`input-${label}`).digest("hex"),
        sourceHash: hash("2"), assetHash: hash("b"), outputHash: sha256(richContent),
        planHash: hash("1"), factRegistryHash: hash("e"), promptHash: hash("f"),
        sourceFactEvidence: structuredClone(factEvidence), assetEvidence: structuredClone(assetEvidence),
        richContent: structuredClone(richContent), checkerResult: structuredClone(checkerResult),
        modelEvidence: structuredClone(modelEvidence), requestEvidence: null,
      };
      value.requestEvidence = {
        requestKey: `auto-listing-rich-${value.inputHash}`,
        schemaVersion: "AUTO_LISTING_RICH_CONTENT_V1",
      };
      mutate(value);
      return client.query(
        `INSERT INTO ai_rich_content_results (
           id,account_id,job_id,item_id,plan_id,profile_id,source_hash,asset_hash,input_hash,attempt_no,
           model_name,profile_version,prompt_template_version,rich_content,output_hash,checker_result,status,
           accepted_at,plan_hash,fact_registry_hash,prompt_hash,request_evidence,model_evidence,
           source_fact_evidence,asset_evidence,gateway_request_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,'text-model',1,'rich-v1',$10::JSONB,$11,$12::JSONB,
           'ACCEPTED',NOW(),$13,$14,$15,$16::JSONB,$17::JSONB,$18::JSONB,$19::JSONB,'gateway-direct')`,
        [
          `direct-${label}-${suffix}`, accountId, jobId, itemId, planId, profileId,
          value.sourceHash, value.assetHash, value.inputHash, JSON.stringify(value.richContent), value.outputHash,
          JSON.stringify(value.checkerResult), value.planHash, value.factRegistryHash, value.promptHash,
          JSON.stringify(value.requestEvidence), JSON.stringify(value.modelEvidence),
          JSON.stringify(value.sourceFactEvidence), JSON.stringify(value.assetEvidence),
        ],
      );
    };

    const validDirect = await directAccepted("valid");
    assert.equal(validDirect.rowCount, 1);
    const validLegacyDirect = await directAccepted("valid-legacy", (value) => {
      value.assetEvidence[5].objectKeyVersion = null;
      value.assetEvidence[5].objectKey = legacyObjectKey(value.assetEvidence[5]);
    });
    assert.equal(validLegacyDirect.rowCount, 1);

    for (const contentType of ["image/jpeg", "image/webp"]) {
      const validSourceType = await directAccepted(`valid-${contentType.slice(6)}`, (value) => {
        for (const asset of value.assetEvidence) {
          asset.sourceAssetEvidence[0].contentType = contentType;
          asset.checkerEvidence.sourceAssets[0].contentType = contentType;
        }
      });
      assert.equal(validSourceType.rowCount, 1, contentType);
    }

    const validFactSubset = await directAccepted("valid-fact-subset", (value) => {
      value.sourceFactEvidence.push({
        factId: "fact.material", field: "material", kind: "MATERIAL",
        value: "сталь", numericValue: null, unit: null, sourcePath: "attributes.material",
      });
    });
    assert.equal(validFactSubset.rowCount, 1);

    const validNormalizedUnit = await directAccepted("valid-normalized-unit", (value) => {
      value.sourceFactEvidence[0].unit = "ml";
      for (const block of value.richContent.blocks) {
        for (const binding of block.factBindings || []) binding.unit = "ml";
      }
      value.outputHash = sha256(value.richContent);
    });
    assert.equal(validNormalizedUnit.rowCount, 1);

    const validInflectedFact = await directAccepted("valid-inflected-fact", (value) => {
      const materialFact = {
        factId: "fact.material", field: "material", kind: "MATERIAL",
        value: "нержавеющая сталь", numericValue: null, unit: null, sourcePath: "attributes.material",
      };
      value.sourceFactEvidence.push(materialFact);
      value.richContent.blocks.push({
        type: "TEXT", text: "Корпус из нержавеющей стали",
        sourceFactIds: [materialFact.factId],
        factBindings: [{
          sourceFactId: materialFact.factId, field: materialFact.field, value: materialFact.value,
          numericValue: materialFact.numericValue, unit: materialFact.unit,
        }],
      });
      value.checkerResult.sourceFactIds.push(materialFact.factId);
      value.outputHash = sha256(value.richContent);
    });
    assert.equal(validInflectedFact.rowCount, 1);

    const validMissingImageModel = await directAccepted("valid-missing-image-model", (value) => {
      for (const asset of value.assetEvidence) {
        asset.modelEvidence.gatewayReportedImageModel = "";
        asset.modelEvidence.gatewayReportedImageModelPresent = false;
      }
    });
    assert.equal(validMissingImageModel.rowCount, 1);

    const addOrderedReferences = (value) => {
      const materialFact = {
        factId: "fact.material", field: "material", kind: "MATERIAL",
        value: "сталь", numericValue: null, unit: null, sourcePath: "attributes.material",
      };
      value.sourceFactEvidence.push(materialFact);
      value.richContent.blocks[2] = {
        type: "TEXT", text: "Материал: сталь", sourceFactIds: [materialFact.factId],
        factBindings: [{
          sourceFactId: materialFact.factId, field: materialFact.field, value: materialFact.value,
          numericValue: materialFact.numericValue, unit: materialFact.unit,
        }],
      };
      value.richContent.blocks.push({
        type: "IMAGE_TEXT", assetId: "asset-extra-1", text: "Объём 500 мл",
        sourceFactIds: ["fact.capacity"], factBindings: [structuredClone(factBinding)],
      });
      value.checkerResult.sourceFactIds = ["fact.capacity", materialFact.factId];
      value.checkerResult.assetIds = ["asset-main", "asset-extra-1"];
      value.outputHash = sha256(value.richContent);
    };
    const validOrderedReferences = await directAccepted("valid-ordered-references", addOrderedReferences);
    assert.equal(validOrderedReferences.rowCount, 1);

    const validNonContactWord = await directAccepted("valid-non-contact-word", (value) => {
      value.richContent.blocks[1].text = "Бесконтактный термометр, объём 500 мл";
      value.outputHash = sha256(value.richContent);
    });
    assert.equal(validNonContactWord.rowCount, 1);

    for (const [label, phrase] of [
      ["valid-heat-exchanger", "Теплообменник"],
      ["valid-irrevocable-mechanism", "Безотзывный механизм"],
      ["valid-non-medical-device", "Немедицинский прибор"],
    ]) {
      const validCompoundWord = await directAccepted(label, (value) => {
        value.richContent.blocks[1].text = `${phrase}, объём 500 мл`;
        value.outputHash = sha256(value.richContent);
      });
      assert.equal(validCompoundWord.rowCount, 1, phrase);
    }

    const maliciousAcceptedMutations = [
      ["sql-null-facts", (value) => { value.sourceFactEvidence = null; }],
      ["json-null-fact", (value) => { value.sourceFactEvidence = [null]; }],
      ["fact-extra-key", (value) => { value.sourceFactEvidence[0].extra = true; }],
      ["fact-wrong-type", (value) => { value.sourceFactEvidence[0].numericValue = "500"; }],
      ["fact-duplicate-id", (value) => { value.sourceFactEvidence.push(structuredClone(value.sourceFactEvidence[0])); }],
      ["json-null-asset", (value) => { value.assetEvidence[1] = null; }],
      ["asset-extra-key", (value) => { value.assetEvidence[1].extra = true; }],
      ["asset-duplicate-id", (value) => { value.assetEvidence[1].assetId = value.assetEvidence[0].assetId; }],
      ["asset-zero-main", (value) => { value.assetEvidence[0].role = "SELLING_POINT"; }],
      ["asset-two-main", (value) => { value.assetEvidence[1].role = "MAIN"; }],
      ["asset-fake-v2-key", (value) => { value.assetEvidence[1].objectKey = "auto-listing/v2/fake.png"; }],
      ["asset-string-legacy-version", (value) => {
        value.assetEvidence[1].objectKeyVersion = "LEGACY_V1";
        value.assetEvidence[1].objectKey = legacyObjectKey(value.assetEvidence[1]);
      }],
      ["asset-fake-null-legacy-key", (value) => {
        value.assetEvidence[1].objectKeyVersion = null;
        value.assetEvidence[1].objectKey = "auto-listing/fake.png";
      }],
      ["asset-missing-audit", (value) => { delete value.assetEvidence[1].gatewayRequestId; }],
      ["asset-oversized-utf8-id", (value) => { value.assetEvidence[1].assetId = "я".repeat(121); }],
      ["asset-missing-model-uses-json-null", (value) => {
        value.assetEvidence[1].modelEvidence.gatewayReportedImageModel = null;
        value.assetEvidence[1].modelEvidence.gatewayReportedImageModelPresent = false;
      }],
      ["asset-present-model-is-null", (value) => {
        value.assetEvidence[1].modelEvidence.gatewayReportedImageModel = null;
        value.assetEvidence[1].modelEvidence.gatewayReportedImageModelPresent = true;
      }],
      ["asset-checker-source-fact-id-null", (value) => { value.assetEvidence[1].checkerEvidence.sourceFactIds = [null]; }],
      ["asset-checker-source-fact-id-duplicate", (value) => {
        value.assetEvidence[1].checkerEvidence.sourceFactIds = ["fact.capacity", "fact.capacity"];
      }],
      ["asset-checker-source-fact-id-not-derived", (value) => {
        value.assetEvidence[1].checkerEvidence.sourceFactIds = [];
      }],
      ["asset-checker-null-claim", (value) => { value.assetEvidence[1].checkerEvidence.checkerResult.evidence.claims[0] = null; }],
      ["asset-checker-open-claim", (value) => { value.assetEvidence[1].checkerEvidence.checkerResult.evidence.claims[0].extra = true; }],
      ["asset-checker-unbound-claim", (value) => {
        value.assetEvidence[1].checkerEvidence.checkerResult.evidence.claims[0].text = "Объём 700 мл";
      }],
      ["asset-checker-inflected-nonnumeric-claim", (value) => {
        const materialFact = {
          factId: "fact.material", field: "material", kind: "MATERIAL",
          value: "нержавеющая сталь", numericValue: null, unit: null, sourcePath: "attributes.material",
        };
        value.sourceFactEvidence.push(structuredClone(materialFact));
        const evidence = value.assetEvidence[1].checkerEvidence;
        evidence.sourceFacts.push(structuredClone(materialFact));
        evidence.sourceFactIds = [materialFact.factId];
        evidence.checkerResult.evidence.claims = [{
          text: "Корпус из нержавеющей стали", sourceFactId: materialFact.factId,
          field: materialFact.field, value: materialFact.value,
          numericValue: materialFact.numericValue, unit: materialFact.unit,
        }];
      }],
      ["asset-checker-null-detected-text", (value) => { value.assetEvidence[1].checkerEvidence.checkerResult.evidence.detectedTexts[0] = null; }],
      ["asset-checker-oversized-detected-text", (value) => {
        value.assetEvidence[1].checkerEvidence.checkerResult.evidence.detectedTexts[0] = "я".repeat(1025);
      }],
      ["asset-checker-oversized-claim", (value) => {
        value.assetEvidence[1].checkerEvidence.checkerResult.evidence.claims[0].text = "я".repeat(1025);
      }],
      ["asset-checker-too-many-reasons", (value) => {
        value.assetEvidence[1].checkerEvidence.checkerResult.reasons = Array.from({ length: 33 }, () => "причина");
      }],
      ["asset-checker-too-many-source-assets", (value) => {
        value.assetEvidence[1].checkerEvidence.checkerResult.evidence.identity.sourceAssetIds = Array.from(
          { length: 8 }, (_, index) => `source-${index}`,
        );
      }],
      ["asset-checker-too-many-claims", (value) => {
        const claim = value.assetEvidence[1].checkerEvidence.checkerResult.evidence.claims[0];
        value.assetEvidence[1].checkerEvidence.checkerResult.evidence.claims = Array.from(
          { length: 257 }, () => structuredClone(claim),
        );
      }],
      ["asset-checker-too-many-detected-texts", (value) => {
        value.assetEvidence[1].checkerEvidence.checkerResult.evidence.detectedTexts = Array.from(
          { length: 65 }, (_, index) => `Текст ${"а".repeat(index + 1)}`,
        );
      }],
      ["asset-checker-too-many-quality-flags", (value) => {
        value.assetEvidence[1].checkerEvidence.checkerResult.evidence.qualityFlags = Array.from(
          { length: 5 }, () => "TEXT_ILLEGIBLE",
        );
      }],
      ["asset-checker-too-many-prohibited-flags", (value) => {
        value.assetEvidence[1].checkerEvidence.checkerResult.evidence.prohibitedFlags = Array.from(
          { length: 9 }, () => "CONTACT_DETAILS",
        );
      }],
      ["bad-input-hash", (value) => { value.inputHash = "not-a-hash"; value.requestEvidence.requestKey = `auto-listing-rich-${value.inputHash}`; }],
      ["bad-source-hash", (value) => { value.sourceHash = "not-a-hash"; }],
      ["bad-asset-hash", (value) => { value.assetHash = "not-a-hash"; }],
      ["bad-output-hash", (value) => { value.outputHash = "not-a-hash"; }],
      ["request-unbound", (value) => { value.requestEvidence.requestKey = "auto-listing-rich-other"; }],
      ["request-json-null", (value) => { value.requestEvidence.requestKey = null; }],
      ["request-extra-key", (value) => { value.requestEvidence.extra = true; }],
      ["model-json-null", (value) => { value.modelEvidence.gatewayReportedTextModelPresent = null; }],
      ["model-extra-key", (value) => { value.modelEvidence.extra = true; }],
      ["checker-extra-key", (value) => { value.checkerResult.extra = true; }],
      ["checker-unknown-fact", (value) => { value.checkerResult.sourceFactIds = ["fact.unknown"]; }],
      ["checker-unknown-asset", (value) => { value.checkerResult.assetIds = ["asset-unknown"]; }],
      ["checker-fact-first-reference-order", (value) => {
        addOrderedReferences(value);
        value.checkerResult.sourceFactIds.reverse();
      }],
      ["checker-asset-first-reference-order", (value) => {
        addOrderedReferences(value);
        value.checkerResult.assetIds.reverse();
      }],
      ["rich-extra-key", (value) => { value.richContent.extra = true; }],
      ["rich-json-null-block", (value) => { value.richContent.blocks[1] = null; }],
      ["rich-unknown-fact", (value) => { value.richContent.blocks[1].sourceFactIds = ["fact.unknown"]; }],
      ["rich-unknown-asset", (value) => { value.richContent.blocks[0].assetId = "asset-unknown"; }],
      ["rich-unbound-number", (value) => { value.richContent.blocks[1].text = "Объём 700 мл"; }],
      ["rich-unit-swap", (value) => { value.richContent.blocks[1].text = "Объём 500 л"; }],
      ["rich-english-only", (value) => { value.richContent.blocks[1].text = "500 ml"; }],
      ["rich-policy-warranty", (value) => { value.richContent.blocks[1].text = "Гарантия: объём 500 мл"; }],
      ["rich-policy-seller-contacts", (value) => { value.richContent.blocks[1].text = "Контакты продавца: объём 500 мл"; }],
      ["rich-policy-seller-phone", (value) => { value.richContent.blocks[1].text = "Телефон продавца: объём 500 мл"; }],
      ["rich-policy-contact-seller", (value) => { value.richContent.blocks[1].text = "Обратитесь к продавцу: объём 500 мл"; }],
      ["rich-policy-certification", (value) => { value.richContent.blocks[1].text = "Сертификация: объём 500 мл"; }],
      ["rich-oversized-utf8-text", (value) => { value.richContent.blocks[1].text = "я".repeat(4097); }],
    ];
    for (const [label, mutate] of maliciousAcceptedMutations) {
      await assert.rejects(directAccepted(label, mutate), (error) => {
        assert.equal(error?.code, "23514", label);
        return true;
      });
    }

    let duplicateRejected = false;
    try {
      await client.query(
        `INSERT INTO ai_rich_content_results (
           id,account_id,job_id,item_id,plan_id,profile_id,source_hash,asset_hash,input_hash,attempt_no,
           model_name,profile_version,prompt_template_version,rich_content,output_hash,checker_result,status,
           plan_hash,fact_registry_hash,prompt_hash,request_evidence,model_evidence,source_fact_evidence,
           asset_evidence,gateway_request_id,accepted_at
         ) SELECT $1,account_id,job_id,item_id,plan_id,profile_id,source_hash,asset_hash,input_hash,attempt_no+1,
           model_name,profile_version,prompt_template_version,rich_content,output_hash,checker_result,status,
           plan_hash,fact_registry_hash,prompt_hash,request_evidence,model_evidence,source_fact_evidence,
           asset_evidence,gateway_request_id,NOW()
         FROM ai_rich_content_results WHERE id=$2`,
        [`rich-duplicate-${suffix}`, accepted.id],
      );
    } catch (error) {
      duplicateRejected = error?.code === "23505";
    }

    return {
      migrationAppliedTwice: true,
      legacyTerminalPreserved,
      nullAcceptedRejected,
      fullScopeLeaseCas: lease.status === "RESERVED" && concurrent.status === "IN_PROGRESS" && wrongScopeRejected,
      acceptedReplayUnique: replay.status === "EXISTING_ACCEPTED" && duplicateRejected,
    };
  } finally {
    await client.query("RESET search_path").catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`).catch(() => {});
    client.release();
    await pool.end();
  }
}
