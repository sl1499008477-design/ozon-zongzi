const assert = require("node:assert/strict");
const fs = require("node:fs");

const workerSource = fs.readFileSync("extension/background/service-worker.js", "utf8");
const helperToken = "const mergeBundleItemIntoSourceVariant = (sourceVariant, bundleItem) => {";
const helperStart = workerSource.indexOf(helperToken);
assert.notEqual(helperStart, -1, "service worker must expose one shared bundle enrichment helper");
const helperEnd = workerSource.indexOf("\n\n  const fetchBundleByVariantId", helperStart);
assert.notEqual(helperEnd, -1, "bundle enrichment helper must remain before bundle fetching");
const helperSource = workerSource.slice(helperStart, helperEnd);
const loadHelper = new Function(`${helperSource}\nreturn mergeBundleItemIntoSourceVariant;`);
const mergeBundleItemIntoSourceVariant = loadHelper();

assert.ok(
  (workerSource.match(/mergeBundleItemIntoSourceVariant\(/g) || []).length >= 2,
  "fleet and local bundle routes must both call the shared enrichment helper",
);

const bundleItem = {
  weight: 888,
  depth: 11,
  width: 22,
  height: 33,
  attributes: [
    { attribute_id: 20, complex_id: 0, values: [{ value: "simple" }] },
    { attribute_id: 30, complex_id: "0", values: [{ value: "first" }, { value: "second" }] },
    { attribute_id: 10, complex_id: 0, values: [{ value: "must-not-overwrite" }] },
    { attribute_id: 9454, complex_id: 0, values: [{ value: "must-not-duplicate" }] },
    { attribute_id: 40, complex_id: 1, values: [{ value: "video" }] },
    { attribute_id: 50, complex_id: 0, values: [{ value: "" }, null] },
  ],
};
const sourceVariant = {
  attributes: [
    { key: "10", value: "existing" },
    { key: "4497", value: "777" },
  ],
};
const expectedAttributes = [
  { key: "10", value: "existing" },
  { key: "4497", value: "777" },
  { key: "9454", value: "11" },
  { key: "9455", value: "22" },
  { key: "9456", value: "33" },
  { key: "20", value: "simple" },
  { key: "30", collection: ["first", "second"] },
];

const enriched = mergeBundleItemIntoSourceVariant(sourceVariant, bundleItem);
assert.deepEqual(enriched.attributes, expectedAttributes);
assert.equal(enriched._bundleItem, bundleItem);
assert.deepEqual(enriched._bundleComplexAttrs, [bundleItem.attributes[4]]);
assert.deepEqual(
  mergeBundleItemIntoSourceVariant(enriched, bundleItem).attributes,
  expectedAttributes,
  "repeated enrichment must not duplicate physical or business attributes",
);
assert.equal(
  mergeBundleItemIntoSourceVariant(sourceVariant, { weight: 0, depth: -1, width: "bad" })
    .attributes.length,
  sourceVariant.attributes.length,
  "invalid physical values must stay unavailable",
);

const startToken = "const _fc = await callFleet(backendUrl, token, storeId, 'collect', { sku });";
const endToken = "return { ok: true, data: { items: [_sv] } };";
const start = workerSource.indexOf(startToken);
const endStart = workerSource.indexOf(endToken, start);
assert.notEqual(start, -1, "searchVariants must retain the fleet collect call");
assert.notEqual(endStart, -1, "searchVariants must return the enriched fleet sourceVariant");

const branchClose = workerSource.indexOf("\n      }", endStart + endToken.length);
assert.notEqual(branchClose, -1, "fleet sourceVariant branch must remain syntactically complete");
const executableBranch = workerSource.slice(start, branchClose + "\n      }".length);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runFleetBranch = new AsyncFunction(
  "callFleet",
  "backendUrl",
  "token",
  "storeId",
  "sku",
  "_ck",
  "_fleetCacheSet",
  "mergeBundleItemIntoSourceVariant",
  `${executableBranch}\nreturn null;`,
);

(async () => {
  const calls = [];
  const cached = [];
  const fleetResponse = {
    sourceVariant,
    bundleItem,
  };

  const result = await runFleetBranch(
    async (...args) => {
      calls.push(args);
      return fleetResponse;
    },
    "https://backend.example.test",
    "account-token",
    "store-a",
    "sku-123",
    "fleet-cache-key",
    (...args) => cached.push(args),
    mergeBundleItemIntoSourceVariant,
  );

  assert.deepEqual(calls, [[
    "https://backend.example.test",
    "account-token",
    "store-a",
    "collect",
    { sku: "sku-123" },
  ]]);
  assert.deepEqual(result.data.items[0].attributes, expectedAttributes);
  assert.deepEqual(cached[0][1].sourceVariant.attributes, expectedAttributes);

  console.log("fleet and local bundle attribute merge behavior passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
