import assert from "node:assert/strict";
import test from "node:test";
import {
  CATEGORY_RESOLUTION_STATUS,
  TAXONOMY_SCOPE_OZON_DEFAULT,
  nextResolution,
  resolveExactType,
  taxonomyFingerprint,
} from "../collect-category-resolution-policy.mjs";

const zhTree = [{
  description_category_id: 17028702,
  category_name: "家居",
  children: [{
    type_id: 94405,
    type_name: "杯子",
    children: [],
  }],
}];

const ruTree = [{
  description_category_id: 17028702,
  category_name: "Дом",
  children: [{
    type_id: 94405,
    type_name: "Кружки",
    children: [],
  }],
}];

const treeWithMovedType = [{
  description_category_id: 17028702,
  category_name: "家居",
  children: [],
}, {
  description_category_id: 17028703,
  category_name: "厨房",
  children: [{
    type_id: 94405,
    type_name: "杯子",
    children: [],
  }],
}];

const ambiguousTree = [{
  description_category_id: 17028702,
  children: [{ type_id: 94405, children: [] }],
}, {
  description_category_id: 17028703,
  children: [{ type_id: 94405, children: [] }],
}];

test("the default scope and status machine have stable domain values", () => {
  assert.equal(TAXONOMY_SCOPE_OZON_DEFAULT, "OZON:DEFAULT");
  assert.deepEqual(CATEGORY_RESOLUTION_STATUS, {
    WAITING_ENRICHMENT: "WAITING_ENRICHMENT",
    WAITING_STORE: "WAITING_STORE",
    QUEUED: "QUEUED",
    MATCHING: "MATCHING",
    MATCHED: "MATCHED",
    NEEDS_REVIEW: "NEEDS_REVIEW",
    RETRYABLE_ERROR: "RETRYABLE_ERROR",
    INVALIDATED: "INVALIDATED",
  });
});

test("fingerprint ignores translated labels but detects structural changes", () => {
  assert.equal(taxonomyFingerprint(zhTree), taxonomyFingerprint(ruTree));
  assert.notEqual(taxonomyFingerprint(zhTree), taxonomyFingerprint(treeWithMovedType));
});

test("exact type id returns the only enabled leaf", () => {
  assert.deepEqual(resolveExactType({ tree: zhTree, sourceTypeId: 94405 }), {
    kind: "MATCHED",
    descriptionCategoryId: 17028702,
    typeId: 94405,
  });
});

test("disabled leaves are excluded from exact matching", () => {
  const disabledTree = [{
    description_category_id: 17028702,
    children: [{ type_id: 94405, disabled: true, children: [] }],
  }];

  assert.deepEqual(resolveExactType({ tree: disabledTree, sourceTypeId: 94405 }), {
    kind: "NEEDS_REVIEW",
    reasonCode: "TYPE_NOT_FOUND",
    candidates: [],
  });
});

test("missing or ambiguous type id needs review instead of guessing", () => {
  assert.deepEqual(resolveExactType({ tree: zhTree, sourceTypeId: 0 }), {
    kind: "NEEDS_REVIEW",
    reasonCode: "TYPE_MISSING",
  });
  assert.deepEqual(resolveExactType({ tree: ambiguousTree, sourceTypeId: 94405 }), {
    kind: "NEEDS_REVIEW",
    reasonCode: "TYPE_AMBIGUOUS",
    candidates: [
      { descriptionCategoryId: 17028702, typeId: 94405 },
      { descriptionCategoryId: 17028703, typeId: 94405 },
    ],
  });
});

test("manual match cannot be overwritten by an automatic match", () => {
  const manualMatched = {
    status: "MATCHED",
    method: "MANUAL",
    target: { descriptionCategoryId: 17028702, typeId: 94405 },
  };

  assert.deepEqual(nextResolution(manualMatched, { type: "AUTO_MATCHED" }), manualMatched);
});
