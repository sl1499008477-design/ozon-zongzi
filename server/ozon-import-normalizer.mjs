const TYPE_MATCH_SCORE = {
  EXACT: 3,
  NORMALIZED: 2,
  STEM: 1.5,
  PARTIAL: 1,
};

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

async function allowedAttributeIds(descriptionCategoryId, typeId, ctx) {
  if (!descriptionCategoryId || !typeId || typeof ctx.getCategoryAttributes !== "function") return null;
  const attrs = await ctx.getCategoryAttributes(descriptionCategoryId, typeId);
  if (!asArray(attrs).length) return null;
  return new Set(attrs.map((attr) => Number(attr.id)).filter(Boolean));
}

function sourceComplexAttributes(item, allowedIds) {
  const groups = new Map();
  const all = [
    ...asArray(item.bundleComplexAttrs),
    ...asArray(sourceVariantOf(item)._bundleComplexAttrs),
    ...asArray(bundleItemOf(item).attributes).filter((attr) => toPositiveNumber(attr?.complex_id)),
  ];
  for (const raw of all) {
    const attr = normalizeAttribute(raw);
    if (!attr || !hasAllowedAttribute(allowedIds, attr.id)) continue;
    const complexId = Number(attr.complex_id) || 0;
    if (!complexId) continue;
    if (!groups.has(complexId)) groups.set(complexId, []);
    groups.get(complexId).push(attr);
  }
  return [...groups.values()].map((attributes) => ({ attributes }));
}

function buildAttributes(item, allowedIds) {
  const attrs = new Map();

  for (const raw of asArray(item.attributes)) {
    const attr = normalizeAttribute(raw);
    if (attr && hasAllowedAttribute(allowedIds, attr.id)) upsertAttribute(attrs, attr, { overwrite: true });
  }

  for (const raw of asArray(bundleItemOf(item).attributes)) {
    if (toPositiveNumber(raw?.complex_id)) continue;
    const attr = normalizeAttribute(raw);
    if (attr && hasAllowedAttribute(allowedIds, attr.id)) upsertAttribute(attrs, attr);
  }

  for (const raw of sourceAttributesOf(item)) {
    const attr = normalizeAttribute(raw);
    if (attr && hasAllowedAttribute(allowedIds, attr.id)) upsertAttribute(attrs, attr);
  }

  const description = cleanText(firstFilled(item.scraped_description, item.description), 4096);
  if (description && hasAllowedAttribute(allowedIds, 4191)) {
    upsertAttribute(attrs, { complex_id: 0, id: 4191, values: [{ value: description }] }, { overwrite: true });
  }

  const richContent = cleanText(firstFilled(item.richContent, item.rich_content, sourceAttributeText(item, 11254)));
  if (richContent && hasAllowedAttribute(allowedIds, 11254)) {
    upsertAttribute(attrs, { complex_id: 0, id: 11254, values: [{ value: richContent }] }, { overwrite: true });
  }

  const modelName = cleanText(firstFilled(item.scraped_model_name, item.model_name, item.offer_id, item.scraped_sku));
  if (modelName && hasAllowedAttribute(allowedIds, 9048)) {
    upsertAttribute(attrs, { complex_id: 0, id: 9048, values: [{ value: modelName }] }, { overwrite: true });
  }

  const hashtags = asArray(item._aiHashtags)
    .map((tag) => cleanText(tag).replace(/^#/, ""))
    .filter(Boolean)
    .slice(0, 15);
  if (hashtags.length && hasAllowedAttribute(allowedIds, 23171)) {
    upsertAttribute(
      attrs,
      { complex_id: 0, id: 23171, values: hashtags.map((value) => ({ value })) },
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
  if (!typeId && typeof ctx.getCategoryTree === "function") {
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

  const allowedIds = await allowedAttributeIds(descriptionCategoryId, typeId, ctx);
  const images = normalizeImages(item.images);
  const source = sourceVariantOf(item);
  const bundle = bundleItemOf(item);
  const barcode = cleanText(firstFilled(item.barcode, bundle.barcode, sourceAttributeText(item, 7822)));

  const weight = positiveInt(item.weight, sourceWeightGrams(item), item.scraped_weight, bundle.weight, 100);
  const depth = positiveInt(item.depth, sourceAttributeText(item, 9454), item.scraped_depth, bundle.depth, 100);
  const width = positiveInt(item.width, sourceAttributeText(item, 9455), item.scraped_width, bundle.width, 100);
  const height = positiveInt(item.height, sourceAttributeText(item, 9456), item.scraped_height, bundle.height, 100);

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
    attributes: buildAttributes(item, allowedIds),
    complex_attributes: sourceComplexAttributes(item, allowedIds),
  };

  return stripUndefined(normalized);
}

export async function normalizeOzonImportItems(items, ctx = {}) {
  const normalizedItems = [];
  const warnings = [];
  for (const item of asArray(items)) {
    try {
      normalizedItems.push(await normalizeOneImportItem(item, ctx));
    } catch (error) {
      if (ctx.strictTypeMatch) throw error;
      warnings.push(error?.message || String(error));
    }
  }
  return { items: normalizedItems, warnings };
}

export const testExports = {
  normalizeImages,
  collectTypeCandidates,
  matchTypeCandidate,
  buildAttributes,
};
