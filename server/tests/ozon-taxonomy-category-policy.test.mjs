import assert from "node:assert/strict";
import test from "node:test";
import {
  TAXONOMY_SCOPE_OZON_DEFAULT,
  enabledLeafCandidates,
  resolveExactType,
  taxonomyFingerprint,
} from "../ozon-taxonomy-category-policy.mjs";

const translatedTree = (categoryName, typeName) => [{
  description_category_id: 17028702,
  category_name: categoryName,
  children: [{ type_id: 94405, type_name: typeName, children: [] }],
}];

test("taxonomy scope and fingerprint depend only on enabled structure", () => {
  assert.equal(TAXONOMY_SCOPE_OZON_DEFAULT, "OZON:DEFAULT");
  assert.equal(
    taxonomyFingerprint(translatedTree("Home", "Cup")),
    taxonomyFingerprint(translatedTree("Дом", "Кружка")),
  );
  assert.notEqual(
    taxonomyFingerprint(translatedTree("Home", "Cup")),
    taxonomyFingerprint([{ description_category_id: 17028703, children: [{ type_id: 94405, children: [] }] }]),
  );
});

test("enabled leaf traversal excludes disabled descendants and returns immutable candidates", () => {
  const candidates = enabledLeafCandidates([{
    description_category_id: 17028702,
    children: [
      { type_id: 94405, children: [] },
      { type_id: 94406, disabled: true, children: [] },
    ],
  }]);
  assert.deepEqual(candidates, [{ descriptionCategoryId: 17028702, typeId: 94405 }]);
  assert.equal(Object.isFrozen(candidates), true);
  assert.equal(Object.isFrozen(candidates[0]), true);
});

test("exact type produces only the new UNIQUE_MATCH result", () => {
  assert.deepEqual(resolveExactType({
    tree: translatedTree("Home", "Cup"),
    sourceTypeId: 94405,
  }), {
    kind: "UNIQUE_MATCH",
    descriptionCategoryId: 17028702,
    typeId: 94405,
  });
});

test("missing, disabled, duplicate, and ambiguous candidates fail closed", () => {
  assert.deepEqual(resolveExactType({ tree: [], sourceTypeId: 0 }), {
    kind: "NEEDS_REVIEW",
    reasonCode: "TYPE_MISSING",
  });
  assert.deepEqual(resolveExactType({
    tree: [{ description_category_id: 17028702, disabled: true, children: [{ type_id: 94405, children: [] }] }],
    sourceTypeId: 94405,
  }), {
    kind: "NEEDS_REVIEW",
    reasonCode: "TYPE_NOT_FOUND",
    candidates: [],
  });
  const duplicate = translatedTree("Home", "Cup");
  assert.deepEqual(resolveExactType({ tree: [duplicate[0], structuredClone(duplicate[0])], sourceTypeId: 94405 }), {
    kind: "NEEDS_REVIEW",
    reasonCode: "TYPE_DUPLICATE",
    candidates: [{ descriptionCategoryId: 17028702, typeId: 94405 }],
  });
  assert.deepEqual(resolveExactType({
    tree: [
      { description_category_id: 17028702, children: [{ type_id: 94405, children: [] }] },
      { description_category_id: 17028703, children: [{ type_id: 94405, children: [] }] },
    ],
    sourceTypeId: 94405,
  }), {
    kind: "NEEDS_REVIEW",
    reasonCode: "TYPE_AMBIGUOUS",
    candidates: [
      { descriptionCategoryId: 17028702, typeId: 94405 },
      { descriptionCategoryId: 17028703, typeId: 94405 },
    ],
  });
});
