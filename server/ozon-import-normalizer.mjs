import { types } from "node:util";

const TYPE_MATCH_SCORE = {
  EXACT: 3,
  NORMALIZED: 2,
  STEM: 1.5,
  PARTIAL: 1,
};
const OZON_NO_BRAND_VALUE = "Нет бренда";
const RICH_CONTENT_ATTRIBUTE_ID = 11254;
const HASHTAGS_ATTRIBUTE_ID = 23171;
const LEGACY_HASHTAGS_ATTRIBUTE_ID = 22508;
const HASHTAGS_ATTRIBUTE_IDS = new Set([HASHTAGS_ATTRIBUTE_ID, LEGACY_HASHTAGS_ATTRIBUTE_ID]);
const MAX_HASHTAGS = 30;
const MAX_HASHTAG_LENGTH = 30;

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

function strictPositiveId(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : 0;
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) return 0;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : 0;
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
  const attr = findSourceAttribute(item, id);
  if (!attr) return "";
  if (attr.value != null && String(attr.value).trim()) return cleanText(attr.value);
  const first = asArray(attr.collection).find((value) => value != null && String(value).trim());
  return first == null ? "" : cleanText(typeof first === "object" ? first.value : first);
}

function sourceAttributeValues(item, id) {
  const attr = findSourceAttribute(item, id);
  if (!attr) return [];
  const raw = attr.value != null ? [attr] : asArray(attr.collection);
  return raw.length ? normalizeAttributeValues(raw) : [];
}

function rawAttributeValues(raw) {
  if (!raw || typeof raw !== "object") return [];
  if (asArray(raw.values).length) return raw.values;
  if (raw.value != null) return [raw];
  return asArray(raw.collection);
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

function normalizeAttributeValues(rawValues) {
  const out = [];
  for (const raw of asArray(rawValues)) {
    if (raw == null) continue;
    const value = typeof raw === "object" ? firstFilled(raw.value, raw.name, raw.title) : raw;
    const text = cleanText(value);
    if (!text) continue;
    const item = { value: text };
    const dictId = typeof raw === "object"
      ? toPositiveNumber(firstFilled(raw.dictionary_value_id, raw.dictionaryValueId))
      : 0;
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
  const values = normalizeAttributeValues(
    asArray(raw.values).length
      ? raw.values
      : raw.value != null
        ? [raw]
        : asArray(raw.collection),
  );
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
  const widget = normalizeRichContentWidget(parsed) ||
    asArray(parsed.content).map(normalizeRichContentWidget).find(Boolean);
  return widget ? JSON.stringify(widget) : "";
}

function flattenHashtagInput(value) {
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
  if (attr.id === RICH_CONTENT_ATTRIBUTE_ID) {
    const richContent = normalizeRichContentValue(attr.values.map((value) => value?.value).find(Boolean));
    return richContent
      ? { complex_id: 0, id: RICH_CONTENT_ATTRIBUTE_ID, values: [{ value: richContent }] }
      : null;
  }
  if (isHashtagAttributeId(attr.id)) {
    const hashtags = normalizeHashtags(attr.values.map((value) => value?.value));
    return hashtags.length
      ? { complex_id: 0, id: attr.id, values: hashtags.map((value) => ({ value })) }
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
  "OZON_CATEGORY_TREE_UNAVAILABLE",
  "OZON_CATEGORY_ATTRIBUTES_UNAVAILABLE",
  "OZON_CATEGORY_VALUES_UNAVAILABLE",
  "OZON_CATEGORY_DATA_INVALID",
  "OZON_CATEGORY_TYPE_NOT_FOUND",
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
  error.code = "OZON_CATEGORY_DATA_INVALID";
  error.body = { operation: "REQUIRED_DICTIONARY_VALUE" };
  error.cause = null;
  return error;
}

function appendNormalizationWarning(ctx, warning) {
  const text = cleanText(warning, 500);
  if (!text || !Array.isArray(ctx?.warnings) || ctx.warnings.includes(text)) return;
  ctx.warnings.push(text);
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
  const cache = new Map();
  const out = [];
  for (const attr of asArray(attributes)) {
    const meta = metaById?.get?.(Number(attr?.id)) || {};
    const dictionaryId = attributeDictionaryId(meta);
    if (!dictionaryId || !asArray(attr?.values).some((value) => !toPositiveNumber(value?.dictionary_value_id))) {
      out.push(attr);
      continue;
    }
    const cacheKey = `${descriptionCategoryId}:${typeId}:${attr.id}`;
    if (!cache.has(cacheKey)) {
      try {
        cache.set(cacheKey, await ctx.getCategoryAttributeValues(descriptionCategoryId, typeId, attr.id));
      } catch (error) {
        if (isSafeCategoryError(error)) throw error;
        const required = isRequiredAttribute(meta);
        const label = attributeDisplayName(meta, attr.id);
        if (required) {
          const warning = `获取必填字典属性「${label}」可选值失败：${compactErrorMessage(error)}`;
          if (!ctx.allowUnresolvedRequiredDictionaryValues) throw new Error(warning);
          appendNormalizationWarning(ctx, warning);
        }
        continue;
      }
    }
    const options = cache.get(cacheKey);
    const required = isRequiredAttribute(meta);
    const nextValues = attr.values.map((value) => {
      if (toPositiveNumber(value?.dictionary_value_id)) return value;
      const matched = matchDictionaryValue(options, value?.value);
      const matchedId = toPositiveNumber(firstFilled(matched?.id, matched?.dictionary_value_id, matched?.dictionaryValueId));
      if (!matchedId) return value;
      return {
        value: cleanText(firstFilled(matched?.value, matched?.name, matched?.title, matched?.label, value?.value)),
        dictionary_value_id: matchedId,
      };
    });
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

async function assertStrictDictionaryValues(attributes, {
  descriptionCategoryId,
  typeId,
  metaByKey,
  ctx,
} = {}) {
  if (typeof ctx?.getCategoryAttributeValues !== "function") {
    if (asArray(attributes).some((attribute) =>
      attributeDictionaryId(metaByKey?.get?.(strictAttributeKey(attribute))))) {
      throw unresolvedCategoryDictionaryError();
    }
    return;
  }
  const cache = new Map();
  for (const attribute of asArray(attributes)) {
    const meta = metaByKey?.get?.(strictAttributeKey(attribute)) || {};
    if (!attributeDictionaryId(meta)) continue;
    const key = `${descriptionCategoryId}:${typeId}:${Number(attribute?.id)}`;
    if (!cache.has(key)) {
      try {
        cache.set(key, await ctx.getCategoryAttributeValues(descriptionCategoryId, typeId, Number(attribute?.id)));
      } catch (error) {
        if (isSafeCategoryError(error)) throw error;
        throw unresolvedCategoryDictionaryError();
      }
    }
    const allowed = new Set(asArray(cache.get(key))
      .map((option) => toPositiveNumber(firstFilled(
        option?.id, option?.dictionary_value_id, option?.dictionaryValueId, option?.value_id, option?.valueId,
      )))
      .filter(Boolean));
    if (!allowed.size || asArray(attribute?.values).some((value) =>
      !allowed.has(toPositiveNumber(value?.dictionary_value_id)))) {
      throw unresolvedCategoryDictionaryError();
    }
  }
}

function sourceComplexAttributes(item, allowedIds) {
  const groups = new Map();
  const all = [
    ...asArray(item.bundleComplexAttrs),
    ...asArray(sourceVariantOf(item)._bundleComplexAttrs),
    ...asArray(bundleItemOf(item).attributes).filter((attr) => toPositiveNumber(attr?.complex_id)),
  ];
  for (const raw of all) {
    const attr = normalizeUploadAttribute(raw);
    if (!attr || !hasAllowedAttribute(allowedIds, attr.id)) continue;
    const complexId = Number(attr.complex_id) || 0;
    if (!complexId) continue;
    if (!groups.has(complexId)) groups.set(complexId, []);
    groups.get(complexId).push(attr);
  }
  return [...groups.values()].map((attributes) => ({ attributes }));
}

function buildAttributes(item, allowedIds, metaById = new Map()) {
  const attrs = new Map();

  for (const raw of asArray(item.attributes)) {
    const attr = normalizeUploadAttribute(raw);
    if (attr && hasAllowedAttribute(allowedIds, attr.id)) upsertAttribute(attrs, attr, { overwrite: true });
  }

  for (const raw of asArray(bundleItemOf(item).attributes)) {
    if (toPositiveNumber(raw?.complex_id)) continue;
    const attr = normalizeUploadAttribute(raw);
    if (attr && hasAllowedAttribute(allowedIds, attr.id)) upsertAttribute(attrs, attr);
  }

  for (const raw of sourceAttributesOf(item)) {
    const attr = normalizeUploadAttribute(raw);
    if (attr && hasAllowedAttribute(allowedIds, attr.id)) upsertAttribute(attrs, attr);
  }

  const description = cleanText(firstFilled(item.scraped_description, item.description), 4096);
  if (description && hasAllowedAttribute(allowedIds, 4191)) {
    upsertAttribute(attrs, { complex_id: 0, id: 4191, values: [{ value: description }] }, { overwrite: true });
  }

  const richContent = normalizeRichContentValue(firstFilled(item.richContent, item.rich_content, sourceAttributeText(item, RICH_CONTENT_ATTRIBUTE_ID)));
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
      { complex_id: 0, id: hashtagAttributeId, values: hashtags.map((value) => ({ value })) },
      { overwrite: true },
    );
  }

  const barcodeValues = sourceAttributeValues(item, 7822);
  if (barcodeValues.length && hasAllowedAttribute(allowedIds, 7822)) {
    upsertAttribute(attrs, { complex_id: 0, id: 7822, values: barcodeValues }, { overwrite: true });
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

async function normalizeOneImportItem(item, ctx) {
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

  const { allowedIds, metaById, metaByKey } = await categoryAttributeContext(descriptionCategoryId, typeId, ctx);
  const images = normalizeImages(item.images);
  const source = sourceVariantOf(item);
  const bundle = bundleItemOf(item);
  const barcode = cleanText(firstFilled(item.barcode, bundle.barcode, sourceAttributeText(item, 7822)));

  const weight = positiveInt(item.weight, sourceWeightGrams(item), item.scraped_weight, bundle.weight, 100);
  const depth = positiveInt(item.depth, sourceAttributeText(item, 9454), item.scraped_depth, bundle.depth, 100);
  const width = positiveInt(item.width, sourceAttributeText(item, 9455), item.scraped_width, bundle.width, 100);
  const height = positiveInt(item.height, sourceAttributeText(item, 9456), item.scraped_height, bundle.height, 100);

  const builtAttributes = buildAttributes(item, allowedIds, metaById);
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
    await assertStrictDictionaryValues(allAttributes, {
      descriptionCategoryId,
      typeId,
      metaByKey,
      ctx,
    });
  }

  const normalized = {
    offer_id: cleanText(item.offer_id || item.offerId || `jz-${item.scraped_sku || Date.now()}`),
    name: cleanText(firstFilled(item.name, sourceAttributeText(item, 4180), item.scraped_sku), 200),
    price: cleanText(item.price),
    old_price: cleanText(item.old_price || item.oldPrice),
    min_price: parseSourceNumber(item.min_price || item.minPrice) > 0 ? cleanText(item.min_price || item.minPrice) : undefined,
    vat: cleanText(item.vat || "0"),
    currency_code: cleanText(item.currency_code || item.currencyCode || "RUB"),
    description_category_id: descriptionCategoryId,
    type_id: typeId,
    barcode,
    primary_image: images[0],
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

  return { item: stripUndefined(normalized), categoryResolution };
}

export async function normalizeOzonImportItems(items, ctx = {}) {
  const normalizedItems = [];
  const warnings = [];
  const categoryResolutions = [];
  const normalizationContext = { ...ctx, warnings };
  for (const item of asArray(items)) {
    try {
      const normalized = await normalizeOneImportItem(item, normalizationContext);
      normalizedItems.push(normalized.item);
      if (normalized.categoryResolution) categoryResolutions.push(normalized.categoryResolution);
    } catch (error) {
      if (error?.categoryResolution) categoryResolutions.push(error.categoryResolution);
      if (ctx.strictTypeMatch || isSafeCategoryError(error)) throw error;
      warnings.push(error?.message || String(error));
    }
  }
  return { items: normalizedItems, warnings, categoryResolutions };
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
