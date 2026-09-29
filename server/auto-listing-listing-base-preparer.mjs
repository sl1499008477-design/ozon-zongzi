import crypto from "node:crypto";
import { types as utilTypes } from "node:util";

import { defaultOzonManufacturingCountryAttribute, normalizeOzonImportItems } from "./ozon-import-normalizer.mjs";
import {
  projectOzonCategorySourceData,
  projectOzonCategorySourceItems,
  rebuildOzonItemsForCategory,
} from "./ozon-category-item-rebuilder.mjs";
import { buildOzonCategoryRebuildMetadata } from "./ozon-category-service.mjs";
import { normalizeAutoListingCurrency } from "./auto-listing-currency.mjs";

const HASH = /^[a-f0-9]{64}$/u;
const BRAND_ATTRIBUTE_ID = 85;
const TYPE_ATTRIBUTE_ID = 8229;
const GROUP_ATTRIBUTE_ID = 8292;
const OZON_NO_BRAND_VALUE = "Нет бренда";
const OZON_NO_BRAND_VALUE_ID_HINT = 126745801;
const RICH_CONTENT_ATTRIBUTE_ID = 11254;
const WHOLE_OR_SPLIT_DICTIONARY_CANDIDATES = "_wholeOrSplitDictionaryCandidates";
const CONTENT_ATTRIBUTE_EXCLUDED_IDS = new Set([
  BRAND_ATTRIBUTE_ID, 4180, 4191, 4194, 4195, 4497, 9454, 9455, 9456, RICH_CONTENT_ATTRIBUTE_ID,
]);

function failure(code, status = 422, retryable = false) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  error.cause = null;
  return error;
}

const text = (value) => typeof value === "string" ? value.trim() : "";
const plainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : plainObject(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value;
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function productDraftEvidence(source, fallbackVersions) {
  const draft = source?.productDraft;
  if (!plainObject(draft) || !text(draft.id) || !Number.isSafeInteger(draft.version) || draft.version < 1
    || !HASH.test(draft.dataHash || "")) {
    throw failure("AUTO_LISTING_PRODUCT_DRAFT_REQUIRED", 409);
  }
  const normalizerVersion = text(draft.normalizerVersion) || fallbackVersions.normalizerVersion;
  const categoryRuleVersion = text(draft.categoryRuleVersion) || fallbackVersions.categoryRuleVersion;
  const dictionaryVersion = text(draft.dictionaryVersion) || fallbackVersions.dictionaryVersion;
  if (!normalizerVersion || !categoryRuleVersion || !dictionaryVersion) {
    throw failure("AUTO_LISTING_PRODUCT_DRAFT_REQUIRED", 409);
  }
  return {
    productDraft: { id: text(draft.id), version: draft.version, dataHash: draft.dataHash },
    versions: {
      normalizerVersion,
      categoryRuleVersion,
      dictionaryVersion,
    },
  };
}

function priceEvidence(value) {
  const currency = normalizeAutoListingCurrency(value?.currency);
  const currencySource = value?.currencySource;
  const legacy = currencySource === undefined && currency === "RUB";
  if (!plainObject(value) || !currency
    || (!legacy && !["SOURCE", "TARGET_STORE"].includes(currencySource))
    || typeof value.blackKopecks !== "string" || !/^\d{1,30}$/u.test(value.blackKopecks)
    || !(value.greenKopecks === null || (typeof value.greenKopecks === "string" && /^\d{1,30}$/u.test(value.greenKopecks)))) {
    throw failure("AUTO_LISTING_PRICE_EVIDENCE_INVALID");
  }
  const evidence = {
    currency,
    ...(legacy ? {} : { currencySource }),
    blackKopecks: value.blackKopecks,
    greenKopecks: value.greenKopecks,
  };
  return { ...evidence, evidenceHash: digest(evidence) };
}

function priceAmountFromEvidence(value) {
  if (typeof value?.blackKopecks !== "string" || !/^\d{1,30}$/u.test(value.blackKopecks)) {
    throw failure("AUTO_LISTING_PRICE_EVIDENCE_INVALID");
  }
  const minorUnits = BigInt(value.blackKopecks);
  if (minorUnits < 1n) throw failure("AUTO_LISTING_PRICE_EVIDENCE_INVALID");
  return `${minorUnits / 100n}.${String(minorUnits % 100n).padStart(2, "0")}`;
}

function defaultRawItems(source, { currencyCode } = {}) {
  const collectItem = plainObject(source?.collectItem) ? source.collectItem : {};
  const draft = plainObject(collectItem.listingDraft) ? collectItem.listingDraft : {};
  const records = Array.isArray(draft.variants) && draft.variants.length ? draft.variants : [draft];
  const variantsCarrySourceAttributes = records.some((record) =>
    Array.isArray(record?.sourceCategory?.attributes));
  return records.map((record, index) => {
    if (!plainObject(record)) throw failure("AUTO_LISTING_LISTING_BASE_INCOMPLETE");
    const sku = text(record.sku || record.sourceSku || record.source_sku || (index === 0 ? draft.sku : ""));
    const rawSourceCategoryAttributes = Array.isArray(record?.sourceCategory?.attributes)
      ? record.sourceCategory.attributes
      : !variantsCarrySourceAttributes && Array.isArray(draft?.sourceCategory?.attributes)
        ? draft.sourceCategory.attributes
        : [];
    const sourceCategoryAttributes = structuredClone(rawSourceCategoryAttributes).filter((attribute) => {
        if (!plainObject(attribute)) return true;
        if (attribute.value !== undefined && attribute.value !== null
          && (typeof attribute.value !== "string" || attribute.value.trim())) return true;
        if (Array.isArray(attribute.values) && attribute.values.length) return true;
        return Array.isArray(attribute.collection) && attribute.collection.length;
      });
    const existingSourceVariant = plainObject(record._sourceVariant) ? structuredClone(record._sourceVariant) : {};
    const merged = {
      ...structuredClone(draft),
      ...structuredClone(record),
      sku,
      scraped_sku: sku,
      offer_id: record.offer_id || record.offerId || sku,
      currency_code: currencyCode,
      currencyCode,
      ...(sourceCategoryAttributes.length && !Array.isArray(existingSourceVariant.attributes)
        ? { _sourceVariant: { ...existingSourceVariant, attributes: sourceCategoryAttributes } }
        : Object.keys(existingSourceVariant).length ? { _sourceVariant: existingSourceVariant } : {}),
    };
    delete merged.variants;
    return merged;
  });
}

function positiveId(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : 0;
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) return 0;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : 0;
}

function categoryAttributeName(value) {
  for (const candidate of [value?.name, value?.attribute_name, value?.attributeName, value?.title]) {
    if (typeof candidate !== "string") continue;
    const normalized = candidate.trim();
    if (normalized && normalized.length <= 500 && !/[\u0000-\u001f\u007f]/u.test(normalized)) return normalized;
  }
  return "";
}

function normalizedAttributeLabel(value) {
  return text(value)
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function comparableAttributeLabel(value) {
  return normalizedAttributeLabel(value)
    .split(" ")
    .filter((token) => !["товар", "товара", "изделие", "изделия", "продукт", "продукта"].includes(token))
    .join(" ");
}

function splitCollectionDictionaryValue(value) {
  const whole = text(value);
  if (!whole) return [];
  const parts = whole.split(/[,;\n]+/gu).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return [{ value: whole }];
  const unique = [];
  const seen = new Set();
  for (const part of parts) {
    const key = part.toLocaleLowerCase("ru-RU");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ value: part });
  }
  return [{ value: whole }, ...unique];
}

function publicCharacteristicPairs(item) {
  const pairs = [];
  for (const characteristic of Array.isArray(item?.sourceCharacteristics) ? item.sourceCharacteristics : []) {
    const name = text(characteristic?.name ?? characteristic?.nameRu);
    const value = text(characteristic?.value ?? characteristic?.valueRu);
    if (name && value && name.length <= 500 && value.length <= 5_000) pairs.push({ name, value });
  }
  if (text(item?.brand)) pairs.push({ name: "Бренд", value: text(item.brand) });
  for (const [name, rawValue] of Object.entries(plainObject(item?.aspectValues) ? item.aspectValues : {})) {
    let value = text(rawValue);
    if (!value) continue;
    if (normalizedAttributeLabel(name) === "размер") {
      const russianSize = value.match(/^([0-9]+(?:[.,][0-9]+)?)\s*RU\b/iu);
      if (russianSize) value = russianSize[1];
    }
    pairs.push({ name, value, variantSpecific: true });
  }
  return pairs;
}

function categoryAttributeForCharacteristic(attributes, sourceName) {
  const source = normalizedAttributeLabel(sourceName);
  const sourceComparable = comparableAttributeLabel(sourceName);
  const candidates = (Array.isArray(attributes) ? attributes : []).flatMap((attribute) => {
    const id = positiveId(attribute?.id ?? attribute?.attribute_id ?? attribute?.attributeId);
    const complexId = positiveId(attribute?.complex_id ?? attribute?.complexId ?? attribute?.attribute_complex_id) || 0;
    const name = categoryAttributeName(attribute);
    return id && complexId === 0 && name ? [{ id, complexId, name, raw: attribute }] : [];
  });
  const exact = candidates.filter((candidate) => normalizedAttributeLabel(candidate.name) === source);
  if (exact.length === 1) return exact[0];
  const comparable = candidates.filter((candidate) => comparableAttributeLabel(candidate.name) === sourceComparable);
  if (comparable.length === 1) return comparable[0];
  if (source === "размер") {
    const russianSize = candidates.filter((candidate) => normalizedAttributeLabel(candidate.name) === "российский размер");
    if (russianSize.length === 1) return russianSize[0];
  }
  if (source === "бренд") {
    const brand = candidates.filter((candidate) => normalizedAttributeLabel(candidate.name).startsWith("бренд"));
    if (brand.length === 1) return brand[0];
  }
  return null;
}

function injectPublicCharacteristicEvidence({ rawItems, sourceEvidenceAttributes, categoryAttributes, groupSeed }) {
  const grouping = (Array.isArray(categoryAttributes) ? categoryAttributes : []).find((attribute) =>
    positiveId(attribute?.id ?? attribute?.attribute_id ?? attribute?.attributeId) === GROUP_ATTRIBUTE_ID
      && (positiveId(attribute?.complex_id ?? attribute?.complexId ?? attribute?.attribute_complex_id) || 0) === 0
      && (attribute?.is_required === true || attribute?.required === true || attribute?.isRequired === true));
  const groupValue = text(groupSeed).slice(0, 180);
  return sourceEvidenceAttributes.map((attributes, index) => {
    const merged = [...attributes];
    const existing = new Set(merged.map((attribute) =>
      `${positiveId(attribute?.complex_id) || 0}:${positiveId(attribute?.id)}`));
    const captured = new Map();
    for (const pair of publicCharacteristicPairs(rawItems[index])) {
      const target = categoryAttributeForCharacteristic(categoryAttributes, pair.name);
      const key = target ? `${target.complexId}:${target.id}` : "";
      if (!target || existing.has(key)) continue;
      const collectionDictionary = (target.raw?.is_collection === true || target.raw?.multiple === true
        || target.raw?.isCollection === true)
        && positiveId(target.raw?.dictionary_id ?? target.raw?.dictionaryId ?? target.raw?.dictionary?.id);
      const values = collectionDictionary
        ? splitCollectionDictionaryValue(pair.value)
        : [{ value: pair.value }];
      // Variant aspect values are appended after the page-level facts, so the
      // selected PDP size cannot leak into every sibling variant.
      captured.set(key, {
        complex_id: target.complexId,
        id: target.id,
        values,
        ...(values.length > 1 ? { [WHOLE_OR_SPLIT_DICTIONARY_CANDIDATES]: true } : {}),
      });
    }
    for (const [key, attribute] of captured) {
      merged.push(attribute);
      existing.add(key);
    }
    if (grouping && groupValue && !existing.has(`0:${GROUP_ATTRIBUTE_ID}`)) {
      merged.push({
        complex_id: 0,
        id: GROUP_ATTRIBUTE_ID,
        values: [{ value: `source-${groupValue}` }],
      });
    }
    return merged;
  });
}

function projectContentAttributes(sourceAttributes, categoryAttributes) {
  const metadata = new Map((Array.isArray(categoryAttributes) ? categoryAttributes : []).flatMap((attribute) => {
    const id = positiveId(attribute?.id ?? attribute?.attribute_id ?? attribute?.attributeId);
    const complexId = positiveId(attribute?.complex_id ?? attribute?.complexId ?? attribute?.attribute_complex_id) || 0;
    const name = categoryAttributeName(attribute);
    return id && name ? [[`${complexId}:${id}`, attribute]] : [];
  }));
  return (Array.isArray(sourceAttributes) ? sourceAttributes : []).flatMap((attribute) => {
    const id = positiveId(attribute?.id ?? attribute?.attribute_id ?? attribute?.attributeId ?? attribute?.key);
    const complexId = positiveId(attribute?.complex_id ?? attribute?.complexId ?? attribute?.attribute_complex_id) || 0;
    const schema = metadata.get(`${complexId}:${id}`);
    const name = categoryAttributeName(schema);
    if (!id || CONTENT_ATTRIBUTE_EXCLUDED_IDS.has(id) || !name
      || !Array.isArray(attribute?.values) || !attribute.values.length) return [];
    const values = attribute.values.flatMap((entry) => {
      const value = text(entry?.value ?? entry?.name ?? entry?.title ?? entry);
      if (!value || value.length > 2_048) return [];
      const dictionaryValueId = positiveId(entry?.dictionary_value_id ?? entry?.dictionaryValueId);
      return [dictionaryValueId ? { value, dictionary_value_id: dictionaryValueId } : value];
    });
    if (!values.length) return [];
    const dictionaryId = positiveId(schema?.dictionary_id ?? schema?.dictionaryId ?? schema?.dictionary?.id) || 0;
    return [{
      id,
      name,
      value: typeof values[0] === "string" ? values[0] : values[0].value,
      values,
      required: schema?.is_required === true || schema?.required === true || schema?.isRequired === true,
      dictionaryId,
      multiple: schema?.is_collection === true || schema?.multiple === true || schema?.isCollection === true,
    }];
  });
}

function projectSharedContentAttributes(sourceAttributeSets, categoryAttributes) {
  const projected = sourceAttributeSets.map((attributes) => projectContentAttributes(attributes, categoryAttributes));
  if (!projected.length) return [];
  const comparisonKey = (attribute) => {
    const { value: _firstValue, values, ...metadata } = attribute;
    const normalizedValues = values.map((entry) => JSON.stringify(canonical(entry))).sort();
    return JSON.stringify(canonical({ ...metadata, values: normalizedValues }));
  };
  const later = projected.slice(1).map((attributes) => new Set(attributes.map(comparisonKey)));
  return projected[0].filter((attribute) => {
    const key = comparisonKey(attribute);
    return later.every((attributes) => attributes.has(key));
  });
}

function attributeValuePresent(value) {
  if (plainObject(value)) {
    return positiveId(value.dictionary_value_id ?? value.dictionaryValueId) > 0
      || text(value.value ?? value.name ?? value.title) !== "";
  }
  return (typeof value === "string" && text(value) !== "")
    || (typeof value === "number" && Number.isFinite(value));
}

function attributeCarriesBrand(attribute) {
  const id = positiveId(attribute?.id ?? attribute?.attribute_id ?? attribute?.attributeId ?? attribute?.key);
  const complexId = positiveId(
    attribute?.complex_id ?? attribute?.complexId ?? attribute?.attribute_complex_id,
  ) || 0;
  if (id !== BRAND_ATTRIBUTE_ID || complexId !== 0) return false;
  if (positiveId(attribute?.dictionary_value_id ?? attribute?.dictionaryValueId)) return true;
  if (attributeValuePresent(attribute?.value)) return true;
  const values = Array.isArray(attribute?.values) ? attribute.values
    : Array.isArray(attribute?.collection) ? attribute.collection : [];
  return values.some(attributeValuePresent);
}

function itemCarriesBrand(item, sourceAttributes) {
  if (text(item?.brand)) return true;
  const sourceVariant = plainObject(item?._sourceVariant) ? item._sourceVariant : {};
  const directBundle = plainObject(item?._bundleItem) ? item._bundleItem : {};
  const sourceBundle = plainObject(sourceVariant?._bundleItem) ? sourceVariant._bundleItem : {};
  const candidates = [
    ...(Array.isArray(item?.attributes) ? item.attributes : []),
    ...(Array.isArray(sourceAttributes) ? sourceAttributes : []),
    ...(Array.isArray(directBundle.attributes) ? directBundle.attributes : []),
    ...(Array.isArray(sourceBundle.attributes) ? sourceBundle.attributes : []),
    ...(Array.isArray(item?.bundleComplexAttrs) ? item.bundleComplexAttrs : []),
    ...(Array.isArray(sourceVariant?._bundleComplexAttrs) ? sourceVariant._bundleComplexAttrs : []),
    ...(Array.isArray(item?.complex_attributes)
      ? item.complex_attributes.flatMap((group) => Array.isArray(group?.attributes) ? group.attributes : [])
      : []),
  ];
  return candidates.some(attributeCarriesBrand);
}

function missingNoBrandVariantIndexes({ rawItems, sourceEvidenceAttributes, metadata }) {
  const brand = metadata.attributes.find((attribute) => attribute.id === BRAND_ATTRIBUTE_ID
    && attribute.complexId === 0 && attribute.required === true && positiveId(attribute.dictionaryId));
  if (!brand) return [];
  return rawItems.flatMap((item, index) =>
    itemCarriesBrand(item, sourceEvidenceAttributes[index]) ? [] : [index]);
}

function forcedNoBrandVariantIndexes({ rawItems, metadata }) {
  const brand = metadata.attributes.find((attribute) => attribute.id === BRAND_ATTRIBUTE_ID
    && attribute.complexId === 0 && positiveId(attribute.dictionaryId));
  if (!brand) throw failure("AUTO_LISTING_REQUIRED_BRAND_UNRESOLVED");
  return rawItems.map((_item, index) => index);
}

function normalizedNoBrand(value) {
  return text(value).replace(/\s+/gu, " ").toLocaleLowerCase("ru-RU");
}

function canonicalNoBrandOption(values) {
  try {
    if (!Array.isArray(values) || utilTypes.isProxy(values)
      || Object.getPrototypeOf(values) !== Array.prototype || values.length > 5_000) {
      throw new Error("invalid no-brand dictionary values");
    }
    const matches = values.flatMap((option) => {
      if (!plainObject(option) || utilTypes.isProxy(option)) return [];
      const descriptors = Object.getOwnPropertyDescriptors(option);
      const allowed = new Set(["id", "value", "info", "picture"]);
      if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !allowed.has(key)
        || descriptors[key].get || descriptors[key].set || descriptors[key].enumerable !== true)
        || !Object.hasOwn(descriptors, "id") || !Object.hasOwn(descriptors, "value")) return [];
      const id = positiveId(descriptors.id.value);
      const value = text(descriptors.value.value);
      return id && value.length <= 500
        && normalizedNoBrand(value) === normalizedNoBrand(OZON_NO_BRAND_VALUE)
        ? [{ id, value }] : [];
    });
    if (matches.length === 1) return matches[0];
  } catch {
    // The fixed safe error below intentionally replaces hostile or malformed dependency data.
  }
  throw failure("AUTO_LISTING_REQUIRED_BRAND_UNRESOLVED");
}

function withNoBrandCandidate(candidates) {
  let found = false;
  const resolved = candidates.map((candidate) => {
    if (normalizedNoBrand(candidate?.value) !== normalizedNoBrand(OZON_NO_BRAND_VALUE)) return candidate;
    found = true;
    return positiveId(candidate?.id) ? candidate : { ...candidate, id: OZON_NO_BRAND_VALUE_ID_HINT };
  });
  return found ? resolved : [...resolved, {
    id: OZON_NO_BRAND_VALUE_ID_HINT,
    value: OZON_NO_BRAND_VALUE,
  }];
}

function retryableCategoryDependency(error) {
  return error?.retryable === true || error?.diagnostic?.retryable === true || Number(error?.status) >= 500;
}

function injectNoBrandSourceEvidence(sourceEvidenceAttributes, indexes, option, { replace = false } = {}) {
  const selected = new Set(indexes);
  return sourceEvidenceAttributes.map((attributes, index) => selected.has(index)
    ? [...(replace ? attributes.filter((attribute) => !attributeCarriesBrand(attribute)) : attributes), {
        complex_id: 0,
        id: BRAND_ATTRIBUTE_ID,
        values: [{ value: option.value, dictionary_value_id: option.id }],
      }]
    : attributes);
}

function targetTypeDictionaryOption(metadata, typeId) {
  const attribute = metadata.attributes.find((candidate) => candidate.id === TYPE_ATTRIBUTE_ID
    && candidate.complexId === 0 && candidate.dictionaryId);
  if (!attribute) return null;
  const matches = attribute.dictionaryValues.filter((option) => option.id === typeId);
  if (matches.length !== 1) throw failure("AUTO_LISTING_CATEGORY_DICTIONARY_UNRESOLVED");
  return matches[0];
}

function injectTargetTypeSourceEvidence(sourceEvidenceAttributes, option) {
  return sourceEvidenceAttributes.map((attributes) => [
    ...attributes.filter((attribute) => !(positiveId(attribute?.id) === TYPE_ATTRIBUTE_ID
      && (positiveId(attribute?.complex_id) || 0) === 0)),
    {
      complex_id: 0,
      id: TYPE_ATTRIBUTE_ID,
      values: [{ value: option.value, dictionary_value_id: option.id }],
    },
  ]);
}

function inputAttributeKeys(items, sourceEvidenceAttributes = []) {
  const keys = new Set();
  const include = (attribute) => {
    const id = positiveId(attribute?.id ?? attribute?.attribute_id ?? attribute?.attributeId ?? attribute?.key);
    const complexId = positiveId(
      attribute?.complex_id ?? attribute?.complexId ?? attribute?.attribute_complex_id,
    ) || 0;
    if (id) keys.add(`${complexId}:${id}`);
  };
  const includeAttributes = (value) => {
    for (const attribute of Array.isArray(value) ? value : []) include(attribute);
  };
  for (const item of items) {
    const sourceVariant = plainObject(item?._sourceVariant) ? item._sourceVariant : {};
    const directBundle = plainObject(item?._bundleItem) ? item._bundleItem : {};
    const sourceBundle = plainObject(sourceVariant?._bundleItem) ? sourceVariant._bundleItem : {};
    includeAttributes(item.attributes);
    includeAttributes(sourceVariant.attributes);
    includeAttributes(directBundle.attributes);
    includeAttributes(sourceBundle.attributes);
    includeAttributes(item.bundleComplexAttrs);
    includeAttributes(sourceVariant._bundleComplexAttrs);
    for (const group of Array.isArray(item.complex_attributes) ? item.complex_attributes : []) {
      includeAttributes(group?.attributes);
    }
  }
  for (const attributes of sourceEvidenceAttributes) includeAttributes(attributes);
  return keys;
}

function dictionaryMatchCandidates(sourceAttributes, attributeId) {
  const candidates = [];
  const seen = new Set();
  for (const attributes of sourceAttributes) {
    for (const attribute of attributes) {
      if (positiveId(attribute?.id) !== attributeId) continue;
      for (const value of Array.isArray(attribute?.values) ? attribute.values : []) {
        const id = positiveId(value?.dictionary_value_id);
        const candidateValue = text(value?.value);
        const key = `${id || 0}:${candidateValue.toLocaleLowerCase("ru-RU")}`;
        if ((!id && !candidateValue) || seen.has(key)) continue;
        seen.add(key);
        candidates.push({ ...(id ? { id } : {}), ...(candidateValue ? { value: candidateValue } : {}) });
      }
    }
  }
  return candidates;
}

function brandDictionaryMatchCandidates(rawItems, sourceAttributes) {
  const candidates = dictionaryMatchCandidates(sourceAttributes, BRAND_ATTRIBUTE_ID);
  const seenText = new Set(candidates.map((candidate) => normalizedNoBrand(candidate.value)).filter(Boolean));
  for (const item of rawItems) {
    const value = text(item?.brand);
    const key = normalizedNoBrand(value);
    if (!key || seenText.has(key)) continue;
    seenText.add(key);
    candidates.push({ value });
  }
  return candidates;
}

function unresolvedBrandVariantIndexes(rawItems, sourceEvidenceAttributes, metadata) {
  const brand = metadata.attributes.find((attribute) => attribute.id === BRAND_ATTRIBUTE_ID
    && attribute.complexId === 0 && positiveId(attribute.dictionaryId));
  if (!brand) return [];
  const optionsById = new Map(brand.dictionaryValues.map((option) => [option.id, option]));
  const optionsByText = new Map();
  for (const option of brand.dictionaryValues) {
    const key = normalizedNoBrand(option.value);
    const matches = optionsByText.get(key) || [];
    matches.push(option);
    optionsByText.set(key, matches);
  }
  return sourceEvidenceAttributes.flatMap((attributes, index) => {
    const evidenceCandidates = dictionaryMatchCandidates([attributes], BRAND_ATTRIBUTE_ID);
    const candidates = evidenceCandidates.length ? evidenceCandidates
      : text(rawItems[index]?.brand) ? [{ value: text(rawItems[index].brand) }] : [];
    if (!candidates.length) return [index];
    const allResolved = candidates.every((candidate) => {
      const suppliedId = positiveId(candidate.id);
      if (suppliedId && optionsById.has(suppliedId)) return true;
      const normalizedValue = normalizedNoBrand(candidate.value);
      return normalizedValue && (optionsByText.get(normalizedValue) || []).length === 1;
    });
    return allResolved ? [] : [index];
  });
}

function hydrateSourceDictionaryAttributes(sourceAttributes, metadata) {
  const metadataByKey = new Map(metadata.attributes.map((attribute) => [
    `${attribute.complexId}:${attribute.id}`, attribute,
  ]));
  return sourceAttributes.map((attributes) => attributes.flatMap((attribute) => {
    const meta = metadataByKey.get(`${positiveId(attribute.complex_id) || 0}:${positiveId(attribute.id)}`);
    if (!meta?.dictionaryId) return [attribute];
    const optionsById = new Map(meta.dictionaryValues.map((option) => [option.id, option]));
    const optionsByText = new Map();
    for (const option of meta.dictionaryValues) {
      const key = option.value.replace(/\s+/gu, " ").trim().toLocaleLowerCase("ru-RU");
      const matches = optionsByText.get(key) || [];
      matches.push(option);
      optionsByText.set(key, matches);
    }
    const matchValue = (value) => {
      const suppliedId = positiveId(value.dictionary_value_id);
      const exactById = suppliedId ? optionsById.get(suppliedId) : null;
      const exactText = text(value.value).replace(/\s+/gu, " ").toLocaleLowerCase("ru-RU");
      const textMatches = exactText ? optionsByText.get(exactText) || [] : [];
      return exactById || (textMatches.length === 1 ? textMatches[0] : null);
    };
    let hydratedValues = [];
    if (attribute[WHOLE_OR_SPLIT_DICTIONARY_CANDIDATES] === true) {
      const whole = matchValue(attribute.values[0]);
      if (whole) {
        hydratedValues = [{ value: whole.value, dictionary_value_id: whole.id }];
      } else {
        const splitMatches = attribute.values.slice(1).map(matchValue);
        if (splitMatches.every(Boolean)) {
          hydratedValues = splitMatches.map((matched) => ({
            value: matched.value,
            dictionary_value_id: matched.id,
          }));
        }
      }
    } else {
      for (const value of attribute.values) {
        const matched = matchValue(value);
        if (!matched) {
          if (meta.required) throw failure("AUTO_LISTING_CATEGORY_DICTIONARY_UNRESOLVED");
          continue;
        }
        hydratedValues.push({ value: matched.value, dictionary_value_id: matched.id });
      }
    }
    if (!hydratedValues.length) {
      if (meta.required) throw failure("AUTO_LISTING_CATEGORY_DICTIONARY_UNRESOLVED");
      return [];
    }
    const { [WHOLE_OR_SPLIT_DICTIONARY_CANDIDATES]: _candidateMode, ...safeAttribute } = attribute;
    return [{ ...safeAttribute, values: hydratedValues }];
  }));
}

function sourceVariant(raw, normalized, index) {
  const sourceSku = text(raw?.sku || raw?.sourceSku || raw?.source_sku || raw?.scraped_sku);
  const sourceVariantId = text(raw?.offer_id || raw?.offerId || sourceSku || String(index + 1));
  if (!sourceSku || !sourceVariantId) throw failure("AUTO_LISTING_LISTING_BASE_INCOMPLETE");
  return { sourceVariantId, sourceSku, item: normalized };
}

function exactTargetCategory(value) {
  const positive = (nested) => /^[1-9][0-9]*$/u.test(String(nested ?? ""))
    && Number.isSafeInteger(Number(nested));
  if (!plainObject(value)
    || value.schemaVersion !== "AUTO_LISTING_ACCOUNT_CATEGORY_V2"
    || !text(value.evidenceId) || !text(value.sharedCategoryId)
    || !Number.isSafeInteger(value.sharedCategoryVersion) || value.sharedCategoryVersion < 1
    || !positive(value.sourceDescriptionCategoryId) || !positive(value.sourceTypeId)
    || !positive(value.descriptionCategoryId) || !positive(value.typeId)
    || value.taxonomyScope !== "OZON:DEFAULT"
    || !(value.taxonomyFingerprint === "" || HASH.test(value.taxonomyFingerprint || ""))
    || !["SOURCE_DIRECT", "OZON_REFRESH", "MANUAL"].includes(value.provenance)) {
    throw failure("AUTO_LISTING_SOURCE_CATEGORY_REQUIRED", 409);
  }
  return Object.freeze(structuredClone(value));
}

function assertDependencies({ loadStoreAccess, categoryService, normalizeItems, buildRawItems }) {
  if (typeof loadStoreAccess !== "function" || typeof normalizeItems !== "function" || typeof buildRawItems !== "function"
    || !categoryService || ["getCategoryAttributes", "getCategoryAttributeValues"]
      .some((key) => typeof categoryService[key] !== "function")) {
    throw new TypeError("Auto listing base preparer dependencies are required");
  }
}

export function createAutoListingListingBasePreparer({
  loadStoreAccess,
  categoryService,
  normalizeItems = normalizeOzonImportItems,
  buildRawItems = defaultRawItems,
  versions = {
    normalizerVersion: "v3",
    categoryRuleVersion: "2026-07-v1",
    dictionaryVersion: "live-api",
  },
} = {}) {
  assertDependencies({ loadStoreAccess, categoryService, normalizeItems, buildRawItems });
  const fallbackVersions = {
    normalizerVersion: text(versions?.normalizerVersion),
    categoryRuleVersion: text(versions?.categoryRuleVersion),
    dictionaryVersion: text(versions?.dictionaryVersion),
  };
  if (Object.values(fallbackVersions).some((value) => !value)) {
    throw new TypeError("Auto listing base preparer versions are required");
  }

  return async function prepareAutoListingListingBase({
    accountId, brandMode = "PREFER_SOURCE", source, targetStore, targetCategory, pricingEvidence,
    variantPricingEvidence = null, signal,
  } = {}) {
    const safeSource = projectOzonCategorySourceData(source);
    if (!["PREFER_SOURCE", "FORCE_NO_BRAND"].includes(brandMode)) {
      throw failure("AUTO_LISTING_CONFIG_INVALID", 400);
    }
    const forceNoBrand = brandMode === "FORCE_NO_BRAND";
    const scope = text(accountId);
    const targetStoreId = text(targetStore?.id);
    const ownerAccountId = text(targetStore?.ownerAccountId || targetStore?.accountId);
    if (!scope || !targetStoreId || ownerAccountId !== scope) throw failure("AUTO_LISTING_TARGET_STORE_FORBIDDEN", 403);
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      throw failure("AUTO_LISTING_CATEGORY_LEASE_INVALID", 500);
    }
    signal?.throwIfAborted();
    const { productDraft, versions: frozenVersions } = productDraftEvidence(safeSource, fallbackVersions);
    const frozenPriceEvidence = priceEvidence(pricingEvidence);
    let frozenVariantPrices = null;
    if (variantPricingEvidence !== null) {
      if (!Array.isArray(variantPricingEvidence) || !variantPricingEvidence.length) {
        throw failure("AUTO_LISTING_PRICE_EVIDENCE_INVALID");
      }
      frozenVariantPrices = new Map();
      for (const entry of variantPricingEvidence) {
        const sourceSku = text(entry?.sourceSku);
        if (!sourceSku || frozenVariantPrices.has(sourceSku)) {
          throw failure("AUTO_LISTING_PRICE_EVIDENCE_INVALID");
        }
        frozenVariantPrices.set(sourceSku, priceEvidence({
          currency: entry.currency,
          ...(entry.currencySource === undefined ? {} : { currencySource: entry.currencySource }),
          blackKopecks: entry.blackKopecks,
          greenKopecks: entry.greenKopecks,
        }));
      }
    }
    const category = exactTargetCategory(targetCategory);
    const builtItems = buildRawItems(safeSource, { currencyCode: frozenPriceEvidence.currency });
    const projectedSource = projectOzonCategorySourceItems(builtItems);
    let rawItems = projectedSource.items.map((item) => ({
      ...item,
      description_category_id: Number(category.descriptionCategoryId),
      descriptionCategoryId: Number(category.descriptionCategoryId),
      type_id: Number(category.typeId),
      typeId: Number(category.typeId),
    }));
    let sourceEvidenceAttributes = projectedSource.sourceEvidenceAttributes;
    const sourceVariantIds = rawItems.map((item, index) => sourceVariant(item, null, index).sourceVariantId);
    if (new Set(sourceVariantIds).size !== sourceVariantIds.length) {
      throw failure("AUTO_LISTING_SOURCE_CATEGORY_REQUIRED", 409);
    }
    const storeAccess = await loadStoreAccess({ accountId: scope, targetStoreId });
    const storeCurrency = normalizeAutoListingCurrency(storeAccess?.currencyCode || storeAccess?.currency_code || storeAccess?.currency);
    if (!plainObject(storeAccess) || text(storeAccess.id) !== targetStoreId
      || text(storeAccess.ownerAccountId || storeAccess.accountId) !== scope
      || !text(storeAccess.clientId) || !text(storeAccess.apiKey)) {
      throw failure("AUTO_LISTING_TARGET_STORE_CREDENTIALS_UNAVAILABLE", 409);
    }
    if (!storeCurrency || storeCurrency !== frozenPriceEvidence.currency) {
      throw failure("AUTO_LISTING_PRICE_EVIDENCE_INVALID");
    }
    const categoryDictionaryValues = new Map();
    const dictionaryKey = (descriptionCategoryId, typeId, attributeIdValue) =>
      `${Number(descriptionCategoryId)}:${Number(typeId)}:${Number(attributeIdValue)}`;
    const sourceCategory = Object.freeze({
      kind: "UNIQUE_MATCH",
      descriptionCategoryId: Number(category.descriptionCategoryId),
      typeId: Number(category.typeId),
    });
    let rawCategoryAttributes;
    try {
      const attributeResult = await categoryService.getCategoryAttributes({
        accountId: scope,
        store: storeAccess,
        descriptionCategoryId: sourceCategory.descriptionCategoryId,
        typeId: sourceCategory.typeId,
        language: "DEFAULT",
        ...(signal ? { signal } : {}),
      });
      if (!Array.isArray(attributeResult?.items) || attributeResult.items.length > 1_000) {
        throw failure("AUTO_LISTING_CATEGORY_ATTRIBUTES_INCOMPLETE");
      }
      rawCategoryAttributes = attributeResult.items;
    } catch (source) {
      const retryable = retryableCategoryDependency(source);
      throw failure("AUTO_LISTING_CATEGORY_ATTRIBUTES_INCOMPLETE", retryable ? 503 : 422, retryable);
    }
    const metadataInput = () => ({
      descriptionCategoryId: sourceCategory.descriptionCategoryId,
      typeId: sourceCategory.typeId,
      attributes: rawCategoryAttributes,
      dictionaryValues: [...categoryDictionaryValues.entries()].map(([key, values]) => ({
        attributeId: Number(key.split(":")[2]),
        values,
      })),
    });
    const preliminaryMetadata = buildOzonCategoryRebuildMetadata(metadataInput());
    const draft = plainObject(safeSource?.collectItem?.listingDraft) ? safeSource.collectItem.listingDraft : {};
    const groupSeed = text(draft.sku || safeSource?.collectItem?.sourceSku || safeSource?.collectItem?.sku
      || rawItems[0]?.sku);
    sourceEvidenceAttributes = injectPublicCharacteristicEvidence({
      rawItems,
      sourceEvidenceAttributes,
      categoryAttributes: rawCategoryAttributes,
      groupSeed,
    });
    const manufacturingCountry = defaultOzonManufacturingCountryAttribute();
    if (preliminaryMetadata.attributes.some(attribute => attribute.id === manufacturingCountry.id
      && attribute.complexId === 0)) {
      sourceEvidenceAttributes = sourceEvidenceAttributes.map(attributes => [
        ...attributes.filter(attribute => attribute.id !== manufacturingCountry.id || attribute.complex_id !== 0),
        defaultOzonManufacturingCountryAttribute(),
      ]);
    }
    const noBrandVariantIndexes = forceNoBrand
      ? forcedNoBrandVariantIndexes({ rawItems, metadata: preliminaryMetadata })
      : missingNoBrandVariantIndexes({ rawItems, sourceEvidenceAttributes, metadata: preliminaryMetadata });
    const usedAttributeKeys = inputAttributeKeys(rawItems, sourceEvidenceAttributes);
    const dictionaryAttributeIds = [...new Set(preliminaryMetadata.attributes
      .filter((attribute) => attribute.dictionaryId
        && (attribute.required || usedAttributeKeys.has(`${attribute.complexId}:${attribute.id}`)
          || (attribute.id === BRAND_ATTRIBUTE_ID && noBrandVariantIndexes.length > 0)))
      .map((attribute) => attribute.id))].sort((left, right) => left - right);
    for (const attributeIdValue of dictionaryAttributeIds) {
      let dictionaryItems;
      const resolvesBrand = attributeIdValue === BRAND_ATTRIBUTE_ID
        && preliminaryMetadata.attributes.some((attribute) => attribute.id === BRAND_ATTRIBUTE_ID
          && attribute.complexId === 0 && attribute.dictionaryId);
      const resolvesMissingBrand = attributeIdValue === BRAND_ATTRIBUTE_ID
        && noBrandVariantIndexes.length > 0;
      const resolvesTargetType = attributeIdValue === TYPE_ATTRIBUTE_ID
        && preliminaryMetadata.attributes.some((attribute) => attribute.id === TYPE_ATTRIBUTE_ID
          && attribute.complexId === 0 && attribute.dictionaryId);
      try {
        const sourceCandidates = resolvesTargetType
          ? [{ id: sourceCategory.typeId }]
          : resolvesBrand
            ? brandDictionaryMatchCandidates(rawItems, sourceEvidenceAttributes)
            : dictionaryMatchCandidates(sourceEvidenceAttributes, attributeIdValue);
        const matchCandidates = resolvesBrand
          ? withNoBrandCandidate(sourceCandidates) : sourceCandidates;
        const dictionaryResult = await categoryService.getCategoryAttributeValues({
          accountId: scope,
          store: storeAccess,
          descriptionCategoryId: sourceCategory.descriptionCategoryId,
          typeId: sourceCategory.typeId,
          attributeId: attributeIdValue,
          language: "DEFAULT",
          limit: 5_000,
          ...(matchCandidates.length ? { matchCandidates } : {}),
          ...(signal ? { signal } : {}),
        });
        if (!Array.isArray(dictionaryResult?.items) || dictionaryResult.items.length > 5_000) {
          throw failure("AUTO_LISTING_CATEGORY_DICTIONARY_UNRESOLVED");
        }
        dictionaryItems = dictionaryResult.items;
      } catch (source) {
        const retryable = retryableCategoryDependency(source);
        throw failure(resolvesMissingBrand
          ? "AUTO_LISTING_REQUIRED_BRAND_UNRESOLVED"
          : "AUTO_LISTING_CATEGORY_DICTIONARY_UNRESOLVED", retryable ? 503 : 422, retryable);
      }
      categoryDictionaryValues.set(
        dictionaryKey(sourceCategory.descriptionCategoryId, sourceCategory.typeId, attributeIdValue),
        dictionaryItems,
      );
    }
    const brandDictionaryKey = dictionaryKey(
      sourceCategory.descriptionCategoryId,
      sourceCategory.typeId,
      BRAND_ATTRIBUTE_ID,
    );
    const requiredNoBrandOption = noBrandVariantIndexes.length
      ? canonicalNoBrandOption(categoryDictionaryValues.get(brandDictionaryKey))
      : null;
    const currentCategoryMetadata = buildOzonCategoryRebuildMetadata(metadataInput());
    const noBrandFallbackIndexes = forceNoBrand
      ? rawItems.map((_item, index) => index)
      : categoryDictionaryValues.has(brandDictionaryKey)
        ? unresolvedBrandVariantIndexes(rawItems, sourceEvidenceAttributes, currentCategoryMetadata)
        : [];
    if (noBrandFallbackIndexes.length) {
      sourceEvidenceAttributes = injectNoBrandSourceEvidence(
        sourceEvidenceAttributes,
        noBrandFallbackIndexes,
        requiredNoBrandOption || canonicalNoBrandOption(categoryDictionaryValues.get(brandDictionaryKey)),
        { replace: true },
      );
    }
    const targetTypeKey = dictionaryKey(
      sourceCategory.descriptionCategoryId,
      sourceCategory.typeId,
      TYPE_ATTRIBUTE_ID,
    );
    const targetTypeOption = categoryDictionaryValues.has(targetTypeKey)
      ? targetTypeDictionaryOption(currentCategoryMetadata, sourceCategory.typeId)
      : null;
    if (targetTypeOption) {
      sourceEvidenceAttributes = injectTargetTypeSourceEvidence(sourceEvidenceAttributes, targetTypeOption);
    }
    sourceEvidenceAttributes = hydrateSourceDictionaryAttributes(sourceEvidenceAttributes, currentCategoryMetadata);
    rawItems = rawItems.map((item, index) => ({
      ...item,
      _sourceVariant: {
        ...(plainObject(item._sourceVariant) ? item._sourceVariant : {}),
        attributes: sourceEvidenceAttributes[index],
      },
    }));
    const assertLocalCategory = (descriptionCategoryId, typeId) => {
      if (positiveId(descriptionCategoryId) !== sourceCategory.descriptionCategoryId
        || positiveId(typeId) !== sourceCategory.typeId) {
        throw failure("AUTO_LISTING_SOURCE_VERSION_CONFLICT", 409);
      }
    };
    const normalized = await normalizeItems(rawItems, {
      strictTypeMatch: true,
      categoryMatchPolicy: "SOURCE_CATEGORY_STRICT",
      sourceCategory,
      currentCategoryMetadata,
      allowUnresolvedRequiredDictionaryValues: false,
      getCategoryAttributes: async (descriptionCategoryId, typeId) => {
        assertLocalCategory(descriptionCategoryId, typeId);
        return rawCategoryAttributes;
      },
      getCategoryAttributeValues: async (descriptionCategoryId, typeId, attributeIdValue) => {
        assertLocalCategory(descriptionCategoryId, typeId);
        const normalizedAttributeId = positiveId(attributeIdValue);
        if (!normalizedAttributeId) throw failure("AUTO_LISTING_CATEGORY_DICTIONARY_UNRESOLVED");
        const key = dictionaryKey(descriptionCategoryId, typeId, normalizedAttributeId);
        if (!categoryDictionaryValues.has(key)) {
          throw failure("AUTO_LISTING_CATEGORY_DICTIONARY_UNRESOLVED");
        }
        return categoryDictionaryValues.get(key);
      },
    });
    if (!Array.isArray(normalized?.items) || normalized.items.length !== rawItems.length
      || normalized.items.some((item) => !plainObject(item))) {
      throw failure("AUTO_LISTING_LISTING_BASE_INCOMPLETE");
    }
    if (normalized.items.some((item, index) =>
      text(item.offer_id) !== sourceVariant(rawItems[index], item, index).sourceVariantId)) {
      throw failure("AUTO_LISTING_SOURCE_CATEGORY_REQUIRED", 409);
    }
    const normalizedItems = normalized.items.map((item, index) => {
      const variant = sourceVariant(rawItems[index], item, index);
      const evidence = frozenVariantPrices?.get(variant.sourceSku) || frozenPriceEvidence;
      return { ...item, price: priceAmountFromEvidence(evidence) };
    });
    if (normalizedItems.some((item) => item.currency_code !== storeCurrency)) {
      throw failure("AUTO_LISTING_PRICE_EVIDENCE_INVALID");
    }
    if (normalizedItems.some((item) => Number(item.description_category_id) !== Number(category.descriptionCategoryId)
      || Number(item.type_id) !== Number(category.typeId))) {
      throw failure("AUTO_LISTING_SOURCE_VERSION_CONFLICT", 409);
    }
    const richContentAttributeSupported = currentCategoryMetadata.attributes
      .some((attribute) => attribute.id === RICH_CONTENT_ATTRIBUTE_ID);
    const rebuiltItems = rebuildOzonItemsForCategory({
      originalItems: normalizedItems,
      sourceEvidenceAttributes,
      replacementCategory: sourceCategory,
      currentCategoryMetadata,
    });

    const frozenVariants = rebuiltItems.map((item, index) => sourceVariant(rawItems[index], item, index));
    if (frozenVariantPrices
      && (frozenVariantPrices.size !== frozenVariants.length
        || frozenVariants.some((variant) => !frozenVariantPrices.has(variant.sourceSku)))) {
      throw failure("AUTO_LISTING_PRICE_EVIDENCE_INVALID");
    }
    return deepFreeze({
      productDraft,
      pricingEvidence: frozenPriceEvidence,
      richContentAttributeSupported,
      contentAttributes: projectSharedContentAttributes(sourceEvidenceAttributes, rawCategoryAttributes),
      variants: frozenVariants.map((variant) => ({
        ...variant,
        ...(frozenVariantPrices ? { pricingEvidence: frozenVariantPrices.get(variant.sourceSku) } : {}),
      })),
      versions: frozenVersions,
    });
  };
}
