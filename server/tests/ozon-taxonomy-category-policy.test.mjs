import assert from "node:assert/strict";
import test from "node:test";
import { types } from "node:util";
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

function assertTaxonomyRejected(operation) {
  assert.throws(operation, (error) => (
    error?.code === "ZONGZI_TAXONOMY_CONTRACT_INVALID"
      && !String(error?.message).includes("vendor-secret")
      && !Object.hasOwn(error, "cause")
  ));
}

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

test("taxonomy policy rejects accessors and proxies without executing vendor traps", () => {
  const accessor = { children: [] };
  Object.defineProperty(accessor, "description_category_id", {
    enumerable: true,
    configurable: true,
    get() { throw new Error("getter vendor-secret"); },
  });
  assertTaxonomyRejected(() => taxonomyFingerprint([accessor]));

  const proxy = new Proxy({ description_category_id: 17028702, children: [] }, {
    get() { throw new Error("proxy vendor-secret"); },
  });
  assert.equal(types.isProxy(proxy), true);
  assertTaxonomyRejected(() => enabledLeafCandidates([proxy]));
  assertTaxonomyRejected(() => resolveExactType({ tree: [proxy], sourceTypeId: 94405 }));
});

test("taxonomy policy rejects cycles and oversized input with one fixed safe code", () => {
  const cycle = { description_category_id: 17028702, children: [] };
  cycle.children.push(cycle);
  assertTaxonomyRejected(() => taxonomyFingerprint([cycle]));
  assertTaxonomyRejected(() => enabledLeafCandidates([cycle]));

  const oversized = Array.from({ length: 10_001 }, (_, index) => ({
    description_category_id: index + 1,
    children: [],
  }));
  assertTaxonomyRejected(() => taxonomyFingerprint(oversized));
  assertTaxonomyRejected(() => resolveExactType({ tree: oversized, sourceTypeId: 94405 }));

  const oversizedByIgnoredNodes = [{
    children: Array.from({ length: 10_000 }, () => ({ children: [] })),
  }];
  assertTaxonomyRejected(() => taxonomyFingerprint(oversizedByIgnoredNodes));
});

test("resolveExactType closes its wrapper before reading tree or sourceTypeId", () => {
  const accessor = { sourceTypeId: 94405 };
  Object.defineProperty(accessor, "tree", {
    enumerable: true,
    configurable: true,
    get() { throw new Error("wrapper getter vendor-secret"); },
  });
  assertTaxonomyRejected(() => resolveExactType(accessor));

  const proxy = new Proxy({ tree: translatedTree("Home", "Cup"), sourceTypeId: 94405 }, {
    get() { throw new Error("wrapper proxy vendor-secret"); },
  });
  assertTaxonomyRejected(() => resolveExactType(proxy));

  assertTaxonomyRejected(() => resolveExactType({
    tree: translatedTree("Home", "Cup"),
    sourceTypeId: 94405,
    vendorSecret: "must-not-be-accepted",
  }));

  const symbol = { tree: translatedTree("Home", "Cup"), sourceTypeId: 94405 };
  symbol[Symbol("vendor-secret")] = true;
  assertTaxonomyRejected(() => resolveExactType(symbol));

  const prototype = Object.create({ vendorSecret: true });
  prototype.tree = translatedTree("Home", "Cup");
  prototype.sourceTypeId = 94405;
  assertTaxonomyRejected(() => resolveExactType(prototype));
});
