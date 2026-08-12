import { types } from "node:util";

const MAX_ITEMS = 1_000;
const MAX_ATTRIBUTES = 1_000;
const MAX_VALUES = 5_000;
const MAX_DEPTH = 64;
const MAX_NODES = 200_000;
const MAX_STRING_LENGTH = 2_000_000;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

const ROOT_KEYS = new Set([
  "originalItems", "sourceEvidenceAttributes", "replacementCategory", "currentCategoryMetadata",
]);
const REPLACEMENT_KEYS = new Set(["kind", "descriptionCategoryId", "typeId"]);
const METADATA_KEYS = new Set(["descriptionCategoryId", "typeId", "attributes"]);
const ATTRIBUTE_METADATA_KEYS = new Set([
  "id", "complexId", "required", "dictionaryId", "dictionaryValues",
]);
const DICTIONARY_VALUE_KEYS = new Set(["id", "value"]);

function failure(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  error.retryable = false;
  error.cause = null;
  return error;
}

function sourceCategoryFailure() {
  return failure("AUTO_LISTING_SOURCE_CATEGORY_REQUIRED", 409);
}

function attributesFailure() {
  return failure("AUTO_LISTING_CATEGORY_ATTRIBUTES_INCOMPLETE", 422);
}

function dictionaryFailure() {
  return failure("AUTO_LISTING_CATEGORY_DICTIONARY_UNRESOLVED", 422);
}

function positiveId(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : 0;
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) return 0;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : 0;
}

function dataObject(value, allowedKeys = null, exactKeys = null, errorFactory = sourceCategoryFailure) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw errorFactory();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || DANGEROUS_KEYS.has(key)
    || descriptors[key].get || descriptors[key].set || descriptors[key].enumerable !== true
    || (allowedKeys && !allowedKeys.has(key)))) throw errorFactory();
  if (exactKeys && (keys.length !== exactKeys.size
    || [...exactKeys].some((key) => !Object.hasOwn(descriptors, key)))) throw errorFactory();
  return descriptors;
}

function dataArray(value, maximum, errorFactory = sourceCategoryFailure) {
  if (!Array.isArray(value) || types.isProxy(value) || value.length > maximum) throw errorFactory();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  let count = 0;
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (descriptor.get || descriptor.set) throw errorFactory();
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key)
      || Number(key) >= value.length || descriptor.enumerable !== true) throw errorFactory();
    count += 1;
  }
  if (count !== value.length) throw errorFactory();
  return descriptors;
}

function descriptorValue(descriptors, key) {
  return Object.hasOwn(descriptors, key) ? descriptors[key].value : undefined;
}

function cloneData(value, state, depth = 0, errorFactory = sourceCategoryFailure) {
  if (depth > MAX_DEPTH || state.nodes >= MAX_NODES) throw errorFactory();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH || /[\u0000]/u.test(value)) throw errorFactory();
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw errorFactory();
    return value;
  }
  if (!value || typeof value !== "object" || types.isProxy(value)) throw errorFactory();
  if (state.active.has(value)) throw errorFactory();
  if (state.clones.has(value)) return state.clones.get(value);
  state.nodes += 1;
  state.active.add(value);
  let clone;
  if (Array.isArray(value)) {
    const descriptors = dataArray(value, MAX_VALUES, errorFactory);
    clone = [];
    state.clones.set(value, clone);
    for (let index = 0; index < value.length; index += 1) {
      clone.push(cloneData(descriptors[String(index)].value, state, depth + 1, errorFactory));
    }
  } else {
    const descriptors = dataObject(value, null, null, errorFactory);
    clone = {};
    state.clones.set(value, clone);
    for (const key of Object.keys(descriptors)) {
      clone[key] = cloneData(descriptors[key].value, state, depth + 1, errorFactory);
    }
  }
  state.active.delete(value);
  return clone;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function normalizeValue(value, errorFactory = attributesFailure) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) {
    const text = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
    if (!text) throw errorFactory();
    return { value: text };
  }
  const descriptors = dataObject(value, new Set([
    "value", "name", "title", "dictionary_value_id", "dictionaryValueId",
  ]), null, errorFactory);
  const rawText = descriptorValue(descriptors, "value")
    ?? descriptorValue(descriptors, "name")
    ?? descriptorValue(descriptors, "title");
  const text = typeof rawText === "string" || typeof rawText === "number" ? String(rawText).trim() : "";
  if (!text || text.length > MAX_STRING_LENGTH) throw errorFactory();
  const rawDictionaryValueId = descriptorValue(descriptors, "dictionary_value_id")
    ?? descriptorValue(descriptors, "dictionaryValueId");
  const dictionaryValueId = positiveId(rawDictionaryValueId);
  if (rawDictionaryValueId != null && !dictionaryValueId) throw errorFactory();
  return { value: text, ...(dictionaryValueId ? { dictionary_value_id: dictionaryValueId } : {}) };
}

function normalizeAttribute(value, errorFactory = attributesFailure) {
  const descriptors = dataObject(value, new Set([
    "id", "attribute_id", "attributeId", "key", "complex_id", "complexId",
    "attribute_complex_id", "values", "value", "collection", "dictionary_value_id", "dictionaryValueId",
  ]), null, errorFactory);
  const id = positiveId(descriptorValue(descriptors, "id")
    ?? descriptorValue(descriptors, "attribute_id")
    ?? descriptorValue(descriptors, "attributeId")
    ?? descriptorValue(descriptors, "key"));
  if (!id) throw errorFactory();
  const rawComplexId = descriptorValue(descriptors, "complex_id")
    ?? descriptorValue(descriptors, "complexId")
    ?? descriptorValue(descriptors, "attribute_complex_id");
  const complexId = rawComplexId == null || rawComplexId === 0 || rawComplexId === "0"
    ? 0
    : positiveId(rawComplexId);
  if (rawComplexId != null && rawComplexId !== 0 && rawComplexId !== "0" && !complexId) {
    throw errorFactory();
  }
  const rawValues = Object.hasOwn(descriptors, "values")
    ? descriptorValue(descriptors, "values")
    : Object.hasOwn(descriptors, "collection")
      ? descriptorValue(descriptors, "collection")
      : [{
          value: descriptorValue(descriptors, "value"),
          ...(Object.hasOwn(descriptors, "dictionary_value_id")
            ? { dictionary_value_id: descriptorValue(descriptors, "dictionary_value_id") }
            : Object.hasOwn(descriptors, "dictionaryValueId")
              ? { dictionaryValueId: descriptorValue(descriptors, "dictionaryValueId") }
              : {}),
        }];
  const valueDescriptors = dataArray(rawValues, MAX_VALUES, errorFactory);
  const values = [];
  for (let index = 0; index < rawValues.length; index += 1) {
    values.push(normalizeValue(valueDescriptors[String(index)].value, errorFactory));
  }
  if (!values.length) throw errorFactory();
  return { complex_id: complexId, id, values };
}

function normalizeSourceAttributes(value, itemCount) {
  const cloned = cloneData(
    value,
    { active: new WeakSet(), clones: new WeakMap(), nodes: 0 },
    0,
    attributesFailure,
  );
  const descriptors = dataArray(cloned, MAX_ITEMS, attributesFailure);
  if (cloned.length === 0) return Array.from({ length: itemCount }, () => []);
  const first = descriptors["0"].value;
  if (Array.isArray(first)) {
    if (cloned.length !== itemCount) throw sourceCategoryFailure();
    return Array.from({ length: itemCount }, (_, index) => {
      const group = descriptors[String(index)].value;
      const groupDescriptors = dataArray(group, MAX_ATTRIBUTES, attributesFailure);
      return Array.from({ length: group.length }, (_unused, attributeIndex) =>
        normalizeAttribute(groupDescriptors[String(attributeIndex)].value));
    });
  }
  if (cloned.length > MAX_ATTRIBUTES) throw attributesFailure();
  const shared = Array.from({ length: cloned.length }, (_unused, index) =>
    normalizeAttribute(descriptors[String(index)].value));
  return Array.from({ length: itemCount }, () => shared);
}

function normalizedContract(input) {
  const root = dataObject(input, ROOT_KEYS, ROOT_KEYS);
  const originalItems = descriptorValue(root, "originalItems");
  const itemDescriptors = dataArray(originalItems, MAX_ITEMS);
  if (originalItems.length < 1) throw sourceCategoryFailure();

  const replacement = dataObject(
    descriptorValue(root, "replacementCategory"), REPLACEMENT_KEYS, REPLACEMENT_KEYS,
  );
  const descriptionCategoryId = positiveId(descriptorValue(replacement, "descriptionCategoryId"));
  const typeId = positiveId(descriptorValue(replacement, "typeId"));
  if (descriptorValue(replacement, "kind") !== "UNIQUE_MATCH" || !descriptionCategoryId || !typeId) {
    throw sourceCategoryFailure();
  }

  const metadata = dataObject(
    descriptorValue(root, "currentCategoryMetadata"), METADATA_KEYS, METADATA_KEYS,
  );
  if (positiveId(descriptorValue(metadata, "descriptionCategoryId")) !== descriptionCategoryId
    || positiveId(descriptorValue(metadata, "typeId")) !== typeId) throw sourceCategoryFailure();
  const rawAttributeMetadata = descriptorValue(metadata, "attributes");
  const metadataDescriptors = dataArray(rawAttributeMetadata, MAX_ATTRIBUTES);
  const attributes = new Map();
  for (let index = 0; index < rawAttributeMetadata.length; index += 1) {
    const descriptor = dataObject(
      metadataDescriptors[String(index)].value, ATTRIBUTE_METADATA_KEYS, null, attributesFailure,
    );
    const id = positiveId(descriptorValue(descriptor, "id"));
    const complexIdValue = descriptorValue(descriptor, "complexId");
    const complexId = complexIdValue == null ? 0 : positiveId(complexIdValue);
    const required = descriptorValue(descriptor, "required");
    const dictionaryIdValue = descriptorValue(descriptor, "dictionaryId");
    const dictionaryId = dictionaryIdValue == null ? 0 : positiveId(dictionaryIdValue);
    const rawDictionaryValues = descriptorValue(descriptor, "dictionaryValues");
    if (!id || (complexIdValue != null && complexIdValue !== 0 && complexIdValue !== "0" && !complexId)
      || typeof required !== "boolean"
      || (dictionaryIdValue != null && !dictionaryId) || !Array.isArray(rawDictionaryValues)
      || attributes.has(`${complexId}:${id}`)) throw attributesFailure();
    const dictionaryDescriptors = dataArray(rawDictionaryValues, MAX_VALUES, dictionaryFailure);
    const dictionaryValues = new Map();
    for (let valueIndex = 0; valueIndex < rawDictionaryValues.length; valueIndex += 1) {
      const option = dataObject(
        dictionaryDescriptors[String(valueIndex)].value,
        DICTIONARY_VALUE_KEYS,
        DICTIONARY_VALUE_KEYS,
        dictionaryFailure,
      );
      const optionId = positiveId(descriptorValue(option, "id"));
      const optionValue = descriptorValue(option, "value");
      const optionText = typeof optionValue === "string" ? optionValue.trim() : "";
      if (!optionId || !optionText || dictionaryValues.has(optionId)) throw dictionaryFailure();
      dictionaryValues.set(optionId, optionText);
    }
    if (!dictionaryId && rawDictionaryValues.length) throw dictionaryFailure();
    attributes.set(`${complexId}:${id}`, {
      id, complexId, required, dictionaryId, dictionaryValues,
    });
  }
  if (!attributes.size) throw attributesFailure();

  const clonedItems = Array.from({ length: originalItems.length }, (_unused, index) => {
    const item = itemDescriptors[String(index)].value;
    dataObject(item);
    return cloneData(item, { active: new WeakSet(), clones: new WeakMap(), nodes: 0 });
  });
  return {
    originalItems: clonedItems,
    sourceEvidenceAttributes: normalizeSourceAttributes(
      descriptorValue(root, "sourceEvidenceAttributes"), originalItems.length,
    ),
    replacementCategory: { descriptionCategoryId, typeId },
    attributes,
  };
}

function attributeKey(attribute) {
  return `${positiveId(attribute?.complex_id)}:${positiveId(attribute?.id)}`;
}

function validateDictionary(attribute, metadata) {
  if (!metadata.dictionaryId) return attribute;
  if (!metadata.dictionaryValues.size) throw dictionaryFailure();
  return {
    ...attribute,
    values: attribute.values.map((value) => {
      const suppliedId = positiveId(value.dictionary_value_id);
      const canonical = metadata.dictionaryValues.get(suppliedId);
      if (!suppliedId || !canonical) throw dictionaryFailure();
      return { value: canonical, dictionary_value_id: suppliedId };
    }),
  };
}

function originalAttributes(item) {
  const attributes = [];
  const rawAttributes = Array.isArray(item.attributes) ? item.attributes : [];
  for (const raw of rawAttributes) attributes.push(normalizeAttribute(raw));
  const groups = Array.isArray(item.complex_attributes) ? item.complex_attributes : [];
  for (const group of groups) {
    const descriptors = dataObject(group, new Set(["attributes"]), new Set(["attributes"]), attributesFailure);
    const rawGroupAttributes = descriptorValue(descriptors, "attributes");
    const attributeDescriptors = dataArray(rawGroupAttributes, MAX_ATTRIBUTES, attributesFailure);
    for (let index = 0; index < rawGroupAttributes.length; index += 1) {
      attributes.push(normalizeAttribute(attributeDescriptors[String(index)].value));
    }
  }
  return attributes;
}

function rebuiltAttributes(item, sourceAttributes, metadataByKey) {
  const selected = new Map();
  for (const attribute of originalAttributes(item)) {
    const key = attributeKey(attribute);
    if (!metadataByKey.has(key)) continue;
    if (selected.has(key)) throw attributesFailure();
    selected.set(key, attribute);
  }
  const sourceKeys = new Set();
  for (const attribute of sourceAttributes) {
    const key = attributeKey(attribute);
    if (!metadataByKey.has(key)) continue;
    if (sourceKeys.has(key)) throw attributesFailure();
    sourceKeys.add(key);
    // Immutable source evidence is authoritative over old upload attributes for an exact replacement key.
    selected.set(key, attribute);
  }
  for (const [key, metadata] of metadataByKey) {
    const attribute = selected.get(key);
    if (metadata.required && (!attribute || !attribute.values.length)) throw attributesFailure();
    if (attribute) selected.set(key, validateDictionary(attribute, metadata));
  }
  const ordered = [...selected.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([, attribute]) => attribute);
  const attributes = ordered.filter((attribute) => positiveId(attribute.complex_id) === 0);
  const grouped = new Map();
  for (const attribute of ordered.filter((candidate) => positiveId(candidate.complex_id) > 0)) {
    const complexId = positiveId(attribute.complex_id);
    if (!grouped.has(complexId)) grouped.set(complexId, []);
    grouped.get(complexId).push(attribute);
  }
  return {
    attributes,
    complexAttributes: [...grouped.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, groupAttributes]) => ({ attributes: groupAttributes })),
  };
}

export function rebuildOzonItemsForCategory(input) {
  const contract = normalizedContract(input);
  const output = contract.originalItems.map((item, index) => {
    const rebuilt = rebuiltAttributes(item, contract.sourceEvidenceAttributes[index], contract.attributes);
    const outputItem = {
      ...item,
      description_category_id: contract.replacementCategory.descriptionCategoryId,
      type_id: contract.replacementCategory.typeId,
      attributes: rebuilt.attributes,
    };
    if (rebuilt.complexAttributes.length) outputItem.complex_attributes = rebuilt.complexAttributes;
    else delete outputItem.complex_attributes;
    return outputItem;
  });
  return deepFreeze(output);
}
