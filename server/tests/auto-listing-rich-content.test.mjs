import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { buildGeneratedAssetObjectKey } from "../auto-listing-asset-store.mjs";
import { buildImageGenerationAttemptIdentity, buildImageGenerationInput } from "../auto-listing-image-generator.mjs";

const richModule = () => import("../auto-listing-rich-content.mjs");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const reverseKeysDeep = (value) => Array.isArray(value) ? value.map(reverseKeysDeep) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeysDeep(child)])) : value;
const scope = Object.freeze({ accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-a" });
const profile = Object.freeze({ id: "profile-a", accountId: "account-a", configVersion: 3, textModel: "rich-model", imageModel: "image-model" });

const facts = Object.freeze([
  { factId: "fact.brand", field: "identity.brand", kind: "BRAND", value: "SONLI", numericValue: null, unit: null, sourcePath: "identity.brand" },
  { factId: "fact.material", field: "attributes.material", kind: "MATERIAL", value: "нержавеющая сталь", numericValue: null, unit: null, sourcePath: "attributes.material" },
  { factId: "fact.capacity", field: "attributes.capacity", kind: "CAPACITY", value: "500 мл", numericValue: 500, unit: "ml", sourcePath: "attributes.capacity" },
  { factId: "fact.model", field: "identity.model", kind: "MODEL", value: "X500", numericValue: null, unit: null, sourcePath: "identity.model" },
  { factId: "fact.weight", field: "attributes.weight", kind: "WEIGHT", value: "300 г", numericValue: 300, unit: "g", sourcePath: "attributes.weight" },
]);
const slotSpecs = Object.freeze([
  ["asset-main", "MAIN", "main-01", "a"],
  ["asset-detail", "SELLING_POINT", "detail-01", "b"],
  ["asset-03", "SELLING_POINT", "detail-02", "3"],
  ["asset-04", "SELLING_POINT", "detail-03", "4"],
  ["asset-05", "SELLING_POINT", "detail-04", "5"],
  ["asset-06", "SELLING_POINT", "detail-05", "6"],
]);
const slots = slotSpecs.map(([, role, slotKey]) => ({
  slotKey,
  visualGroupKey: "group-a",
  role,
  textDensity: "LIGHT",
  preserve: ["shape"],
  referenceAssetIds: [`source-${slotKey}`],
}));
const visualGroups = {
  groups: [{
    visualGroupKey: "group-a",
    referenceImages: slots.map((slot) => ({
      assetId: slot.referenceAssetIds[0],
      sourceRef: null,
      evidenceKind: "CONTENT_HASH",
      contentHash: hash(`source:${slot.slotKey}`),
    })),
  }],
};
const plan = Object.freeze({
  ...scope,
  id: scope.planId,
  sourceAccountId: scope.accountId,
  profileId: profile.id,
  profileVersion: profile.configVersion,
  plannerModel: profile.textModel,
  promptTemplateVersion: "image-v1",
  planHash: "c".repeat(64),
  sourceHash: "d".repeat(64),
  strategyHash: "e".repeat(64),
  configHash: "f".repeat(64),
  visualGroupsHash: "1".repeat(64),
  visualGroups,
  plan: { slots },
  factRegistry: facts.map((fact) => ({ ...fact, visualGroupKeys: ["group-a"] })),
});
const task4Facts = facts.map(({ factId, kind, value, sourcePath }) => {
  const numeric = value.match(/^(-?\d+(?:\.\d+)?)\s+([^\s]+)$/u);
  return {
    factId,
    field: sourcePath,
    kind,
    value,
    numericValue: numeric ? Number(numeric[1]) : null,
    unit: numeric ? numeric[2] : null,
    sourcePath,
  };
});
const asset = (id, role, slotKey, character) => {
  const slot = slots.find((candidate) => candidate.slotKey === slotKey);
  const reference = visualGroups.groups.find((group) => group.visualGroupKey === slot.visualGroupKey)
    .referenceImages.find((entry) => entry.assetId === slot.referenceAssetIds[0]);
  const sourceAssetEvidence = [{
    assetId: reference.assetId,
    contentHash: reference.contentHash,
    contentType: "image/png",
    width: 768,
    height: 1024,
    size: 1024,
  }];
  const checkerRequestId = `checker-${slotKey}`;
  const checkerModelEvidence = { requestedTextModel: profile.textModel, gatewayReportedTextModel: profile.textModel, gatewayReportedTextModelPresent: true };
  const checkerResult = {
    matchesProduct: true,
    claimsVerified: true,
    russianText: true,
    quality: "PASS",
    prohibitedContent: false,
    reasons: [],
    evidence: {
      identity: { color: true, shape: true, accessoryCount: true, sourceAssetIds: [reference.assetId] },
      claims: [],
      detectedTexts: ["товар"],
      language: "ru",
      qualityFlags: [],
      prohibitedFlags: [],
    },
  };
  const generation = { ratio: "3:4", resolution: "1K", size: "768x1024", quality: "medium" };
  const generationScope = { ...scope, visualGroupKey: slot.visualGroupKey, slotKey };
  const attemptIdentityHash = buildImageGenerationAttemptIdentity({
    scope: generationScope,
    plan,
    slot,
    preliminaryEvidence: [{ assetId: reference.assetId, evidenceKind: "CONTENT_HASH", evidenceRefHash: reference.contentHash }],
    profile,
    imageModel: profile.imageModel,
    ...generation,
    templateVersion: plan.promptTemplateVersion,
    regeneration: null,
  });
  const generatedInput = buildImageGenerationInput({
    plan,
    slot,
    references: sourceAssetEvidence,
    profile,
    imageModel: profile.imageModel,
    ...generation,
    templateVersion: plan.promptTemplateVersion,
    regeneration: null,
  });
  const value = {
    id, ...scope, status: "ACCEPTED", role, visualGroupKey: slot.visualGroupKey, slotKey,
    attemptIdentityHash, attemptNo: 1, inputHash: generatedInput.inputHash,
    generationSize: generation.size,
    contentHash: character.repeat(64), objectKeyVersion: "ATTEMPT_V2",
    contentType: "image/png", width: 768, height: 1024, size: 1024,
    gatewayRequestId: `gateway-${slotKey}`, checkerRequestId,
    modelEvidence: { requestedImageModel: profile.imageModel, gatewayReportedImageModel: profile.imageModel, gatewayReportedImageModelPresent: true, orchestratorModel: "" },
    profileId: profile.id, profileVersion: profile.configVersion, modelName: profile.imageModel,
    planHash: plan.planHash, sourceHash: plan.sourceHash, strategyHash: plan.strategyHash,
    configHash: plan.configHash, visualGroupsHash: plan.visualGroupsHash,
    promptTemplateVersion: plan.promptTemplateVersion,
    promptHash: generatedInput.promptHash,
    sourceAssetEvidence,
    regeneration: null,
  };
  return Object.freeze({
    ...value,
    objectKey: buildGeneratedAssetObjectKey(value),
    checkerEvidence: {
      checkerResult,
      textRequired: true,
      sourceFactIds: [],
      sourceFacts: structuredClone(task4Facts),
      sourceAssets: structuredClone(sourceAssetEvidence),
      generatedHash: value.contentHash,
      checkerModel: profile.textModel,
      checkerModelEvidence,
      profileId: profile.id,
      profileAccountId: profile.accountId,
      profileVersion: profile.configVersion,
      templateVersion: plan.promptTemplateVersion,
      requestId: checkerRequestId,
    },
  });
};
const assets = Object.freeze(slotSpecs.map(([id, role, slotKey, character]) => asset(id, role, slotKey, character)));
const fullAssetEvidence = (rows = assets) => rows.map((entry) => ({
  assetId: entry.id,
  status: entry.status,
  accountId: entry.accountId,
  jobId: entry.jobId,
  itemId: entry.itemId,
  planId: entry.planId,
  visualGroupKey: entry.visualGroupKey,
  slotKey: entry.slotKey,
  role: entry.role,
  attemptIdentityHash: entry.attemptIdentityHash,
  attemptNo: entry.attemptNo,
  inputHash: entry.inputHash,
  generationSize: entry.generationSize,
  contentHash: entry.contentHash,
  objectKeyVersion: entry.objectKeyVersion,
  objectKey: entry.objectKey,
  contentType: entry.contentType,
  width: entry.width,
  height: entry.height,
  size: entry.size,
  gatewayRequestId: entry.gatewayRequestId,
  checkerRequestId: entry.checkerRequestId,
  modelEvidence: structuredClone(entry.modelEvidence),
  profileId: entry.profileId,
  profileVersion: entry.profileVersion,
  modelName: entry.modelName,
  planHash: entry.planHash,
  sourceHash: entry.sourceHash,
  strategyHash: entry.strategyHash,
  configHash: entry.configHash,
  visualGroupsHash: entry.visualGroupsHash,
  promptTemplateVersion: entry.promptTemplateVersion,
  promptHash: entry.promptHash,
  checkerEvidence: structuredClone(entry.checkerEvidence),
  sourceAssetEvidence: structuredClone(entry.sourceAssetEvidence),
  regeneration: structuredClone(entry.regeneration),
})).sort((left, right) => left.assetId.localeCompare(right.assetId));

const binding = (factId) => {
  const fact = facts.find((entry) => entry.factId === factId);
  return { sourceFactId: fact.factId, field: fact.field, value: fact.value, numericValue: fact.numericValue, unit: fact.unit };
};
const block = (type, text, factId, assetId) => ({
  type,
  ...(assetId ? { assetId } : {}),
  ...(text === undefined ? {} : { text }),
  ...(factId ? { sourceFactIds: [factId], factBindings: [binding(factId)] } : {}),
});
const validContent = () => ({
  version: "AUTO_LISTING_RICH_CONTENT_V1",
  language: "ru",
  blocks: [
    block("HERO_IMAGE", undefined, undefined, "asset-main"),
    block("HEADING", "Термокружка SONLI", "fact.brand"),
    block("TEXT", "Корпус из нержавеющей стали", "fact.material"),
    block("IMAGE_TEXT", "Объём 500 мл", "fact.capacity", "asset-detail"),
  ],
});
const context = (overrides = {}) => ({ ...scope, planHash: plan.planHash, sourceHash: plan.sourceHash, plan: structuredClone(plan), factRegistry: structuredClone(facts), acceptedAssets: structuredClone(assets), profile: structuredClone(profile), ...overrides });
const validation = async (content, overrides = {}) => {
  const { validateRichContent } = await richModule();
  assert.equal(typeof validateRichContent, "function");
  return validateRichContent({ richContent: content, ...context(overrides) });
};
const assertRejected = async (content, overrides = {}) => {
  const result = await validation(content, overrides);
  assert.equal(result.valid, false);
  assert.equal(result.checkerResult.accepted, false);
  assert.equal(typeof result.checkerResult.code, "string");
};

test("exports the closed V1 schema and validates a traceable Russian document deterministically", async () => {
  const { RICH_CONTENT_JSON_SCHEMA, validateRichContent } = await richModule();
  assert.equal(typeof validateRichContent, "function");
  assert.equal(RICH_CONTENT_JSON_SCHEMA.additionalProperties, false);
  assert.deepEqual(RICH_CONTENT_JSON_SCHEMA.properties.version.const, "AUTO_LISTING_RICH_CONTENT_V1");
  assert.deepEqual(RICH_CONTENT_JSON_SCHEMA.properties.language.const, "ru");
  const first = await validation(validContent());
  const second = await validation(validContent());
  assert.equal(first.valid, true);
  assert.equal(first.checkerResult.accepted, true);
  assert.equal(first.checkerResult.validator, "AUTO_LISTING_RICH_CONTENT_V1");
  assert.deepEqual(second, first);
  assert.deepEqual(first.checkerResult.assetIds, ["asset-main", "asset-detail"]);
  assert.deepEqual(first.checkerResult.sourceFactIds, ["fact.brand", "fact.material", "fact.capacity"]);
});

test("rejects unknown, inherited, empty, over-limit, or malformed blocks in the closed contract", async () => {
  const mutations = [
    (content) => { content.extra = true; },
    (content) => { content.blocks[1].extra = true; },
    (content) => { Object.setPrototypeOf(content.blocks[1], { injected: true }); },
    (content) => { content.blocks = []; },
    (content) => { content.blocks = Array.from({ length: 21 }, () => block("TEXT", "Текст", "fact.material")); },
    (content) => { content.blocks[1] = { type: "VIDEO", text: "Текст" }; },
    (content) => { content.blocks[1].text = " "; },
  ];
  for (const mutate of mutations) {
    const content = validContent(); mutate(content); await assertRejected(content);
  }
});

test("requires exactly one leading MAIN hero and globally unique generated asset ids", async () => {
  const cases = [
    (content) => { content.blocks.unshift(block("TEXT", "Введение", "fact.material")); },
    (content) => { content.blocks[0].assetId = "asset-detail"; },
    (content) => { content.blocks.splice(1, 0, block("HERO_IMAGE", undefined, undefined, "asset-main")); },
    (content) => { content.blocks[3].assetId = "asset-main"; },
    (content) => { content.blocks[3].assetId = "missing-asset"; },
  ];
  for (const mutate of cases) {
    const content = validContent(); mutate(content); await assertRejected(content);
  }
});

test("accepts only immutable accepted assets in the same account, job, item, and plan", async () => {
  for (const mutation of [
    (rows) => { rows[1].status = "REJECTED"; },
    (rows) => { rows[1].accountId = "account-b"; },
    (rows) => { rows[1].jobId = "job-b"; },
    (rows) => { rows[1].itemId = "item-b"; },
    (rows) => { rows[1].planId = "plan-b"; },
    (rows) => { delete rows[1].contentHash; },
    (rows) => { delete rows[1].objectKey; },
    (rows) => { rows.push({ ...rows[1], id: "asset-main" }); },
  ]) {
    const acceptedAssets = structuredClone(assets); mutation(acceptedAssets);
    await assertRejected(validContent(), { acceptedAssets });
  }
});

test("binds each rich-content generation to exactly one visual group with 6-13 assets and one MAIN", async () => {
  const crossGroup = structuredClone(assets);
  crossGroup[1].visualGroupKey = "other-group";
  await assertRejected(validContent(), { acceptedAssets: crossGroup });
  const fourteen = Array.from({ length: 14 }, (_, index) => ({
    ...structuredClone(assets[index % assets.length]), id: `asset-over-${index}`, slotKey: `slot-over-${index}`,
    role: index === 0 ? "MAIN" : "DETAIL",
  }));
  await assertRejected(validContent(), { acceptedAssets: fourteen });
});

test("requires every text block, including a heading, to carry unique frozen fact bindings", async () => {
  const cases = [
    (content) => { delete content.blocks[1].sourceFactIds; },
    (content) => { content.blocks[1].sourceFactIds = []; },
    (content) => { content.blocks[1].sourceFactIds = ["fact.brand", "fact.brand"]; content.blocks[1].factBindings.push(binding("fact.brand")); },
    (content) => { content.blocks[2].sourceFactIds = ["missing-fact"]; content.blocks[2].factBindings = [{ ...binding("fact.material"), sourceFactId: "missing-fact" }]; },
    (content) => { content.blocks[2].factBindings[0].field = "attributes.other"; },
    (content) => { content.blocks[2].factBindings[0].value = "пластик"; },
    (content) => { content.blocks[3].factBindings[0].numericValue = 750; },
    (content) => { content.blocks[3].factBindings[0].unit = "l"; },
    (content) => { content.blocks[2].factBindings = []; },
  ];
  for (const mutate of cases) {
    const content = validContent(); mutate(content); await assertRejected(content);
  }
});

test("rejects invented numbers, unit swaps, and text that does not state its cited frozen fact", async () => {
  for (const [text, factId] of [
    ["Объём 750 мл", "fact.capacity"],
    ["Объём 500 л", "fact.capacity"],
    ["Корпус из пластика", "fact.material"],
  ]) {
    const content = validContent();
    const index = factId === "fact.capacity" ? 3 : 2;
    content.blocks[index].text = text;
    await assertRejected(content);
  }
});

test("requires Russian prose while permitting only frozen brand, model, and closed technical tokens", async () => {
  const cases = [
    (content) => { content.blocks[2].text = "Stainless steel body"; },
    (content) => { content.blocks[2].text = "Корпус из stainless steel"; },
    (content) => { content.blocks[1].text = "Термокружка UNKNOWN"; },
    (content) => { content.blocks[1].text = "Термокружка X500"; content.blocks[1].sourceFactIds = ["fact.model"]; content.blocks[1].factBindings = [binding("fact.model")]; },
  ];
  for (const mutate of cases.slice(0, 3)) {
    const content = validContent(); mutate(content); await assertRejected(content);
  }
  const allowed = validContent(); cases[3](allowed);
  assert.equal((await validation(allowed)).valid, true);
});

test("rejects URLs, contacts, external promotion, reviews, and unsupported regulated or after-sales claims", async () => {
  for (const phrase of [
    "Подробнее https://example.test", "Пишите в Telegram", "Позвоните +7 999 123-45-67",
    "Оставьте отзыв", "Сертифицировано", "Лечебный эффект", "Гарантия 5 лет", "В комплекте чехол",
  ]) {
    const content = validContent(); content.blocks[2].text = `Корпус из нержавеющей стали. ${phrase}`;
    await assertRejected(content);
  }
});

for (const [label, phrase] of [
  ["seller contact heading", "Контакты продавца"],
  ["seller phone heading", "Телефон продавца"],
  ["seller contact instruction", "Обратитесь к продавцу"],
  ["certification noun", "Сертификация"],
]) {
  test(`rejects ${label} with case-insensitive Russian word-form policy`, async () => {
    const content = validContent();
    content.blocks[2].text = `Корпус из нержавеющей стали. ${phrase}`;
    await assertRejected(content);
  });
}

test("seller-contact and certification policy does not reject fact-proven brands or closed technical tokens", async () => {
  const content = validContent();
  content.blocks[2].text = "Корпус из нержавеющей стали USB-C Bluetooth";
  assert.equal((await validation(content)).valid, true);
});

test("seller-contact policy does not match contact stems inside legitimate Russian words", async () => {
  const content = validContent();
  content.blocks[2].text = "Корпус из нержавеющей стали, бесконтактный";
  assert.equal((await validation(content)).valid, true);
});

for (const phrase of ["Теплообменник", "безотзывный механизм", "немедицинский прибор"]) {
  test(`word policy does not match a prohibited stem inside the legitimate compound: ${phrase}`, async () => {
    const content = validContent();
    content.blocks[2].text = `Корпус из нержавеющей стали. ${phrase}`;
    assert.equal((await validation(content)).valid, true);
  });
}

test("enforces UTF-8-safe text, array, and block limits before accepting a document", async () => {
  const cases = [
    (content) => { content.blocks[2].text = `Корпус ${"а".repeat(8_193)}`; },
    (content) => { content.blocks[2].text = "Корпус\u0000из нержавеющей стали"; },
    (content) => { content.blocks[2].sourceFactIds = Array.from({ length: 33 }, (_, index) => `fact-${index}`); },
    (content) => { content.blocks[2].factBindings = Array.from({ length: 33 }, () => binding("fact.material")); },
  ];
  for (const mutate of cases) {
    const content = validContent(); mutate(content); await assertRejected(content);
  }
});

test("builds a deterministic prompt from frozen facts and accepted asset evidence without mutable data or secrets", async () => {
  const { buildRichContentPrompt } = await richModule();
  assert.equal(typeof buildRichContentPrompt, "function");
  const input = context({
    profile, promptTemplateVersion: "rich-v1",
    sourceSnapshot: { title: "mutable title", sourceImageUrl: "https://private.example/source.png", price: "999" },
    apiKey: "secret-value", token: "secret-token", sourceUrl: "https://private.example/source.png",
  });
  const first = buildRichContentPrompt(input);
  const second = buildRichContentPrompt({ ...input, sourceSnapshot: { title: "changed title", sourceImageUrl: "https://other.example/x.png", price: "1" } });
  assert.deepEqual(second, first);
  assert.match(first.promptHash, /^[a-f0-9]{64}$/);
  assert.match(first.inputHash, /^[a-f0-9]{64}$/);
  assert.match(first.sourceHash, /^[a-f0-9]{64}$/);
  assert.match(first.assetHash, /^[a-f0-9]{64}$/);
  assert.match(first.prompt, /fact\.material|нержавеющая сталь/u);
  assert.match(first.prompt, /asset-main|MAIN|a{64}/u);
  assert.doesNotMatch(first.prompt, /https?:\/\/|secret-value|secret-token|mutable title|price/i);
  assert.equal(first.planHash, plan.planHash);
  assert.equal(first.sourceHash, plan.sourceHash);
  assert.throws(() => buildRichContentPrompt(context()), (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_INPUT_INVALID");
});

test("rich-content input rejects shallow accepted assets that cannot replay the complete Task 4 contract", async () => {
  const { buildRichContentPrompt } = await richModule();
  const acceptedAssets = assets.map(({ id, status, accountId, jobId, itemId, planId, role, visualGroupKey, slotKey, attemptIdentityHash, attemptNo, inputHash, contentHash, objectKeyVersion, objectKey }) => ({
    id, status, accountId, jobId, itemId, planId, role, visualGroupKey, slotKey, attemptIdentityHash, attemptNo, inputHash, contentHash, objectKeyVersion, objectKey,
  }));
  assert.throws(
    () => buildRichContentPrompt({ ...context({ acceptedAssets }), profile, promptTemplateVersion: "rich-v1" }),
    (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_INPUT_INVALID",
  );
});

test("every prompt-projected fact and asset string rejects URL contact and credential-like values", async () => {
  const { buildRichContentPrompt } = await richModule();
  const cases = [
    (input) => { input.factRegistry[0].field = "https://private.example/field"; input.plan.factRegistry[0].field = input.factRegistry[0].field; },
    (input) => { input.factRegistry[0].kind = "data:text/plain,secret"; input.plan.factRegistry[0].kind = input.factRegistry[0].kind; },
    (input) => { input.factRegistry[0].value = "file:///tmp/secret"; input.plan.factRegistry[0].value = input.factRegistry[0].value; },
    (input) => { input.factRegistry[0].value = "ftp://private.example/source"; input.plan.factRegistry[0].value = input.factRegistry[0].value; },
    (input) => { input.factRegistry[0].value = "www.private.example"; input.plan.factRegistry[0].value = input.factRegistry[0].value; },
    (input) => { input.factRegistry[0].value = "owner@example.test"; input.plan.factRegistry[0].value = input.factRegistry[0].value; },
    (input) => { input.factRegistry[0].value = "+7 999 123-45-67"; input.plan.factRegistry[0].value = input.factRegistry[0].value; },
    (input) => { input.factRegistry[0].value = "api_key=sk-secret-value"; input.plan.factRegistry[0].value = input.factRegistry[0].value; },
    (input) => {
      const priorFactId = input.factRegistry[0].factId;
      input.factRegistry[0].factId = "https://private.example/fact";
      input.plan.factRegistry[0].factId = input.factRegistry[0].factId;
      for (const asset of input.acceptedAssets) {
        asset.checkerEvidence.sourceFacts.find((entry) => entry.factId === priorFactId).factId = input.factRegistry[0].factId;
      }
    },
    (input) => { input.acceptedAssets[0].id = "https://private.example/asset"; },
    (input) => { input.acceptedAssets[0].role = "admin@example.test"; },
  ];
  for (const [index, mutate] of cases.entries()) {
    const input = { ...context(), profile, promptTemplateVersion: "rich-v1" };
    mutate(input);
    assert.throws(() => buildRichContentPrompt(input),
      (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_INPUT_INVALID", `prompt projection case ${index}`);
  }
});

function replaceProjectedMaterialValue(input, value) {
  input.factRegistry.find((entry) => entry.factId === "fact.material").value = value;
  input.plan.factRegistry.find((entry) => entry.factId === "fact.material").value = value;
  for (const acceptedAsset of input.acceptedAssets) {
    acceptedAsset.checkerEvidence.sourceFacts.find((entry) => entry.factId === "fact.material").value = value;
  }
}

for (const [label, mutate] of [
  ["credential-shaped unit", (input) => {
    input.factRegistry.find((entry) => entry.factId === "fact.capacity").unit = "Bearer opaque-token-value";
    input.plan.factRegistry.find((entry) => entry.factId === "fact.capacity").unit = "Bearer opaque-token-value";
  }],
  ["bare domain", (input) => replaceProjectedMaterialValue(input, "private.example.com")],
  ["international phone", (input) => replaceProjectedMaterialValue(input, "+44 20 7946 0958")],
  ["Bearer token without a colon", (input) => replaceProjectedMaterialValue(input, "Bearer opaque-token-value")],
]) {
  test(`prompt projection rejects ${label} before reservation`, async () => {
    const { buildRichContentPrompt } = await richModule();
    const input = { ...context(), profile, promptTemplateVersion: "rich-v1" };
    mutate(input);
    assert.throws(() => buildRichContentPrompt(input),
      (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_INPUT_INVALID");
  });
}

test("treats frozen facts and accepted assets as id-keyed collections for prompt and input identity", async () => {
  const { buildRichContentPrompt } = await richModule();
  const baseline = { ...context(), profile, promptTemplateVersion: "rich-v1" };
  const reorderedFacts = structuredClone(facts).reverse();
  const reordered = context({
    plan: { ...structuredClone(plan), factRegistry: reorderedFacts },
    factRegistry: reorderedFacts,
    acceptedAssets: structuredClone(assets).reverse(),
    profile,
    promptTemplateVersion: "rich-v1",
  });

  assert.deepEqual(buildRichContentPrompt(reordered), buildRichContentPrompt(baseline));
});

test("binds multiple numeric claims one-to-one to cited facts and rejects any unmatched number or unit", async () => {
  const content = validContent();
  content.blocks[3].text = "Объём 500 мл, масса 300 г";
  content.blocks[3].sourceFactIds = ["fact.capacity", "fact.weight"];
  content.blocks[3].factBindings = [binding("fact.capacity"), binding("fact.weight")];
  assert.equal((await validation(content)).valid, true);
  for (const text of ["Объём 500 мл, масса 300 кг", "Объём 500 мл, масса 300 г, срок 2 года"]) {
    const invalid = structuredClone(content); invalid.blocks[3].text = text;
    await assertRejected(invalid);
  }
});

function repository({ reserve = { status: "RESERVED", leaseToken: "lease-1" }, existing = null } = {}) {
  const calls = [];
  return {
    calls,
    async reserveRichContent(value) { calls.push(["reserve", value]); return existing ? { status: "EXISTING_ACCEPTED", record: existing } : { attemptNo: 1, inputHash: value.inputHash, promptHash: value.promptHash, ...reserve }; },
    async completeRichContent(value) { calls.push(["complete", value]); return { id: "rich-1", status: "ACCEPTED", ...value, acceptedAt: "2026-08-04T00:00:00.000Z", leaseOwner: null, leaseToken: null, leaseExpiresAt: null, errorCode: null, errorRetryable: null }; },
    async rejectRichContent(value) { calls.push(["reject", value]); return value; },
    async failRichContent(value) { calls.push(["fail", value]); return value; },
  };
}
function generationInput(repositoryPort, gateway = null, overrides = {}) {
  return {
    ...context(), profile, promptTemplateVersion: "rich-v1", repository: repositoryPort,
    gateway: gateway || { async createTextResponse() { return { value: validContent(), requestId: "gateway-1", modelEvidence: { requestedTextModel: "rich-model", gatewayReportedTextModel: "rich-model", gatewayReportedTextModelPresent: true }, usage: { totalTokens: 42 } }; } },
    correlationId: "corr-1", ...overrides,
  };
}

test("reserves before its one text gateway call, persists deterministic checker evidence, and uses no AI checker", async () => {
  const { generateRichContent } = await richModule();
  const repo = repository(); let gatewayCalls = 0;
  const gateway = { async createTextResponse(request) {
    gatewayCalls += 1;
    assert.equal(repo.calls[0][0], "reserve");
    assert.equal(request.model, "rich-model");
    assert.doesNotMatch(request.prompt, /https?:\/\/|secret/i);
    return { value: validContent(), requestId: "gateway-1", modelEvidence: { requestedTextModel: "rich-model", gatewayReportedTextModel: "rich-model", gatewayReportedTextModelPresent: true }, usage: { totalTokens: 42 } };
  } };
  const result = await generateRichContent(generationInput(repo, gateway));
  assert.equal(result.status, "ACCEPTED"); assert.equal(gatewayCalls, 1);
  assert.deepEqual(repo.calls.map(([name]) => name), ["reserve", "complete"]);
  assert.equal(repo.calls[1][1].checkerResult.accepted, true);
  assert.deepEqual(repo.calls[1][1].assetEvidence.map((entry) => entry.assetId), assets.map((entry) => entry.id).sort());
  assert.equal(repo.calls[1][1].gatewayRequestId, "gateway-1");
});

test("reuses an audited accepted result with zero gateway calls and fails closed on corrupt scope, evidence, object refs, or checker result", async () => {
  const { buildRichContentPrompt, generateRichContent } = await richModule();
  const promptEvidence = buildRichContentPrompt({ ...context(), profile, promptTemplateVersion: "rich-v1" });
  const sourceFactEvidence = facts.map((fact) => structuredClone(fact)).sort((left, right) => left.factId.localeCompare(right.factId));
  const assetEvidence = fullAssetEvidence();
  const requestEvidence = { requestKey: `auto-listing-rich-${promptEvidence.inputHash}`, schemaVersion: "AUTO_LISTING_RICH_CONTENT_V1" };
  const modelEvidence = { requestedTextModel: "rich-model", gatewayReportedTextModel: "rich-model", gatewayReportedTextModelPresent: true };
  const reorderedContent = validContent();
  reorderedContent.blocks = reorderedContent.blocks.map((entry) => Object.fromEntries(Object.entries(entry).reverse()));
  const acceptedContent = { blocks: reorderedContent.blocks, language: reorderedContent.language, version: reorderedContent.version };
  const accepted = {
    id: "rich-1", status: "ACCEPTED", ...scope, ...promptEvidence,
    attemptNo: 1, acceptedAt: "2026-08-04T00:00:00.000Z",
    leaseOwner: null, leaseToken: null, leaseExpiresAt: null, errorCode: null, errorRetryable: null,
    profileId: "profile-a", profileVersion: 3, modelName: "rich-model",
    promptTemplateVersion: "rich-v1", richContent: acceptedContent, outputHash: hash(validContent()),
    checkerResult: { accepted: true, validator: "AUTO_LISTING_RICH_CONTENT_V1", sourceFactIds: ["fact.brand", "fact.material", "fact.capacity"], assetIds: ["asset-main", "asset-detail"] },
    sourceFactEvidence, assetEvidence, requestEvidence, modelEvidence, gatewayRequestId: "gateway-1",
  };
  const repo = repository({ existing: accepted });
  const result = await generateRichContent(generationInput(repo, { async createTextResponse() { throw new Error("gateway must not run"); } }));
  assert.equal(result.id, "rich-1"); assert.deepEqual(repo.calls.map(([name]) => name), ["reserve"]);
  for (const mutate of [
    (row) => { row.accountId = "account-b"; },
    (row) => { row.assetEvidence[1].contentHash = "0".repeat(64); },
    (row) => { row.assetEvidence[1].objectKey = "other/key"; },
    (row) => { row.checkerResult.accepted = false; },
    (row) => { row.planHash = "0".repeat(64); },
    (row) => { row.modelEvidence.gatewayReportedTextModel = "other-model"; },
    (row) => { row.id = ""; },
    (row) => { row.attemptNo = 0; },
    (row) => { row.acceptedAt = null; },
    (row) => { row.leaseToken = "stale"; },
    (row) => { row.errorCode = "STALE_ERROR"; },
  ]) {
    const corrupt = structuredClone(accepted); mutate(corrupt);
    await assert.rejects(generateRichContent(generationInput(repository({ existing: corrupt }))), (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_EXISTING_CORRUPT");
  }
});

test("fails closed before reservation when profile, scope, frozen facts, or accepted assets cannot prove the complete boundary", async () => {
  const { generateRichContent } = await richModule();
  for (const mutate of [
    (input) => { input.profile = { ...profile, accountId: "account-b" }; },
    (input) => { input.planId = "plan-b"; },
    (input) => { input.factRegistry.push(structuredClone(input.factRegistry[0])); },
    (input) => { input.acceptedAssets[0].status = "PENDING"; },
    (input) => { input.acceptedAssets.splice(2); },
    (input) => { input.acceptedAssets[1].objectKey = "forged/object.png"; },
    (input) => { input.plan.accountId = "account-b"; },
    (input) => { input.plan.planHash = "0".repeat(64); },
    (input) => { input.plan.factRegistry[0].value = "OTHER"; },
  ]) {
    const repo = repository(); const input = generationInput(repo); mutate(input);
    await assert.rejects(generateRichContent(input), (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_INPUT_INVALID");
    assert.deepEqual(repo.calls, []);
  }
});

test("terminalizes malformed gateway output, gateway failure, and policy rejection through the reserved lease", async () => {
  const { generateRichContent } = await richModule();
  for (const gateway of [
    { async createTextResponse() { return { requestId: "bad" }; } },
    { async createTextResponse() { throw Object.assign(new Error("safe gateway failure"), { code: "RETRYABLE_GATEWAY", retryable: true }); } },
    { async createTextResponse() { return { value: (() => { const content = validContent(); content.blocks[2].text = "Оставьте отзыв"; return content; })(), requestId: "policy", modelEvidence: { requestedTextModel: "rich-model", gatewayReportedTextModel: "rich-model", gatewayReportedTextModelPresent: true } }; } },
  ]) {
    const repo = repository();
    await assert.rejects(generateRichContent(generationInput(repo, gateway)));
    assert.equal(repo.calls[0][0], "reserve");
    assert.ok(["reject", "fail"].includes(repo.calls.at(-1)[0]));
  }
});

test("gateway failures terminalize the lease but expose only the stable safe rich-content error", async () => {
  const { generateRichContent } = await richModule();
  const repo = repository();
  await assert.rejects(generateRichContent(generationInput(repo, {
    async createTextResponse() {
      throw Object.assign(new Error("secret upstream gateway body"), { code: "UPSTREAM_PRIVATE_CODE", retryable: true });
    },
  })), (error) => {
    assert.equal(error?.code, "AUTO_LISTING_RICH_CONTENT_GATEWAY_FAILED");
    assert.equal(error?.retryable, true);
    assert.doesNotMatch(error?.message || "", /secret upstream|private/i);
    return true;
  });
  assert.equal(repo.calls.at(-1)[0], "fail");
  assert.equal(repo.calls.at(-1)[1].errorCode, "AUTO_LISTING_RICH_CONTENT_GATEWAY_FAILED");
});

test("does not call a gateway for concurrent work, policy-rejected reservations, or repository transition errors", async () => {
  const { generateRichContent } = await richModule();
  for (const reserve of [{ status: "IN_PROGRESS" }, { status: "REJECTED", code: "POLICY_REJECTED" }]) {
    let calls = 0;
    await assert.rejects(generateRichContent(generationInput(repository({ reserve }), { async createTextResponse() { calls += 1; return { value: validContent(), requestId: "gateway-1", modelEvidence: { requestedTextModel: "rich-model", gatewayReportedTextModel: "rich-model", gatewayReportedTextModelPresent: true } }; } })), (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_IN_PROGRESS" || error?.code === "AUTO_LISTING_RICH_CONTENT_POLICY_REJECTED");
    assert.equal(calls, 0);
  }
  for (const method of ["reserveRichContent", "completeRichContent", "rejectRichContent", "failRichContent"]) {
    const repo = repository(); repo[method] = async () => { throw new Error(`${method} down`); };
    await assert.rejects(generateRichContent(generationInput(repo)));
  }
});

test("requires an exact echoed attempt number and input or prompt hash before the gateway", async () => {
  const { generateRichContent } = await richModule();
  for (const reserve of [
    { status: "RESERVED", leaseToken: "lease-1", attemptNo: undefined },
    { status: "RESERVED", leaseToken: "lease-1", inputHash: undefined },
    { status: "RESERVED", leaseToken: "lease-1", promptHash: "0".repeat(64) },
  ]) {
    let gatewayCalls = 0;
    await assert.rejects(generateRichContent(generationInput(repository({ reserve }), {
      async createTextResponse() { gatewayCalls += 1; return { value: validContent() }; },
    })), (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_REPOSITORY_FAILED");
    assert.equal(gatewayCalls, 0);
  }
});

test("requires gateway request and exact requested/reported model evidence", async () => {
  const { generateRichContent } = await richModule();
  for (const response of [
    { value: validContent(), modelEvidence: { requestedTextModel: "rich-model", gatewayReportedTextModel: "rich-model", gatewayReportedTextModelPresent: true } },
    { value: validContent(), requestId: "gateway-1" },
    { value: validContent(), requestId: "gateway-1", modelEvidence: { requestedTextModel: "rich-model", gatewayReportedTextModel: "other-model", gatewayReportedTextModelPresent: true } },
  ]) {
    const repo = repository();
    await assert.rejects(generateRichContent(generationInput(repo, { async createTextResponse() { return response; } })),
      (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_GATEWAY_EVIDENCE_INVALID");
    assert.equal(repo.calls.at(-1)[0], "fail");
  }
});

test("canonical output hashing and accepted reuse are independent of JSON key insertion order", async () => {
  const { generateRichContent } = await richModule();
  const reordered = validContent();
  reordered.blocks = reordered.blocks.map((entry) => Object.fromEntries(Object.entries(entry).reverse()));
  const gatewayValue = { blocks: reordered.blocks, language: reordered.language, version: reordered.version };
  const repo = repository();
  await generateRichContent(generationInput(repo, { async createTextResponse() {
    return { value: gatewayValue, requestId: "gateway-1", modelEvidence: { requestedTextModel: "rich-model", gatewayReportedTextModel: "rich-model", gatewayReportedTextModelPresent: true } };
  } }));
  assert.equal(repo.calls.find(([name]) => name === "complete")[1].outputHash, hash(validContent()));
});

test("canonical completion echo equality accepts nested key insertion order changes in every JSON evidence field", async () => {
  const { generateRichContent } = await richModule();
  const repo = repository();
  repo.completeRichContent = async (value) => reverseKeysDeep({
    id: "rich-canonical",
    status: "ACCEPTED",
    ...value,
    acceptedAt: "2026-08-04T00:00:00.000Z",
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    errorCode: null,
    errorRetryable: null,
  });

  const accepted = await generateRichContent(generationInput(repo));
  assert.equal(accepted.id, "rich-canonical");
});

test("reuses the same accepted facts/assets collection after reordering with zero duplicate gateway calls", async () => {
  const { generateRichContent } = await richModule();
  const { createMemoryRichContentRepository } = await import("../auto-listing-rich-content-repository.mjs");
  const repo = createMemoryRichContentRepository({ token: () => "lease-collection" });
  let gatewayCalls = 0;
  const gateway = { async createTextResponse() {
    gatewayCalls += 1;
    return {
      value: validContent(),
      requestId: "gateway-collection",
      modelEvidence: {
        requestedTextModel: "rich-model",
        gatewayReportedTextModel: "rich-model",
        gatewayReportedTextModelPresent: true,
      },
    };
  } };

  const first = await generateRichContent(generationInput(repo, gateway));
  const reorderedFacts = structuredClone(facts).reverse();
  const second = await generateRichContent(generationInput(repo, gateway, {
    plan: { ...structuredClone(plan), factRegistry: reorderedFacts },
    factRegistry: reorderedFacts,
    acceptedAssets: structuredClone(assets).reverse(),
  }));

  assert.equal(second.id, first.id);
  assert.equal(gatewayCalls, 1);
});

test("fails closed when completion does not echo the full frozen evidence exactly", async () => {
  const { generateRichContent } = await richModule();
  const repo = repository();
  repo.completeRichContent = async (value) => ({ id: "rich-corrupt", status: "ACCEPTED", ...value, sourceHash: "0".repeat(64) });
  await assert.rejects(generateRichContent(generationInput(repo)),
    (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_REPOSITORY_FAILED");
});

test("rejects an oversized UTF-8 prompt before reservation or gateway work", async () => {
  const { buildRichContentPrompt, generateRichContent } = await richModule();
  const oversizedFacts = Array.from({ length: 256 }, (_, index) => ({
    factId: `fact.large-${String(index).padStart(3, "0")}`,
    field: `attributes.large.${index}`,
    kind: "MATERIAL",
    value: `материал-${index}-${"я".repeat(1000)}`,
    numericValue: null,
    unit: null,
  }));
  const oversized = context({
    plan: { ...structuredClone(plan), factRegistry: oversizedFacts },
    factRegistry: oversizedFacts,
    profile,
    promptTemplateVersion: "rich-v1",
  });
  assert.throws(() => buildRichContentPrompt(oversized),
    (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_INPUT_INVALID");
  const repo = repository();
  await assert.rejects(generateRichContent({ ...oversized, repository: repo, gateway: { async createTextResponse() { throw new Error("must not call"); } } }),
    (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_INPUT_INVALID");
  assert.deepEqual(repo.calls, []);
});

test("completion must echo a complete closed terminal audit", async () => {
  const { generateRichContent } = await richModule();
  for (const mutation of [
    { id: "" }, { attemptNo: 2 }, { acceptedAt: null }, { leaseOwner: "worker" },
    { leaseToken: "stale" }, { leaseExpiresAt: "2026-08-05T00:00:00.000Z" },
    { errorCode: "STALE_ERROR" }, { errorRetryable: true },
  ]) {
    const repo = repository();
    repo.completeRichContent = async (value) => ({
      id: "rich-terminal", status: "ACCEPTED", ...value,
      acceptedAt: "2026-08-04T00:00:00.000Z", leaseOwner: null, leaseToken: null,
      leaseExpiresAt: null, errorCode: null, errorRetryable: null, ...mutation,
    });
    await assert.rejects(generateRichContent(generationInput(repo)),
      (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_REPOSITORY_FAILED");
  }
});
