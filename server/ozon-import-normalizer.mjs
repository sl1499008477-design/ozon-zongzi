import { assertOzonRussianProductText, hasChineseProductText, preferOzonRussianText } from "./ozon-product-language.mjs";
import { collectedAttributeValues } from "./collector-attribute-values.mjs";
import { types } from "node:util";
import { EntityDecoder, ALL_ENTITIES } from "@nodable/entities";

const TYPE_MATCH_SCORE = {
  EXACT: 3,
  NORMALIZED: 2,
  STEM: 1.5,
  PARTIAL: 1,
};
const OZON_NO_BRAND_VALUE = "Нет бренда";
const MANUFACTURING_COUNTRY_ATTRIBUTE_ID = 4389;
const RICH_CONTENT_ATTRIBUTE_ID = 11254;
const HASHTAGS_ATTRIBUTE_ID = 23171;
const LEGACY_HASHTAGS_ATTRIBUTE_ID = 22508;
const HASHTAGS_ATTRIBUTE_IDS = new Set([HASHTAGS_ATTRIBUTE_ID, LEGACY_HASHTAGS_ATTRIBUTE_ID]);
const MAX_HASHTAGS = 30;
const MAX_HASHTAG_LENGTH = 30;
const descriptionEntities = new EntityDecoder({ namedEntities: ALL_ENTITIES });
const STRICT_METADATA_KEYS = new Set(["descriptionCategoryId", "typeId", "attributes"]);
const STRICT_ATTRIBUTE_KEYS = new Set(["id", "complexId", "required", "dictionaryId", "dictionaryValues"]);
const STRICT_DICTIONARY_VALUE_KEYS = new Set(["id", "value"]);

export function defaultOzonManufacturingCountryAttribute() {
  return {
    id: MANUFACTURING_COUNTRY_ATTRIBUTE_ID,
    complex_id: 0,
    values: [{ dictionary_value_id: 90296, value: "Китай" }],
  };
}

function autoListingCategoryFailure(code, status) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  error.retryable = false;
  error.cause = null;
  return error;
}

function sourceCategoryRequiredError() {
  return autoListingCategoryFailure("AUTO_LISTING_SOURCE_CATEGORY_REQUIRED", 409);
}

function incompleteCategoryAttributesError() {
  return autoListingCategoryFailure("AUTO_LISTING_CATEGORY_ATTRIBUTES_INCOMPLETE", 422);
}

function unresolvedCategoryDictionaryError() {
  return autoListingCategoryFailure("AUTO_LISTING_CATEGORY_DICTIONARY_UNRESOLVED", 422);
}

function videoCountLimitError() {
  return autoListingCategoryFailure("ZONGZI_VIDEO_COUNT_LIMIT", 422);
}

function strictPositiveId(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : 0;
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) return 0;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : 0;
}

function strictDataRecord(value, allowedKeys, exactKeys, errorFactory) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw errorFactory();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || !allowedKeys.has(key)
    || descriptors[key].get || descriptors[key].set || descriptors[key].enumerable !== true)
    || keys.length !== exactKeys.size
    || [...exactKeys].some((key) => !Object.hasOwn(descriptors, key))) throw errorFactory();
  return descriptors;
}

function strictDataArray(value, maximum, errorFactory) {
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

function strictCategoryAttributeContext(sourceCategory, value) {
  const root = strictDataRecord(
    value, STRICT_METADATA_KEYS, STRICT_METADATA_KEYS, incompleteCategoryAttributesError,
  );
  if (strictPositiveId(root.descriptionCategoryId.value) !== sourceCategory.descriptionCategoryId
    || strictPositiveId(root.typeId.value) !== sourceCategory.typeId) throw sourceCategoryRequiredError();
  const attributes = root.attributes.value;
  const attributeDescriptors = strictDataArray(attributes, 1_000, incompleteCategoryAttributesError);
  const allowedIds = new Set();
  const metaById = new Map();
  const metaByKey = new Map();
  for (let index = 0; index < attributes.length; index += 1) {
    const descriptor = strictDataRecord(
      attributeDescriptors[String(index)].value,
      STRICT_ATTRIBUTE_KEYS,
      STRICT_ATTRIBUTE_KEYS,
      incompleteCategoryAttributesError,
    );
    const id = strictPositiveId(descriptor.id.value);
    const rawComplexId = descriptor.complexId.value;
    const complexId = rawComplexId === 0 || rawComplexId === "0" ? 0 : strictPositiveId(rawComplexId);
    const required = descriptor.required.value;
    const rawDictionaryId = descriptor.dictionaryId.value;
    const dictionaryId = rawDictionaryId == null ? 0 : strictPositiveId(rawDictionaryId);
    if (!id || (rawComplexId !== 0 && rawComplexId !== "0" && !complexId)
      || typeof required !== "boolean" || (rawDictionaryId != null && !dictionaryId)) {
      throw incompleteCategoryAttributesError();
    }
    const rawValues = descriptor.dictionaryValues.value;
    const valueDescriptors = strictDataArray(rawValues, 5_000, unresolvedCategoryDictionaryError);
    const dictionaryValues = [];
    const seenValues = new Set();
    for (let valueIndex = 0; valueIndex < rawValues.length; valueIndex += 1) {
      const option = strictDataRecord(
        valueDescriptors[String(valueIndex)].value,
        STRICT_DICTIONARY_VALUE_KEYS,
        STRICT_DICTIONARY_VALUE_KEYS,
        unresolvedCategoryDictionaryError,
      );
      const optionId = strictPositiveId(option.id.value);
      if (!optionId || typeof option.value.value !== "string" || !option.value.value.trim()
        || seenValues.has(optionId)) throw unresolvedCategoryDictionaryError();
      seenValues.add(optionId);
      dictionaryValues.push({ id: optionId, value: option.value.value });
    }
    if (!dictionaryId && dictionaryValues.length) throw unresolvedCategoryDictionaryError();
    const key = `${complexId}:${id}`;
    if (metaByKey.has(key)) throw incompleteCategoryAttributesError();
    const metadata = {
      id,
      complex_id: complexId,
      is_required: required,
      dictionary_id: dictionaryId,
      dictionaryValues,
    };
    allowedIds.add(id);
    metaById.set(id, metadata);
    metaByKey.set(key, metadata);
  }
  if (!metaByKey.size) throw incompleteCategoryAttributesError();
  return { allowedIds, metaById, metaByKey };
}

function strictSourceCategoryOf(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw sourceCategoryRequiredError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const expected = ["kind", "descriptionCategoryId", "typeId"];
  if (keys.length !== expected.length || keys.some((key) => typeof key !== "string"
    || !expected.includes(key) || descriptors[key].get || descriptors[key].set
    || descriptors[key].enumerable !== true)) throw sourceCategoryRequiredError();
  const source = {
    kind: descriptors.kind.value,
    descriptionCategoryId: strictPositiveId(descriptors.descriptionCategoryId.value),
    typeId: strictPositiveId(descriptors.typeId.value),
  };
  if (source.kind !== "UNIQUE_MATCH" || !source.descriptionCategoryId || !source.typeId) {
    throw sourceCategoryRequiredError();
  }
  return source;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstFilled(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return value;
  }
  return undefined;
}

function toPositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function cleanText(value, max = 0) {
  if (value == null) return "";
  const text = String(value).replace(/\s+/g, " ").trim();
  return max > 0 && text.length > max ? text.slice(0, max) : text;
}

function normalizeName(value) {
  return cleanText(value)
    .toLocaleLowerCase("ru-RU")
    .replace(/[ё]/g, "е")
    .replace(/["'`«»]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isNoBrandValue(value) {
  const text = normalizeName(value);
  return text === "нет бренда" ||
    text === "без бренда" ||
    text === "нет торговой марки" ||
    text === "без торговой марки" ||
    text === "no brand" ||
    text === "无品牌";
}

function isHashtagAttributeId(id) {
  return HASHTAGS_ATTRIBUTE_IDS.has(Number(id));
}

function stemNameToken(token) {
  if (!token || token.length < 5) return token;
  return token.replace(/(иями|ями|ами|ого|ему|ыми|ими|ыми|ыми|ая|яя|ое|ее|ий|ый|ой|ые|ие|ов|ев|ей|ам|ям|ах|ях|ом|ем|ую|юю|а|я|ы|и|ь|е|у|ю)$/u, "");
}

function normalizeStemmedName(value) {
  return normalizeName(value)
    .split(" ")
    .map(stemNameToken)
    .filter(Boolean)
    .join(" ");
}

function sourceVariantOf(item) {
  return item?._sourceVariant && typeof item._sourceVariant === "object" ? item._sourceVariant : {};
}

function sourceAttributesOf(item) {
  return asArray(sourceVariantOf(item).attributes);
}

function findSourceAttribute(item, id) {
  const key = String(id);
  return sourceAttributesOf(item).find((attr) => String(attr?.key ?? attr?.id ?? attr?.attribute_id) === key);
}

function sourceAttributeText(item, id) {
  return sourceAttributeValues(item, id).find(value => value.value)?.value || "";
}

function sourceAttributeValues(item, id) {
  return normalizeAttributeValues(collectedAttributeValues(findSourceAttribute(item, id)));
}

function rawAttributeValues(raw) {
  return collectedAttributeValues(raw);
}

function sourceAttributeDictionaryValueIds(item, id) {
  const attr = findSourceAttribute(item, id);
  return uniquePositiveNumbers(rawAttributeValues(attr).map((value) =>
    typeof value === "object" ? firstFilled(value.dictionary_value_id, value.dictionaryValueId) : 0
  ));
}

function bundleItemOf(item) {
  const direct = item?._bundleItem && typeof item._bundleItem === "object" ? item._bundleItem : null;
  const source = sourceVariantOf(item);
  const nested = source?._bundleItem && typeof source._bundleItem === "object" ? source._bundleItem : null;
  return direct || nested || {};
}

function deepestCategoryId(value) {
  const categories = asArray(value?.categories);
  let best = null;
  for (const category of categories) {
    const id = toPositiveNumber(firstFilled(
      category?.description_category_id,
      category?.descriptionCategoryId,
      category?.category_id,
      category?.categoryId,
      category?.id,
    ));
    if (!id) continue;
    const level = toPositiveNumber(category?.level);
    if (!best || level >= best.level) best = { id, level };
  }
  return best?.id || 0;
}

function categoryIdsOf(value) {
  return asArray(value?.categories)
    .map((category) => toPositiveNumber(firstFilled(
      category?.description_category_id,
      category?.descriptionCategoryId,
      category?.category_id,
      category?.categoryId,
      category?.id,
    )))
    .filter(Boolean);
}

function normalizeBarcode(value) {
  const barcode = cleanText(value);
  return barcode && !/^OZN/iu.test(barcode) ? barcode : undefined;
}

export function normalizeAttributeValues(rawValues, { preserveText = false } = {}) {
  const out = [];
  for (const raw of asArray(rawValues)) {
    if (raw == null) continue;
    const value = typeof raw === "object" ? firstFilled(raw.value, raw.name, raw.title) : raw;
    const text = preserveText && typeof value === "string" ? value : cleanText(value);
    const dictId = typeof raw === "object"
      ? toPositiveNumber(firstFilled(raw.dictionary_value_id, raw.dictionaryValueId))
      : 0;
    if (!text && !dictId) continue;
    const item = { value: text };
    if (dictId) item.dictionary_value_id = dictId;
    out.push(item);
  }
  return out;
}

function normalizeAttribute(raw, fallbackComplexId = 0) {
  if (!raw || typeof raw !== "object") return null;
  const id = toPositiveNumber(firstFilled(raw.id, raw.attribute_id, raw.attributeId, raw.key));
  if (!id) return null;
  const complexId = toPositiveNumber(firstFilled(raw.complex_id, raw.attribute_complex_id, raw.complexId, fallbackComplexId));
  const values = normalizeAttributeValues(collectedAttributeValues(raw), { preserveText: [9024, 10289].includes(id) });
  if (!values.length) return null;
  return {
    complex_id: complexId,
    id,
    values,
  };
}

function stripRichContentNode(value) {
  if (Array.isArray(value)) {
    const out = value
      .map(stripRichContentNode)
      .filter((item) => item !== undefined);
    return out.length ? out : undefined;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string") {
      const text = cleanText(value);
      return text || undefined;
    }
    return value === undefined || value === null ? undefined : value;
  }
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "version") continue;
    const normalized = stripRichContentNode(child);
    if (normalized === undefined) continue;
    if (normalized && typeof normalized === "object" && !Array.isArray(normalized) && !Object.keys(normalized).length) continue;
    out[key] = normalized;
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeRichContentWidget(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const widgetName = cleanText(raw.widgetName);
  const type = cleanText(raw.type);
  const blocks = asArray(raw.blocks)
    .map(stripRichContentNode)
    .filter((block) => block && typeof block === "object" && !Array.isArray(block) && Object.keys(block).length);
  if (!widgetName || !type || !blocks.length) return null;
  return { widgetName, type, blocks };
}

function exactRichKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function normalizeRichV03Text(value) {
  if (!exactRichKeys(value, ["content"]) || !Array.isArray(value.content)
    || value.content.length < 1 || value.content.length > 16) return null;
  const content = value.content.map((entry) => cleanText(entry, 8_192));
  return content.every(Boolean) ? { content } : null;
}

function normalizeRichV03Image(value) {
  if (!exactRichKeys(value, ["src", "srcMobile"])) return null;
  const src = cleanText(value.src, 8_192);
  const srcMobile = cleanText(value.srcMobile, 8_192);
  return src && srcMobile ? { src, srcMobile } : null;
}

function normalizeRichV03Widget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.widgetName === "raTextBlock") {
    const field = Object.hasOwn(value, "title") ? "title" : Object.hasOwn(value, "text") ? "text" : null;
    if (!field || !exactRichKeys(value, ["widgetName", field])) return null;
    const text = normalizeRichV03Text(value[field]);
    return text ? { widgetName: "raTextBlock", [field]: text } : null;
  }
  if (value.widgetName !== "raShowcase" || value.type !== "billboard"
    || !exactRichKeys(value, ["widgetName", "type", "blocks"])
    || !Array.isArray(value.blocks) || value.blocks.length < 1 || value.blocks.length > 3) return null;
  const blocks = value.blocks.map((block) => {
    const hasTitle = block && Object.hasOwn(block, "title");
    if (!exactRichKeys(block, hasTitle ? ["img", "title"] : ["img"])) return null;
    const img = normalizeRichV03Image(block.img);
    const title = hasTitle ? normalizeRichV03Text(block.title) : null;
    return img && (!hasTitle || title) ? { img, ...(hasTitle ? { title } : {}) } : null;
  });
  return blocks.every(Boolean) ? { widgetName: "raShowcase", type: "billboard", blocks } : null;
}

function normalizeRichContentV03(parsed) {
  if (!exactRichKeys(parsed, ["content", "version"]) || parsed.version !== 0.3
    || !Array.isArray(parsed.content) || parsed.content.length < 1 || parsed.content.length > 20) return null;
  const content = parsed.content.map(normalizeRichV03Widget);
  return content.every(Boolean) ? { content, version: 0.3 } : null;
}

function normalizeRichContentValue(value) {
  const text = cleanText(value, 0);
  if (!text) return "";
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  const v03 = normalizeRichContentV03(parsed);
  if (v03) return JSON.stringify(v03);
  // Collected Ozon content already carries its version and all widgets. Keep
  // that envelope intact; extracting the first widget produces invalid JSON.
  if (parsed.version === 0.3 && Array.isArray(parsed.content) && parsed.content.length
    && parsed.content.every(widget => widget && typeof widget.widgetName === "string")) {
    return JSON.stringify(parsed);
  }
  const widget = normalizeRichContentWidget(parsed);
  return widget ? JSON.stringify({ content: [widget], version: 0.3 }) : "";
}

export function flattenHashtagInput(value) {
  if (Array.isArray(value)) return value.flatMap(flattenHashtagInput);
  const text = cleanText(value);
  if (!text) return [];
  return text
    .replace(/#/g, " #")
    .split(/[\s,，;；、]+/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeHashtag(value) {
  const text = cleanText(value)
    .replace(/^#+/u, "")
    .replace(/[^\p{L}\p{N}_]+/gu, "");
  if (!text) return "";
  return `#${text.slice(0, MAX_HASHTAG_LENGTH - 1)}`;
}

function normalizeHashtags(value) {
  const seen = new Set();
  const out = [];
  for (const raw of flattenHashtagInput(value)) {
    const tag = normalizeHashtag(raw);
    if (!tag) continue;
    const key = tag.toLocaleLowerCase("ru-RU");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_HASHTAGS) break;
  }
  return out;
}

function normalizeUploadAttribute(raw, fallbackComplexId = 0) {
  const attr = normalizeAttribute(raw, fallbackComplexId);
  if (!attr) return null;
  if (attr.id === 7822) {
    const values = attr.values.filter(value => normalizeBarcode(value.value));
    return values.length ? { ...attr, values } : null;
  }
  if (attr.id === RICH_CONTENT_ATTRIBUTE_ID) {
    const richContent = normalizeRichContentValue(attr.values.map((value) => value?.value).find(Boolean));
    return richContent
      ? { complex_id: 0, id: RICH_CONTENT_ATTRIBUTE_ID, values: [{ value: richContent }] }
      : null;
  }
  if (isHashtagAttributeId(attr.id)) {
    const hashtags = normalizeHashtags(attr.values.map((value) => value?.value));
    return hashtags.length
      ? { complex_id: 0, id: attr.id, values: [{ value: hashtags.join(" ") }] }
      : null;
  }
  return attr;
}

function attributeKey(attr) {
  return `${Number(attr.complex_id) || 0}:${Number(attr.id) || 0}`;
}

function upsertAttribute(map, attr, { overwrite = false } = {}) {
  if (!attr || !attr.id || !asArray(attr.values).length) return;
  const key = attributeKey(attr);
  if (!overwrite && map.has(key)) return;
  map.set(key, attr);
}

function hasAllowedAttribute(allowedIds, id) {
  return !allowedIds || allowedIds.has(Number(id));
}

function normalizeImages(images) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(images)) {
    const url = cleanText(typeof raw === "object" ? raw.file_name || raw.url || raw.src : raw);
    if (!url) continue;
    const key = url.split("?")[0].split("#")[0].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url, primary: !!(raw && typeof raw === "object" && raw.default) });
  }
  out.sort((a, b) => Number(b.primary) - Number(a.primary));
  return out.map((item) => item.url);
}

function parseSourceNumber(value) {
  if (value == null || value === "") return 0;
  const text = String(value).replace(",", ".").trim();
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return 0;
  const number = Number(match[0]);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function sourceWeightGrams(item) {
  const packaged = parseSourceNumber(sourceAttributeText(item, 4497));
  if (packaged) return Math.round(packaged);
  const kgOrGram = parseSourceNumber(sourceAttributeText(item, 4383));
  if (!kgOrGram) return 0;
  return Math.round(kgOrGram < 100 ? kgOrGram * 1000 : kgOrGram);
}

function positiveInt(...values) {
  for (const value of values) {
    const number = parseSourceNumber(value);
    if (number > 0) return Math.round(number);
  }
  return 0;
}

function uniquePositiveNumbers(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const number = toPositiveNumber(value);
    if (!number || seen.has(number)) continue;
    seen.add(number);
    out.push(number);
  }
  return out;
}

function descriptionCategoryIdCandidatesOf(item) {
  const source = sourceVariantOf(item);
  const bundle = bundleItemOf(item);
  return uniquePositiveNumbers([
    item.description_category_id,
    item.descriptionCategoryId,
    bundle.description_category_id,
    bundle.descriptionCategoryId,
    deepestCategoryId(bundle),
    deepestCategoryId(source),
    source.description_category_id,
    source.descriptionCategoryId,
  ]);
}

function descriptionCategoryIdOf(item) {
  return descriptionCategoryIdCandidatesOf(item)[0] || 0;
}

function sourceTypeNameOf(item) {
  const source = sourceVariantOf(item);
  const bundle = bundleItemOf(item);
  return cleanText(firstFilled(
    item.type_name,
    item.typeName,
    source.type_name,
    source.typeName,
    bundle.type_name,
    bundle.typeName,
    sourceAttributeText(item, 8229),
  ));
}

function sourceCategoryPathOf(item) {
  const direct = item?.sourceCategory?.path;
  if (Array.isArray(direct)) {
    return direct.map((value) => cleanText(value)).filter(Boolean);
  }
  return [...asArray(sourceVariantOf(item).categories)]
    .sort((left, right) => toPositiveNumber(left?.level) - toPositiveNumber(right?.level))
    .map((category) => cleanText(firstFilled(category?.title, category?.name)))
    .filter((label, index, labels) => label && labels.indexOf(label) === index);
}

function sourceCategoryEvidenceOf(item) {
  const dictionaryCandidates = uniquePositiveNumbers([
    item?.sourceCategory?.typeIdCandidate,
    ...sourceAttributeDictionaryValueIds(item, 8229),
    ...bundleAttributeDictionaryValueIds(item, 8229),
  ]);
  return {
    descriptionCategoryId: toPositiveNumber(firstFilled(
      item?.sourceCategory?.descriptionCategoryId,
      sourceVariantOf(item).description_category_id,
      sourceVariantOf(item).descriptionCategoryId,
      descriptionCategoryIdOf(item),
    )),
    typeName: cleanText(firstFilled(item?.sourceCategory?.typeName, sourceTypeNameOf(item))),
    typeIdCandidate: dictionaryCandidates[0] || 0,
    path: sourceCategoryPathOf(item),
  };
}

function bundleAttributeDictionaryValueIds(item, id) {
  const key = String(id);
  const attrs = asArray(bundleItemOf(item).attributes).filter((attr) =>
    String(attr?.key ?? attr?.id ?? attr?.attribute_id) === key
  );
  return uniquePositiveNumbers(attrs.flatMap((attr) =>
    rawAttributeValues(attr).map((value) =>
      typeof value === "object" ? firstFilled(value.dictionary_value_id, value.dictionaryValueId) : 0
    )
  ));
}

function misplacedSearchTypeIdOf(item) {
  const source = sourceVariantOf(item);
  const bundle = bundleItemOf(item);
  const sourceDescriptionCategoryId = toPositiveNumber(firstFilled(
    source.description_category_id,
    source.descriptionCategoryId,
  ));
  if (!sourceDescriptionCategoryId) return 0;
  const categoryIds = new Set([
    ...categoryIdsOf(source),
    ...categoryIdsOf(bundle),
  ]);
  if (!categoryIds.size || categoryIds.has(sourceDescriptionCategoryId)) return 0;
  return sourceDescriptionCategoryId;
}

function typeIdCandidatesOf(item) {
  return uniquePositiveNumbers([
    directTypeIdOf(item),
    ...sourceAttributeDictionaryValueIds(item, 8229),
    ...bundleAttributeDictionaryValueIds(item, 8229),
    misplacedSearchTypeIdOf(item),
  ]);
}

function collectTypeCandidates(tree, targetDescriptionCategoryId) {
  const candidates = [];
  const visit = (node, activeDescriptionCategoryId = 0) => {
    if (!node || typeof node !== "object") return;
    const currentDescriptionCategoryId = toPositiveNumber(node.description_category_id) || activeDescriptionCategoryId;
    const typeId = toPositiveNumber(node.type_id);
    if (typeId && (!targetDescriptionCategoryId || currentDescriptionCategoryId === targetDescriptionCategoryId)) {
      candidates.push({
        typeId,
        typeName: cleanText(firstFilled(node.type_name, node.name, node.title, node.category_name)),
        descriptionCategoryId: currentDescriptionCategoryId,
      });
    }
    for (const child of asArray(node.children)) visit(child, currentDescriptionCategoryId);
  };
  for (const root of asArray(tree)) visit(root, 0);
  return candidates;
}

function findTypeCandidateById(tree, typeId) {
  const wantedTypeId = toPositiveNumber(typeId);
  if (!wantedTypeId) return null;
  return collectTypeCandidates(tree, 0).find((candidate) => candidate.typeId === wantedTypeId) || null;
}

function uniqueCandidatesByTypeId(candidates) {
  const seen = new Set();
  return asArray(candidates).filter((candidate) => {
    if (!candidate?.typeId || seen.has(candidate.typeId)) return false;
    seen.add(candidate.typeId);
    return true;
  });
}

function matchExactTypeCandidate(candidates, typeName) {
  const sourceName = cleanText(typeName);
  if (!sourceName) return { candidate: null, ambiguous: false, method: "" };
  const exact = uniqueCandidatesByTypeId(
    candidates.filter((candidate) => cleanText(candidate.typeName) === sourceName),
  );
  if (exact.length === 1) {
    return { candidate: exact[0], ambiguous: false, method: "TYPE_NAME_EXACT" };
  }
  if (exact.length > 1) return { candidate: null, ambiguous: true, method: "" };

  const wanted = normalizeName(sourceName);
  const normalized = uniqueCandidatesByTypeId(
    candidates.filter((candidate) => normalizeName(candidate.typeName) === wanted),
  );
  if (normalized.length === 1) {
    return { candidate: normalized[0], ambiguous: false, method: "TYPE_NAME_NORMALIZED" };
  }
  return { candidate: null, ambiguous: normalized.length > 1, method: "" };
}

function resolutionTime(ctx) {
  const value = typeof ctx.now === "function" ? ctx.now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function categoryResolutionBase(item, source, ctx) {
  return {
    offerId: cleanText(firstFilled(item.offer_id, item.offerId, item.scraped_sku, item.sku)),
    source,
    resolvedAt: resolutionTime(ctx),
  };
}

function matchedCategoryResolution(item, source, candidate, method, ctx) {
  return {
    ...categoryResolutionBase(item, source, ctx),
    status: "MATCHED",
    method,
    target: {
      storeId: cleanText(ctx.targetStoreId),
      descriptionCategoryId: candidate.descriptionCategoryId,
      typeId: candidate.typeId,
    },
  };
}

function pendingCategoryResolution(item, source, reason, ctx) {
  return {
    ...categoryResolutionBase(item, source, ctx),
    status: "PENDING",
    reason,
    targetStoreId: cleanText(ctx.targetStoreId),
  };
}

function pendingCategoryError(item, resolution) {
  const sku = cleanText(firstFilled(item.scraped_sku, item.sku, item.offer_id));
  const error = new Error(`${sku ? `SKU ${sku} ` : ""}目标店铺类目待匹配`);
  error.categoryResolution = resolution;
  return error;
}

async function resolveTargetStoreCategory(item, ctx) {
  const source = sourceCategoryEvidenceOf(item);
  const tree = typeof ctx.getCategoryTree === "function" ? await ctx.getCategoryTree() : [];
  const explicitTypeId = toPositiveNumber(firstFilled(item.type_id, item.typeId));
  if (explicitTypeId) {
    const candidate = findTypeCandidateById(tree, explicitTypeId);
    if (candidate) {
      return {
        candidate,
        resolution: matchedCategoryResolution(item, source, candidate, "DIRECT_TYPE_ID", ctx),
      };
    }
  }

  const dictionaryCandidates = uniquePositiveNumbers([
    source.typeIdCandidate,
    ...sourceAttributeDictionaryValueIds(item, 8229),
    ...bundleAttributeDictionaryValueIds(item, 8229),
  ]);
  for (const typeId of dictionaryCandidates) {
    const candidate = findTypeCandidateById(tree, typeId);
    if (candidate) {
      return {
        candidate,
        resolution: matchedCategoryResolution(item, source, candidate, "DICTIONARY_VALUE_ID", ctx),
      };
    }
  }

  if (!source.descriptionCategoryId || !source.typeName) {
    return {
      candidate: null,
      resolution: pendingCategoryResolution(item, source, "SOURCE_TYPE_MISSING", ctx),
    };
  }
  const matched = matchExactTypeCandidate(
    collectTypeCandidates(tree, source.descriptionCategoryId),
    source.typeName,
  );
  if (matched.candidate) {
    return {
      candidate: matched.candidate,
      resolution: matchedCategoryResolution(item, source, matched.candidate, matched.method, ctx),
    };
  }
  return {
    candidate: null,
    resolution: pendingCategoryResolution(
      item,
      source,
      matched.ambiguous ? "TARGET_TYPE_AMBIGUOUS" : "TARGET_TYPE_NOT_FOUND",
      ctx,
    ),
  };
}

function matchTypeCandidate(candidates, typeName) {
  const wanted = normalizeName(typeName);
  const wantedStemmed = normalizeStemmedName(typeName);
  if (!wanted) return candidates.length === 1 ? candidates[0] : null;
  let best = null;
  for (const candidate of candidates) {
    const candidateName = normalizeName(candidate.typeName);
    const candidateStemmed = normalizeStemmedName(candidate.typeName);
    if (!candidateName) continue;
    let score = 0;
    if (candidate.typeName === typeName) score = TYPE_MATCH_SCORE.EXACT;
    else if (candidateName === wanted) score = TYPE_MATCH_SCORE.NORMALIZED;
    else if (candidateStemmed && candidateStemmed === wantedStemmed) score = TYPE_MATCH_SCORE.STEM;
    else if (candidateName.includes(wanted) || wanted.includes(candidateName)) score = TYPE_MATCH_SCORE.PARTIAL;
    else if (candidateStemmed && wantedStemmed && (candidateStemmed.includes(wantedStemmed) || wantedStemmed.includes(candidateStemmed))) {
      score = TYPE_MATCH_SCORE.PARTIAL;
    }
    if (!best || score > best.score) best = score ? { ...candidate, score } : best;
  }
  return best;
}

function directTypeIdOf(item) {
  return toPositiveNumber(firstFilled(
    item.type_id,
    item.typeId,
    sourceVariantOf(item).type_id,
    sourceVariantOf(item).typeId,
    bundleItemOf(item).type_id,
    bundleItemOf(item).typeId,
  ));
}

async function resolveTypeId(item, descriptionCategoryId, ctx, tree) {
  const direct = directTypeIdOf(item);
  if (direct) return direct;
  if (!descriptionCategoryId || typeof ctx.getCategoryTree !== "function") return 0;
  const candidates = collectTypeCandidates(tree || await ctx.getCategoryTree(), descriptionCategoryId);
  const matched = matchTypeCandidate(candidates, sourceTypeNameOf(item));
  return matched?.typeId || 0;
}

async function categoryAttributeContext(descriptionCategoryId, typeId, ctx) {
  if (ctx.categoryMatchPolicy === "SOURCE_CATEGORY_STRICT") {
    return strictCategoryAttributeContext(
      { descriptionCategoryId, typeId },
      ctx.currentCategoryMetadata,
    );
  }
  if (!descriptionCategoryId || !typeId || typeof ctx.getCategoryAttributes !== "function") {
    return { allowedIds: null, metaById: new Map(), metaByKey: new Map() };
  }
  const attrs = await ctx.getCategoryAttributes(descriptionCategoryId, typeId);
  if (!asArray(attrs).length) return { allowedIds: null, metaById: new Map(), metaByKey: new Map() };
  const metaById = new Map();
  const metaByKey = new Map();
  const ids = [];
  for (const attr of attrs) {
    const id = toPositiveNumber(firstFilled(attr?.id, attr?.attribute_id, attr?.attributeId));
    if (!id) continue;
    const complexId = toPositiveNumber(firstFilled(
      attr?.complex_id, attr?.complexId, attr?.attribute_complex_id,
    ));
    ids.push(id);
    metaById.set(id, attr);
    if (ctx.categoryMatchPolicy === "SOURCE_CATEGORY_STRICT" && metaByKey.has(`${complexId}:${id}`)) {
      throw incompleteCategoryAttributesError();
    }
    metaByKey.set(`${complexId}:${id}`, attr);
  }
  return {
    allowedIds: ids.length ? new Set(ids) : null,
    metaById,
    metaByKey,
  };
}

function attributeDictionaryId(meta = {}) {
  return [
    meta.dictionary_id,
    meta.dictionaryId,
    meta.dictionary?.id,
    meta.dictionary?.dictionary_id,
    meta.dictionary?.dictionaryId,
  ].map(toPositiveNumber).find(Boolean) || 0;
}

function boolish(value) {
  if (value === true || value === 1) return true;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    return text === "true" || text === "1" || text === "yes";
  }
  return false;
}

function isRequiredAttribute(meta = {}) {
  return [
    meta.is_required,
    meta.required,
    meta.isRequired,
    meta.is_required_attribute,
    meta.isRequiredAttribute,
  ].some(boolish);
}

function attributeDisplayName(meta = {}, id = "") {
  return cleanText(firstFilled(
    meta.name,
    meta.attribute_name,
    meta.attributeName,
    meta.title,
    meta.description,
  )) || `Ozon 属性 ${id}`;
}

function isHashtagAttributeMeta(meta = {}, id = "") {
  if (isHashtagAttributeId(id)) return true;
  const label = normalizeName(attributeDisplayName(meta, id));
  return label.includes("хештег") ||
    label.includes("hashtag") ||
    label.includes("主题标签") ||
    label.includes("话题标签");
}

function findHashtagAttributeId(allowedIds, metaById = new Map()) {
  for (const [id, meta] of metaById.entries()) {
    if (hasAllowedAttribute(allowedIds, id) && isHashtagAttributeMeta(meta, id)) return Number(id);
  }
  for (const id of HASHTAGS_ATTRIBUTE_IDS) {
    if (hasAllowedAttribute(allowedIds, id)) return id;
  }
  return 0;
}

function compactErrorMessage(error) {
  return cleanText(error?.message || String(error) || "未知错误", 240);
}

const SAFE_CATEGORY_ERROR_CODES = new Set([
  "ZONGZI_CATEGORY_TREE_UNAVAILABLE",
  "ZONGZI_CATEGORY_ATTRIBUTES_UNAVAILABLE",
  "ZONGZI_CATEGORY_VALUES_UNAVAILABLE",
  "ZONGZI_CATEGORY_DATA_INVALID",
  "ZONGZI_CATEGORY_TYPE_NOT_FOUND",
  "AUTO_LISTING_SOURCE_CATEGORY_REQUIRED",
  "AUTO_LISTING_CATEGORY_ATTRIBUTES_INCOMPLETE",
  "AUTO_LISTING_CATEGORY_DICTIONARY_UNRESOLVED",
]);

function isSafeCategoryError(error) {
  return SAFE_CATEGORY_ERROR_CODES.has(String(error?.code || ""));
}

function unresolvedRequiredDictionaryError() {
  const error = new Error("必填字典属性未匹配到 Ozon 字典值，请检查后重试");
  error.status = 422;
  error.code = "ZONGZI_CATEGORY_DATA_INVALID";
  error.body = { operation: "REQUIRED_DICTIONARY_VALUE" };
  error.cause = null;
  return error;
}

function appendNormalizationWarning(ctx, warning) {
  const text = cleanText(warning, 500);
  if (!text || !Array.isArray(ctx?.warnings) || ctx.warnings.includes(text)) return;
  ctx.warnings.push(text);
}

function dictionaryAccessError(error) {
  return [error?.status, error?.statusCode, error?.diagnostic?.sourceStatus].some(status => [401, 403].includes(Number(status)))
    || error?.code === "ZONGZI_CATEGORY_STORE_FORBIDDEN";
}

function warnOptionalDictionaryValues(ctx, attr, meta, values, reason) {
  const label = cleanText(attributeDisplayName(meta, attr.id), 80);
  const text = values.map(value => cleanText(value?.value, 100)).filter(Boolean).join("、");
  appendNormalizationWarning(ctx, "SKU " + ctx.warningSku + "：可选属性「" + label + "」(" + attr.id + ") 的值「" + text + "」" + reason + "，未上传");
}

function matchDictionaryValue(options, value) {
  const wanted = cleanText(value);
  if (!wanted) return null;
  const wantedNormalized = normalizeName(wanted);
  const wantedNoBrand = isNoBrandValue(wanted);
  if (wantedNoBrand) {
    const canonicalNoBrand = asArray(options).find((option) => {
      const optionValue = cleanText(firstFilled(option?.value, option?.name, option?.title, option?.label));
      return normalizeName(optionValue) === normalizeName(OZON_NO_BRAND_VALUE);
    });
    if (canonicalNoBrand) return canonicalNoBrand;
  }
  for (const option of asArray(options)) {
    const optionValue = cleanText(firstFilled(option?.value, option?.name, option?.title, option?.label));
    if (!optionValue) continue;
    const optionNormalized = normalizeName(optionValue);
    if (optionNormalized === wantedNormalized) return option;
    if (wantedNoBrand && isNoBrandValue(optionValue)) return option;
  }
  return null;
}

async function resolveDictionaryAttributeValues(attributes, {
  descriptionCategoryId,
  typeId,
  metaById,
  ctx,
} = {}) {
  if (typeof ctx?.getCategoryAttributeValues !== "function") return attributes;
  const cache = ctx.dictionaryValueCache || new Map();
  const readCached = (key, read) => {
    if (!cache.has(key)) cache.set(key, Promise.resolve().then(read));
    return cache.get(key);
  };
  const optionId = option => toPositiveNumber(firstFilled(option?.id, option?.dictionary_value_id, option?.dictionaryValueId));
  const findOption = (options, id) => asArray(options).find(option => optionId(option) === id);
  const out = [];
  for (const attr of asArray(attributes)) {
    const meta = metaById?.get?.(Number(attr?.id)) || {};
    const dictionaryId = attributeDictionaryId(meta);
    const categoryDependent = boolish(meta.category_dependent ?? meta.categoryDependent);
    const trustSuppliedIds = ctx.trustSuppliedDictionaryIds === true;
    if (!dictionaryId || ((!categoryDependent || trustSuppliedIds) && !asArray(attr?.values).some((value) => !toPositiveNumber(value?.dictionary_value_id)))) {
      out.push(attr);
      continue;
    }
    const cacheKey = `${descriptionCategoryId}:${typeId}:${attr.id}`;
    const warnUnverifiedId = () => appendNormalizationWarning(ctx,
      `SKU ${ctx.warningSku}：属性「${attributeDisplayName(meta, attr.id)}」(${attr.id}) 的字典暂不可用，已保留原字典ID，未能核对目标类目，请在 Ozon 核对`);
    let options;
    try {
      options = await readCached(cacheKey, () => ctx.getCategoryAttributeValues(descriptionCategoryId, typeId, attr.id));
    } catch (error) {
      const required = isRequiredAttribute(meta);
      if (dictionaryAccessError(error) || (isSafeCategoryError(error)
        && (required || error.code !== "ZONGZI_CATEGORY_VALUES_UNAVAILABLE"))) throw error;
      const label = attributeDisplayName(meta, attr.id);
      if (required) {
        const warning = `获取必填字典属性「${label}」可选值失败：${compactErrorMessage(error)}`;
        if (!ctx.allowUnresolvedRequiredDictionaryValues) throw new Error(warning);
        appendNormalizationWarning(ctx, warning);
      } else {
        const known = attr.values.filter(value => toPositiveNumber(value.dictionary_value_id));
        if (known.length) out.push({ ...attr, values: known });
        if (categoryDependent && known.length && !trustSuppliedIds) warnUnverifiedId();
        const missing = attr.values.filter(value => !toPositiveNumber(value.dictionary_value_id));
        if (missing.length) warnOptionalDictionaryValues(ctx, attr, meta, missing, "因字典暂不可用未能匹配");
      }
      continue;
    }
    const targetOption = async id => {
      const firstPageMatch = findOption(options, id);
      if (firstPageMatch) return firstPageMatch;
      try {
        // A missing first-page entry is not proof of an invalid ID. The existing
        // category service follows the target dictionary cursor for this exact ID.
        const later = await readCached(cacheKey + ":id:" + id, () => ctx.getCategoryAttributeValues(descriptionCategoryId, typeId, attr.id, {
          matchCandidates: [{ id }],
        }));
        return findOption(later, id);
      } catch (error) {
        if (dictionaryAccessError(error)) throw error;
        // null means the lookup failed; undefined means it succeeded with no ID.
        return null;
      }
    };
    const required = isRequiredAttribute(meta);
    const nextValues = [];
    for (const value of attr.values) {
      const suppliedId = toPositiveNumber(value?.dictionary_value_id);
      if (suppliedId && trustSuppliedIds) { nextValues.push(value); continue; }
      const suppliedTarget = suppliedId && categoryDependent ? await targetOption(suppliedId) : undefined;
      if (suppliedId && (!categoryDependent || suppliedTarget || (!required && suppliedTarget === null))) {
        if (categoryDependent && suppliedTarget === null) warnUnverifiedId();
        nextValues.push(value);
        continue;
      }
      const unresolvedValue = { ...value };
      delete unresolvedValue.dictionary_value_id;
      let matched = matchDictionaryValue(options, value?.value);
      if (!matched) {
        const matchCandidates = attr.values
          .filter(candidate => candidate.value && (categoryDependent && !trustSuppliedIds || !toPositiveNumber(candidate.dictionary_value_id)) && !matchDictionaryValue(options, candidate.value))
          .map(candidate => ({ value: candidate.value }));
        const localizedKey = cacheKey + ":ZH_HANS:" + JSON.stringify(matchCandidates);
        try {
          const localized = await readCached(localizedKey, () => ctx.getCategoryAttributeValues(descriptionCategoryId, typeId, attr.id, {
            language: "ZH_HANS", matchCandidates,
          }));
          matched = matchDictionaryValue(localized, value.value);
        } catch (error) {
          if (dictionaryAccessError(error)) throw error;
          // Failed fallbacks use the existing unresolved-value rules below.
        }
      }
      if (!matched && String(value.value || '').length >= 2 && typeof ctx.searchCategoryAttributeValuesExact === "function") {
        const searchKey = cacheKey + ":search:" + value.value;
        try {
          const searched = await readCached(searchKey, () => ctx.searchCategoryAttributeValuesExact(descriptionCategoryId, typeId, attr.id, value.value));
          matched = matchDictionaryValue(searched, value.value);
        } catch (error) {
          if (dictionaryAccessError(error)) throw error;
        }
      }
      let matchedId = optionId(matched);
      const targetMatch = categoryDependent && matchedId ? await targetOption(matchedId) : null;
      if (categoryDependent && !targetMatch) matchedId = 0;
      const canonical = targetMatch || findOption(options, matchedId) || matched;
      nextValues.push(matchedId ? {
        value: cleanText(firstFilled(canonical?.value, canonical?.name, canonical?.title, canonical?.label, value?.value)),
        dictionary_value_id: matchedId,
      } : unresolvedValue);
    }
    const unresolvedValues = nextValues.filter((value) => !toPositiveNumber(value?.dictionary_value_id));
    if (unresolvedValues.length) {
      if (required) {
        const label = attributeDisplayName(meta, attr.id);
        const warning = `必填字典属性「${label}」未匹配到 Ozon 字典值：${unresolvedValues.map((value) => value?.value).filter(Boolean).join("、") || "空值"}`;
        if (!ctx.allowUnresolvedRequiredDictionaryValues) throw unresolvedRequiredDictionaryError();
        appendNormalizationWarning(ctx, warning);
        const resolvedValues = nextValues.filter((value) => toPositiveNumber(value?.dictionary_value_id));
        if (resolvedValues.length) out.push({ ...attr, values: resolvedValues });
        continue;
      }
      warnOptionalDictionaryValues(ctx, attr, meta, unresolvedValues,
        categoryDependent ? "未匹配到当前目标类目的有效字典值" : "未匹配到 Ozon 字典ID");
      const resolvedValues = nextValues.filter((value) => toPositiveNumber(value?.dictionary_value_id));
      if (!resolvedValues.length) continue;
      out.push({
        ...attr,
        values: resolvedValues,
      });
      continue;
    }
    out.push({
      ...attr,
      values: nextValues,
    });
  }
  return out;
}

function flattenedCategoryAttributes(attributes, complexAttributes) {
  return [
    ...asArray(attributes),
    ...asArray(complexAttributes).flatMap((group) => asArray(group?.attributes)),
  ];
}

function strictAttributeKey(attribute) {
  return `${toPositiveNumber(attribute?.complex_id)}:${toPositiveNumber(attribute?.id)}`;
}

function assertStrictRequiredAttributes(attributes, metaByKey) {
  const present = new Set(asArray(attributes)
    .filter((attribute) => asArray(attribute?.values).length)
    .map(strictAttributeKey));
  for (const [key, meta] of metaByKey.entries()) {
    if (isRequiredAttribute(meta) && !present.has(key)) throw incompleteCategoryAttributesError();
  }
}

function assertStrictDictionaryValues(attributes, { metaByKey } = {}) {
  for (const attribute of asArray(attributes)) {
    const meta = metaByKey?.get?.(strictAttributeKey(attribute)) || {};
    if (!attributeDictionaryId(meta)) continue;
    const allowed = new Set(asArray(meta.dictionaryValues).map((option) => option.id));
    if (!allowed.size || asArray(attribute?.values).some((value) =>
      !allowed.has(toPositiveNumber(value?.dictionary_value_id)))) {
      throw unresolvedCategoryDictionaryError();
    }
  }
}

function sourceContentValue(item, ...keys) {
  for (const carrier of [item, sourceVariantOf(item), bundleItemOf(item)]) {
    for (const key of keys) {
      if (Object.hasOwn(carrier, key) && carrier[key] !== undefined) return carrier[key];
    }
  }
}

function sourceMediaValue(item, field, ...aliases) {
  const keys = [field, ...aliases];
  if (sourceContentValue(item, "contentDiagnostics")?.[field]?.source === "manual") {
    return sourceContentValue(item, ...keys);
  }
  // Historical drafts generated empty defaults before Seller enrichment arrived.
  // Only an explicit manual edit may use an empty value to erase saved media.
  return firstFilled(...[item, sourceVariantOf(item), bundleItemOf(item)]
    .flatMap(carrier => keys.map(key => carrier[key])));
}

function normalizeColorImageUrl(value) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!/^https?:[/][/]/iu.test(text) || /\s/u.test(text)) return undefined;
  try {
    const url = new URL(text);
    return ["http:", "https:"].includes(url.protocol) && url.hostname ? text : undefined;
  } catch { return undefined; }
}

function isVideoCoverUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && /\.(?:mp4|mov)$/iu.test(url.pathname);
  } catch { return false; }
}

function sourceComplexAttributes(item, allowedIds) {
  const source = sourceVariantOf(item);
  const bundle = bundleItemOf(item);
  const provided = [item.complex_attributes, source.complex_attributes, bundle.complex_attributes]
    .find(value => Array.isArray(value) && value.length) || [];
  const canonical = provided.map(group => ({
    attributes: asArray(group?.attributes)
      .map(raw => normalizeUploadAttribute(raw, group.complex_id))
      .filter(attr => attr && hasAllowedAttribute(allowedIds, attr.id)),
  })).filter(group => group.attributes.length);
  const groups = new Map();
  const all = [
    ...asArray(item.bundleComplexAttrs),
    ...asArray(source._bundleComplexAttrs),
    ...asArray(item.attributes),
    ...asArray(source.attributes),
    ...asArray(bundle.attributes),
  ];
  for (const raw of all) {
    const attr = normalizeUploadAttribute(raw);
    if (!attr || !hasAllowedAttribute(allowedIds, attr.id)) continue;
    const complexId = Number(attr.complex_id) || 0;
    if (!complexId) continue;
    if (!groups.has(complexId)) groups.set(complexId, []);
    groups.get(complexId).push(attr);
  }
  const seen = new Set();
  const complexGroups = [...canonical, ...[...groups.values()].map(attributes => ({ attributes }))]
    .filter(group => {
      const key = JSON.stringify(group);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const explicitVideos = sourceMediaValue(item, "videos", "videoUrl", "video_url");
  if (explicitVideos !== undefined && (!explicitVideos || (Array.isArray(explicitVideos) && !explicitVideos.length))) {
    for (const group of complexGroups) {
      group.attributes = group.attributes.filter(attr => ![21841, 21837].includes(attr.id));
    }
  }
  // Ozon /v3/product/import: ordered URL/name values in video group 100001.
  // A collected JPG coverUrl is a poster, not the MP4 video-cover attribute 21845.
  if (hasAllowedAttribute(allowedIds, 21841) && hasAllowedAttribute(allowedIds, 21837)) {
    const rawVideos = Array.isArray(explicitVideos) ? explicitVideos : [{ url: explicitVideos }];
    const videoGroup = complexGroups.find(group => group.attributes.some(attr => attr.id === 21841 && attr.complex_id === 100001));
    const videoUrls = [...(videoGroup?.attributes.find(attr => attr.id === 21841)?.values || [])];
    const existingUrls = new Set(complexGroups.flatMap(group => group.attributes)
      .filter(attr => attr.id === 21841).flatMap(attr => attr.values.map(value => value.value)));
    const added = [];
    for (const raw of rawVideos) {
      const url = cleanText(typeof raw === "string" ? raw : raw?.url, 2000);
      if (!/^https?:[/][/]/iu.test(url) || existingUrls.has(url)) continue;
      if (existingUrls.size >= 5) throw videoCountLimitError();
      existingUrls.add(url);
      added.push({ url, name: cleanText(raw?.name || raw?.title, 200) || "Видео " + existingUrls.size });
    }
    if (added.length) {
      const group = videoGroup || { attributes: [] };
      for (const [id, values] of [
        [21841, added.map(video => ({ value: video.url }))],
        [21837, added.map(video => ({ value: video.name }))],
      ]) {
        const attribute = group.attributes.find(attr => attr.id === id);
        if (attribute) attribute.values.push(...values);
        else group.attributes.push({ complex_id: 100001, id, values: id === 21837
          ? [...videoUrls.map((_, index) => ({ value: "Видео " + (index + 1) })), ...values] : values });
      }
      if (!videoGroup) complexGroups.push(group);
    }
  }
  const explicitCover = sourceMediaValue(item, "videoCoverUrl");
  // Existing structured Seller fields retain their meaning; an explicit edit overrides them.
  for (const group of complexGroups) {
    group.attributes = group.attributes.filter(attr => attr.id !== 21845 || explicitCover === undefined);
    for (const attr of group.attributes) {
      if (attr.id === 21845) attr.values = attr.values.filter(value => isVideoCoverUrl(value.value));
    }
    group.attributes = group.attributes.filter(attr => attr.values.length);
  }
  if (isVideoCoverUrl(explicitCover) && hasAllowedAttribute(allowedIds, 21845)) {
    complexGroups.push({ attributes: [{ complex_id: 100002, id: 21845, values: [{ value: explicitCover.trim() }] }] });
  }
  return complexGroups.filter(group => group.attributes.length);
}

function normalizeDescriptionHtml(value) {
  const source = String(value ?? "");
  // Plain-text line breaks and HTML block boundaries carry meaning. Removing
  // tags before adding separators used to join headings, table cells and lists.
  const html = /<[a-z][^>]*>/iu.test(source) ? source : source.replace(/\r\n|[\r\n]/gu, "<br/>");
  return cleanText(html
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, "")
    .replace(/<[^>]*>/gu, tag => {
      const match = /^<\s*(\/?)\s*([a-z][a-z0-9]*)(?:\s|\/?>)/iu.exec(tag);
      if (!match) return "";
      const [, closing, name] = match, lower = name.toLowerCase();
      if (lower === "br") return closing ? "" : "<br/>";
      if (lower === "ol") return `<${closing}ul>`;
      if (["p", "ul", "li"].includes(lower)) return `<${closing}${lower}>`;
      if (["td", "th"].includes(lower)) return " ";
      if (/^(?:h[1-6]|div|section|article|header|footer|table|thead|tbody|tfoot|tr|dl|dt|dd|blockquote|pre|hr)$/u.test(lower)) return "<br/>";
      return "";
    }), 4096)
    .replace(/(?:<br\/>\s*){3,}/gu, "<br/><br/>")
    .replace(/^(?:<br\/>\s*)+|(?:\s*<br\/>)+$/gu, "").trim();
}

function buildAttributes(item, allowedIds, metaById = new Map(), { sourceEvidenceAuthoritative = false } = {}) {
  const attrs = new Map();
  // Remember structured evidence before normalization removes empty attributes.
  // Current values (including []) must not be revived from a historical bundle.
  const structuredIds = rows => new Set(asArray(rows)
    .filter(raw => Array.isArray(raw?.values) && !toPositiveNumber(firstFilled(raw.complex_id, raw.attribute_complex_id, raw.complexId)))
    .map(raw => toPositiveNumber(firstFilled(raw.id, raw.attribute_id, raw.attributeId, raw.key))));
  const itemStructuredIds = structuredIds(item.attributes);
  const sourceStructuredIds = structuredIds(sourceAttributesOf(item));

  for (const raw of asArray(item.attributes)) {
    const attr = normalizeUploadAttribute(raw);
    if (attr && !attr.complex_id && hasAllowedAttribute(allowedIds, attr.id)
      && !(sourceEvidenceAuthoritative && sourceStructuredIds.has(attr.id))) upsertAttribute(attrs, attr, { overwrite: true });
  }

  for (const raw of asArray(bundleItemOf(item).attributes)) {
    if (toPositiveNumber(raw?.complex_id)) continue;
    const attr = normalizeUploadAttribute(raw);
    if (attr && !attr.complex_id && hasAllowedAttribute(allowedIds, attr.id)
      && !itemStructuredIds.has(attr.id) && !sourceStructuredIds.has(attr.id)) upsertAttribute(attrs, attr);
  }

  for (const raw of sourceAttributesOf(item)) {
    const attr = normalizeUploadAttribute(raw);
    if (attr && !attr.complex_id && hasAllowedAttribute(allowedIds, attr.id)
      && (!itemStructuredIds.has(attr.id) || sourceEvidenceAuthoritative)) {
      upsertAttribute(attrs, attr, { overwrite: sourceEvidenceAuthoritative });
    }
  }

  const source = sourceVariantOf(item);
  const bundle = bundleItemOf(item);
  const descriptionSource = sourceContentValue(item, "contentDiagnostics")?.description?.source;
  const manualDescription = descriptionSource === "manual"
    ? item.scraped_description ?? sourceContentValue(item, "description") : undefined;
  const savedDescriptions = asArray(attrs.get("0:4191")?.values).map(value => value.value);
  if (manualDescription !== undefined) attrs.delete("0:4191");
  const descriptionCandidates = [
    item.descriptionHTML, source.descriptionHTML, bundle.descriptionHTML,
    ...(descriptionSource === "json_ld" ? savedDescriptions : []),
    item.scraped_description, item.description, source.description, bundle.description,
    ...asArray(attrs.get("0:4191")?.values).map(value => value.value),
  ].map(normalizeDescriptionHtml);
  // JSON-LD may flatten an image-based product page into joined machine text.
  // Prefer intact same-SKU prose; retain unusable source text for editing, but
  // do not publish it as annotation or reject the rest of the collected product.
  // Ozon documents words over 27 characters as a description moderation error:
  // https://global-help.ozon.com/products/upload/moderation/errors-with-pdps
  const description = manualDescription !== undefined ? normalizeDescriptionHtml(manualDescription)
    : preferOzonRussianText(...descriptionCandidates.filter(value => descriptionSource !== "json_ld"
      || hasChineseProductText(descriptionEntities.decode(value))
      || !/[\p{L}\p{M}]{28,}/u.test(descriptionEntities.decode(value.replace(/<[^>]*>/gu, " ")))));
  if (descriptionSource === "json_ld" && !description) attrs.delete("0:4191");
  if (description && hasAllowedAttribute(allowedIds, 4191)) {
    upsertAttribute(attrs, { complex_id: 0, id: 4191, values: [{ value: description }] }, { overwrite: true });
  }

  const explicitRichContent = sourceMediaValue(item, "richContent", "rich_content");
  const richContentCleared = explicitRichContent !== undefined && !cleanText(explicitRichContent);
  if (richContentCleared) attrs.delete(`0:${RICH_CONTENT_ATTRIBUTE_ID}`);
  const richContent = richContentCleared ? "" : preferOzonRussianText(...[
    item.richContent, item.rich_content, source.richContent, source.rich_content,
    bundle.richContent, bundle.rich_content,
    ...asArray(attrs.get(`0:${RICH_CONTENT_ATTRIBUTE_ID}`)?.values).map(value => value.value),
  ].map(normalizeRichContentValue));
  if (richContent && hasAllowedAttribute(allowedIds, RICH_CONTENT_ATTRIBUTE_ID)) {
    upsertAttribute(attrs, { complex_id: 0, id: RICH_CONTENT_ATTRIBUTE_ID, values: [{ value: richContent }] }, { overwrite: true });
  }

  const modelName = cleanText(firstFilled(item.scraped_model_name, item.model_name, item.offer_id, item.scraped_sku));
  if (modelName && hasAllowedAttribute(allowedIds, 9048)) {
    upsertAttribute(attrs, { complex_id: 0, id: 9048, values: [{ value: modelName }] }, { overwrite: true });
  }

  const hashtags = normalizeHashtags(item._aiHashtags);
  const hashtagAttributeId = findHashtagAttributeId(allowedIds, metaById);
  if (hashtags.length && hashtagAttributeId) {
    upsertAttribute(
      attrs,
      { complex_id: 0, id: hashtagAttributeId, values: [{ value: hashtags.join(" ") }] },
      { overwrite: true },
    );
  }

  const barcodeValues = sourceAttributeValues(item, 7822).filter(value => normalizeBarcode(value.value));
  if (barcodeValues.length && hasAllowedAttribute(allowedIds, 7822)) {
    upsertAttribute(attrs, { complex_id: 0, id: 7822, values: barcodeValues }, { overwrite: true });
  }

  if (hasAllowedAttribute(allowedIds, MANUFACTURING_COUNTRY_ATTRIBUTE_ID)) {
    upsertAttribute(attrs, defaultOzonManufacturingCountryAttribute(), { overwrite: true });
  }

  return [...attrs.values()];
}

function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined).filter((item) => item !== undefined);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined || child === null || child === "") continue;
    const normalized = stripUndefined(child);
    if (Array.isArray(normalized) && normalized.length === 0) continue;
    out[key] = normalized;
  }
  return out;
}

export async function normalizeOzonImportCategory(item, ctx = {}) {
  const descriptionCategoryCandidates = descriptionCategoryIdCandidatesOf(item);
  let descriptionCategoryId = descriptionCategoryIdOf(item);
  const explicitDescriptionCategoryId = toPositiveNumber(firstFilled(
    item.description_category_id,
    item.descriptionCategoryId,
  ));
  const explicitTypeId = toPositiveNumber(firstFilled(
    item.type_id,
    item.typeId,
  ));
  let typeId = explicitDescriptionCategoryId && explicitTypeId ? explicitTypeId : 0;
  let categoryResolution = null;
  if (ctx.categoryMatchPolicy === "SOURCE_CATEGORY_STRICT") {
    const sourceCategory = strictSourceCategoryOf(ctx.sourceCategory);
    const sourceDescriptionCategoryId = sourceCategory.descriptionCategoryId;
    const sourceTypeId = sourceCategory.typeId;
    if (explicitDescriptionCategoryId !== sourceDescriptionCategoryId || explicitTypeId !== sourceTypeId) {
      throw sourceCategoryRequiredError();
    }
    descriptionCategoryId = sourceDescriptionCategoryId;
    typeId = sourceTypeId;
  } else if (ctx.categoryMatchPolicy === "TARGET_STORE_EXACT") {
    const resolved = await resolveTargetStoreCategory(item, ctx);
    categoryResolution = resolved.resolution;
    if (!resolved.candidate) throw pendingCategoryError(item, categoryResolution);
    descriptionCategoryId = resolved.candidate.descriptionCategoryId;
    typeId = resolved.candidate.typeId;
  } else if (!typeId && typeof ctx.getCategoryTree === "function") {
    const tree = await ctx.getCategoryTree();
    for (const candidateTypeId of typeIdCandidatesOf(item)) {
      const matched = findTypeCandidateById(tree, candidateTypeId);
      if (!matched?.typeId) continue;
      descriptionCategoryId = matched.descriptionCategoryId || descriptionCategoryId;
      typeId = matched.typeId;
      break;
    }
    if (!typeId) {
      const candidatesToTry = descriptionCategoryCandidates.length ? descriptionCategoryCandidates : [0];
      for (const candidateDescriptionCategoryId of candidatesToTry) {
        const candidates = collectTypeCandidates(tree, candidateDescriptionCategoryId);
        const matched = matchTypeCandidate(candidates, sourceTypeNameOf(item));
        if (!matched?.typeId) continue;
        descriptionCategoryId = matched.descriptionCategoryId || candidateDescriptionCategoryId;
        typeId = matched.typeId;
        break;
      }
    }
  } else {
    typeId = await resolveTypeId(item, descriptionCategoryId, ctx);
  }
  if (!descriptionCategoryId || !typeId) {
    const sku = cleanText(firstFilled(item.scraped_sku, item.sku, item.offer_id));
    const detail = !descriptionCategoryId
      ? "缺少 description_category_id"
      : `无法根据类型「${sourceTypeNameOf(item) || "未知"}」解析 type_id`;
    throw new Error(`${sku ? `SKU ${sku} ` : ""}${detail}`);
  }

  return { descriptionCategoryId, typeId, categoryResolution };
}

// A content check describes availability separately from the existing listing gates.
// Historical rows without capture diagnostics remain readable; no re-cleaning at read time.
function warnContentAvailability(item, normalized, { allowedIds }, ctx) {
  const diagnostics = sourceContentValue(item, "contentDiagnostics");
  const savedAttributes = flattenedCategoryAttributes(normalized.attributes, normalized.complex_attributes);
  const uploadedKeys = new Set(savedAttributes.filter(attr => attr.values?.length).map(strictAttributeKey));
  const sourceAttributes = [item, sourceVariantOf(item), bundleItemOf(item)].flatMap(carrier => [
    ...asArray(carrier.attributes), ...asArray(carrier.complex_attributes).flatMap(group => asArray(group.attributes)),
    ...asArray(carrier.bundleComplexAttrs), ...asArray(carrier._bundleComplexAttrs),
  ]);
  const suppliedAttribute = id => sourceAttributes.some(raw => {
    const attr = normalizeAttribute(raw);
    return attr?.id === id && attr.values.length;
  });
  const suppliedContent = (id, ...fields) => {
    const value = sourceMediaValue(item, ...fields);
    return value !== undefined ? (Array.isArray(value) ? value.length > 0 : !!cleanText(value)) : suppliedAttribute(id);
  };
  const manualDescription = diagnostics?.description?.source === "manual"
    ? item.scraped_description ?? sourceContentValue(item, "description") : undefined;
  const explicitVideos = sourceMediaValue(item, "videos", "videoUrl", "video_url");
  const sourceVideoUrls = new Set((explicitVideos !== undefined
    ? (Array.isArray(explicitVideos) ? explicitVideos : [explicitVideos])
      .map(video => cleanText(typeof video === "string" ? video : video?.url))
    : sourceAttributes.map(raw => normalizeAttribute(raw)).filter(attr => attr?.id === 21841)
      .flatMap(attr => attr.values.map(value => value.value))).filter(Boolean));
  const uploadedVideoUrls = new Set(savedAttributes.filter(attr => attr.id === 21841 && attr.complex_id === 100001)
    .flatMap(attr => attr.values.map(value => value.value)));
  const warn = message => ctx.warnings.push(`SKU ${ctx.warningSku || normalized.offer_id} ${message}`);
  for (const [field, label, id, complexId, supplied] of [
    ["description", "简介", 4191, 0, manualDescription !== undefined ? !!cleanText(manualDescription)
      : item.scraped_description || item.descriptionHTML || sourceContentValue(item, "description") || suppliedAttribute(4191)],
    ["richContent", "富内容", 11254, 0, suppliedContent(11254, "richContent", "rich_content")],
    ["videos", "普通视频", 21841, 100001, suppliedContent(21841, "videos", "videoUrl", "video_url")],
    ["color_image", "颜色样本", 0, 0, sourceMediaValue(item, "color_image")],
    ["videoCoverUrl", "封面视频", 21845, 100002, suppliedContent(21845, "videoCoverUrl")],
  ]) {
    const uploaded = id ? uploadedKeys.has(`${complexId}:${id}`) : !!normalized.color_image;
    const evidence = diagnostics?.[field];
    if (uploaded) {
      const original = sourceContentValue(item, field, ...(
        field === "richContent" ? ["rich_content"] : field === "videos" ? ["videoUrl", "video_url"] : []));
      if (field !== "description" && original !== undefined && !firstFilled(original) && evidence?.source !== "manual") {
        warn(`${label}历史空值用途待核实，本次保留同 SKU 已保存内容`);
      }
      if (field === "videos") {
        const omitted = [...sourceVideoUrls].filter(url => !uploadedVideoUrls.has(url));
        if (omitted.length) warn(`普通视频有 ${omitted.length} 条已保存链接未进入本次请求，请核对字段格式或类目限制`);
      }
      continue;
    }
    if (supplied) {
      if (id && allowedIds && !allowedIds.has(id)) warn(`${label}已保存，当前类目不支持，未提交`);
      else if (field === "description" && evidence?.source === "json_ld") warn('简介机器摘要中含超过 27 个字母的连续词，原文已保留，未作为简介提交；可修订补充');
      else if (field === "videoCoverUrl") warn('封面视频需有效 MP4 / MOV 视频链接，当前值未提交');
      else if (field === "color_image") warn('颜色样本需有效 HTTP(S) 图片链接，当前值未提交');
      else warn(`${label}已保存，但未进入本次请求，请核对字段格式`);
      continue;
    }
    if (!diagnostics || (id && allowedIds && !allowedIds.has(id))) continue;
    const status = evidence?.status;
    if (evidence?.source === 'manual') warn(`${label}已手动清空，未提交`);
    else if (status === 'read_failed') warn(`${label}读取失败：${cleanText(evidence.message, 300) || '来源读取未完成，请重试或编辑'}`);
    else if (status === 'not_provided') warn(`${label}源未提供（可编辑补充）`);
    else if (status === 'unverified') warn(`${label}待核实，当前来源未能确认用途或 SKU`);
    else if (status === 'provided') warn(`${label}采集时已提供，当前草稿未填写，未提交`);
    else warn(`${label}未记录来源状态，待核实`);
  }
  for (const issue of asArray(diagnostics?.issues)) {
    if (issue?.message) warn(`资料读取记录：${cleanText(issue.message, 300)}`);
  }
  const explicitCover = sourceMediaValue(item, "videoCoverUrl");
  const rawCoverAttrs = sourceAttributes.filter(attr => Number(attr.id || attr.key || attr.attribute_id) === 21845);
  if (explicitCover === undefined && rawCoverAttrs.some(attr => asArray(attr.values).some(value => !isVideoCoverUrl(value.value)))) {
    warn('封面视频需有效 MP4 / MOV 视频链接，静态预览图未提交');
  }
  if (uploadedKeys.has('100002:21845')) warn('封面视频已写入请求；时长尚未核实，请确认符合 8–30 秒要求');
  // Category metadata describes allowed fields, not captured source values.
  // Ordinary dictionary losses already have value-specific warnings above;
  // logistics, gallery and type also have dedicated import destinations.
}

async function normalizeOneImportItem(item, ctx) {
  const { descriptionCategoryId, typeId, categoryResolution } = await normalizeOzonImportCategory(item, ctx);
  const { allowedIds, metaById, metaByKey } = await categoryAttributeContext(descriptionCategoryId, typeId, ctx);
  const images = normalizeImages(item.images);
  const source = sourceVariantOf(item);
  const bundle = bundleItemOf(item);
  const barcode = [item.barcode, bundle.barcode, sourceAttributeText(item, 7822)]
    .map(normalizeBarcode).find(Boolean);

  const { weight, depth, width, height } = normalizeOzonImportLogistics(item);

  const builtAttributes = buildAttributes(item, allowedIds, metaById, {
    sourceEvidenceAuthoritative: ctx.categoryMatchPolicy === "SOURCE_CATEGORY_STRICT",
  });
  const complexAttributes = sourceComplexAttributes(item, allowedIds);
  const attributes = ctx.categoryMatchPolicy === "SOURCE_CATEGORY_STRICT"
    ? builtAttributes
    : await resolveDictionaryAttributeValues(builtAttributes, {
        descriptionCategoryId,
        typeId,
        metaById,
        ctx,
      });
  if (ctx.categoryMatchPolicy === "SOURCE_CATEGORY_STRICT") {
    if (!allowedIds || !metaByKey.size) throw incompleteCategoryAttributesError();
    const allAttributes = flattenedCategoryAttributes(attributes, complexAttributes);
    assertStrictRequiredAttributes(allAttributes, metaByKey);
    assertStrictDictionaryValues(allAttributes, { metaByKey });
  }

  // IDs are language-independent. Do not forward legacy Chinese dictionary labels.
  // Free text has no equivalent ID and must be corrected instead of being dropped.
  for (const attribute of flattenedCategoryAttributes(attributes, complexAttributes)) {
    if ([9024, 10289].includes(attribute.id)) continue;
    for (const value of asArray(attribute.values)) {
      if (toPositiveNumber(value.dictionary_value_id) && hasChineseProductText(value.value)) delete value.value;
    }
  }
  const name = preferOzonRussianText(item.name, item.title,
    ...asArray(attributes.find(attribute => attribute.id === 4180)?.values).map(value => value.value));
  const normalized = {
    offer_id: [item.offer_id, item.offerId].find(value => typeof value === "string" && value.trim())
      ?? cleanText(`jz-${item.scraped_sku || Date.now()}`),
    name: cleanText(name || item.scraped_sku, 200),
    price: cleanText(item.price),
    old_price: cleanText(item.old_price || item.oldPrice),
    min_price: parseSourceNumber(item.min_price || item.minPrice) > 0 ? cleanText(item.min_price || item.minPrice) : undefined,
    vat: cleanText(item.vat || "0"),
    currency_code: cleanText(item.currency_code || item.currencyCode || "RUB"),
    description_category_id: descriptionCategoryId,
    type_id: typeId,
    barcode,
    primary_image: images[0],
    color_image: normalizeColorImageUrl(sourceMediaValue(item, "color_image")),
    images,
    weight,
    weight_unit: "g",
    depth,
    width,
    height,
    dimension_unit: "mm",
    attributes,
    complex_attributes: complexAttributes,
  };

  assertOzonRussianProductText(normalized, { sku: item.scraped_sku || normalized.offer_id });
  warnContentAvailability(item, normalized, { allowedIds, metaByKey }, ctx);
  return { item: stripUndefined(normalized), categoryResolution };
}

export async function normalizeOzonImportItems(items, ctx = {}) {
  const normalizedItems = [];
  const warnings = [];
  const categoryResolutions = [];
  const itemWarnings = [];
  // One submission can contain many SKUs in the same category. Share successful
  // and failed reads only within this call, never across account/store requests.
  const normalizationContext = { ...ctx, warnings, dictionaryValueCache: new Map() };
  for (const item of asArray(items)) {
    try {
      const warningStart = warnings.length;
      const normalized = await normalizeOneImportItem(item, { ...normalizationContext,
        warningSku: cleanText(firstFilled(item.scraped_sku, item.sku, item.offer_id), 100) });
      normalizedItems.push(normalized.item);
      if (warnings.length > warningStart) itemWarnings.push({ offerId: normalized.item.offer_id, warnings: warnings.slice(warningStart) });
      if (normalized.categoryResolution) categoryResolutions.push(normalized.categoryResolution);
    } catch (error) {
      if (error?.categoryResolution) categoryResolutions.push(error.categoryResolution);
      if (ctx.strictTypeMatch || isSafeCategoryError(error)
        || ["ZONGZI_IMPORT_LOGISTICS_REQUIRED", "ZONGZI_VIDEO_COUNT_LIMIT"].includes(error.code)) throw error;
      warnings.push(error?.message || String(error));
    }
  }
  return { items: normalizedItems, warnings, categoryResolutions, ...(itemWarnings.length ? { itemWarnings } : {}) };
}

// One rule for both incoming AI sources and direct imports. Missing physical
// facts are never replaced with invented shipping dimensions.
export function normalizeOzonImportLogistics(item = {}) {
  const bundle = bundleItemOf(item);
  const values = {
    weight: positiveInt(item.weight, sourceWeightGrams(item), item.scraped_weight, bundle.weight),
    depth: positiveInt(item.depth, sourceAttributeText(item, 9454), item.scraped_depth, bundle.depth),
    width: positiveInt(item.width, sourceAttributeText(item, 9455), item.scraped_width, bundle.width),
    height: positiveInt(item.height, sourceAttributeText(item, 9456), item.scraped_height, bundle.height),
  };
  const missing = Object.keys(values).filter(key => !Number.isSafeInteger(values[key]) || values[key] <= 0);
  if (missing.length) throw Object.assign(new Error(`SKU ${item.scraped_sku || item.offer_id || ""} 缺少真实包装参数：${missing.join("、")}`),
    { code: "ZONGZI_IMPORT_LOGISTICS_REQUIRED", statusCode: 422, status: 422, missing });
  return values;
}

export const testExports = {
  normalizeImages,
  collectTypeCandidates,
  matchTypeCandidate,
  buildAttributes,
  normalizeHashtags,
  normalizeRichContentValue,
  findHashtagAttributeId,
  isSafeCategoryError,
  unresolvedRequiredDictionaryError,
};
