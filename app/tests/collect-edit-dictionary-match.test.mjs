import assert from "node:assert/strict";
import test from "node:test";

import {
  collectEditDictionaryIdsOf,
  resolveCollectEditDictionaryValue,
  shouldApplyCollectEditDictionaryDefault,
} from "../src/collect-edit-dictionary-match.js";

test("matches a target dictionary option by ID across display languages", () => {
  const ids = collectEditDictionaryIdsOf({
    key: "8229",
    value: "热水瓶",
    dictionary_value_id: 92576,
  });

  assert.deepEqual(resolveCollectEditDictionaryValue({
    dictionaryIds: ids,
    options: [{ value: "Термос", dictionaryValueId: 92576 }],
    multiple: false,
  }), { matchedById: true, value: "Термос" });
});

test("returns no ID match when only text fallback can decide", () => {
  assert.deepEqual(resolveCollectEditDictionaryValue({
    dictionaryIds: [],
    options: [{ value: "Термос", dictionaryValueId: 92576 }],
    multiple: false,
  }), { matchedById: false, value: undefined });
});

test("does not match a different dictionary ID", () => {
  assert.deepEqual(resolveCollectEditDictionaryValue({
    dictionaryIds: ["92577"],
    options: [{ value: "Термос", dictionaryValueId: 92576 }],
    multiple: false,
  }), { matchedById: false, value: undefined });
});

test("deduplicates matched values for a multi-select", () => {
  const ids = collectEditDictionaryIdsOf({
    values: [
      { dictionary_value_id: 1 },
      { dictionaryValueId: 2 },
      { dictionary_value_id: 1 },
      { dictionary_value_id: 0 },
    ],
  });

  assert.deepEqual(ids, ["1", "2"]);
  assert.deepEqual(resolveCollectEditDictionaryValue({
    dictionaryIds: ids,
    options: [
      { value: "Первый", dictionaryValueId: 1 },
      { value: "Второй", dictionaryValueId: 2 },
    ],
    multiple: true,
  }), { matchedById: true, value: ["Первый", "Второй"] });
});

test("applies a late ID match only to a blank or untouched captured value", () => {
  assert.equal(shouldApplyCollectEditDictionaryDefault({
    currentValue: "",
    sourceValue: "热水瓶",
    matchedById: true,
  }), true);
  assert.equal(shouldApplyCollectEditDictionaryDefault({
    currentValue: "热水瓶",
    sourceValue: "热水瓶",
    matchedById: true,
  }), true);
  assert.equal(shouldApplyCollectEditDictionaryDefault({
    currentValue: "Другой выбор",
    sourceValue: "热水瓶",
    matchedById: true,
  }), false);
});

test("never replaces a value when no dictionary ID matched", () => {
  assert.equal(shouldApplyCollectEditDictionaryDefault({
    currentValue: "热水瓶",
    sourceValue: "热水瓶",
    matchedById: false,
  }), false);
});
