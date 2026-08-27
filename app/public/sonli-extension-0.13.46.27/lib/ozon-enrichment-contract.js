(function (root) {
  'use strict';

  const CONTRACT_VERSION = 'collector.ozon.enrichment.v1';
  const REQUIRED_FIELDS = Object.freeze([
    'descriptionCategoryId',
    'weightG',
    'lengthMm',
    'widthMm',
    'heightMm',
  ]);
  const ATTRIBUTE_IDS = Object.freeze({
    weightG: '4497',
    weightKg: '4383',
    lengthMm: '9454',
    widthMm: '9455',
    heightMm: '9456',
  });
  const RESULT_KEYS = Object.freeze([
    'status',
    'contractVersion',
    'sku',
    'descriptionCategoryId',
    'typeId',
    'logistics',
    'variantData',
    'sourceCategory',
    'source',
    'capturedAt',
    'cache',
  ]);

  const isPlainObject = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  };

  const positiveNumber = (value) => {
    try {
      const number = Number(value);
      return Number.isFinite(number) && number > 0 ? number : 0;
    } catch {
      return 0;
    }
  };

  const nativePositiveNumber = (value) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0;
  const nativeFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
  const nativeText = (value) => typeof value === 'string' && value.trim().length > 0;

  const cleanText = (value) => String(value == null ? '' : value).trim();

  const validSourceCategory = (value) => exactKeys(
    value,
    ['descriptionCategoryId', 'typeName', 'typeIdCandidate', 'path'],
  )
    && nativeFiniteNumber(value.descriptionCategoryId)
    && typeof value.typeName === 'string'
    && nativeFiniteNumber(value.typeIdCandidate)
    && Array.isArray(value.path)
    && value.path.every((entry) => typeof entry === 'string');

  const normalizedSourceCategory = (value) => ({
    descriptionCategoryId: value.descriptionCategoryId,
    typeName: cleanText(value.typeName),
    typeIdCandidate: value.typeIdCandidate,
    path: value.path.map(cleanText).filter(Boolean),
  });

  const contractError = (
    message,
    code = 'OZON_ENRICH_CONTRACT_MISMATCH',
    missing = [],
  ) => Object.assign(new Error(message), {
    status: 422,
    code,
    missingFields: [...missing],
    retryable: code === 'OZON_ENRICH_INCOMPLETE',
  });

  const exactKeys = (value, allowed, required = allowed) => isPlainObject(value)
    && Object.keys(value).every((key) => allowed.includes(key))
    && required.every((key) => Object.hasOwn(value, key));

  const fieldValues = (value = {}) => {
    const logistics = isPlainObject(value?.logistics) ? value.logistics : {};
    return {
      descriptionCategoryId: value?.descriptionCategoryId,
      weightG: value?.weightG ?? logistics.weightG ?? value?.weight,
      lengthMm: value?.lengthMm ?? logistics.lengthMm ?? value?.depth,
      widthMm: value?.widthMm ?? logistics.widthMm ?? value?.width,
      heightMm: value?.heightMm ?? logistics.heightMm ?? value?.height,
    };
  };

  const missingFields = (value) => {
    const fields = fieldValues(value);
    return REQUIRED_FIELDS.filter((field) => !positiveNumber(fields[field]));
  };

  const assertComplete = (value) => {
    const missing = missingFields(value);
    if (missing.length) {
      throw contractError(
        `Ozon 商品资料不完整：${missing.join(', ')}`,
        'OZON_ENRICH_INCOMPLETE',
        missing,
      );
    }
    return value;
  };

  const attributesByKey = (variantData) => {
    const values = new Map();
    const attributes = Array.isArray(variantData?.attributes) ? variantData.attributes : [];
    for (const attribute of attributes) {
      const key = cleanText(attribute?.key);
      if (!key) continue;
      const current = values.get(key) || [];
      current.push(attribute?.value);
      values.set(key, current);
    }
    return values;
  };

  const productScalar = (value) => (
    typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  );

  const positiveInteger = (value) => {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : 0;
  };

  const projectAttribute = (attribute) => {
    if (!isPlainObject(attribute)) return null;
    const key = cleanText(attribute.key);
    if (!/^\d{1,20}$/.test(key)) return null;
    const projected = { key };
    if (productScalar(attribute.value)) {
      projected.value = attribute.value;
    } else if (Array.isArray(attribute.collection)) {
      const collection = attribute.collection.filter(productScalar);
      if (collection.length) projected.collection = collection;
    }
    if (!Object.hasOwn(projected, 'value') && !Object.hasOwn(projected, 'collection')) return null;
    const dictionaryValueId = positiveInteger(
      attribute.dictionary_value_id ?? attribute.dictionaryValueId,
    );
    if (dictionaryValueId) projected.dictionary_value_id = dictionaryValueId;
    return projected;
  };

  const projectBundleAttribute = (attribute) => {
    if (!isPlainObject(attribute) || positiveInteger(attribute.complex_id)) return null;
    const key = cleanText(attribute.attribute_id);
    if (!/^\d{1,20}$/.test(key)) return null;
    const values = Array.isArray(attribute.values)
      ? attribute.values.filter((entry) => isPlainObject(entry) && productScalar(entry.value))
      : [];
    if (!values.length) return null;
    if (values.length > 1) return { key, collection: values.map((entry) => entry.value) };
    const projected = { key, value: values[0].value };
    const dictionaryValueId = positiveInteger(
      values[0].dictionary_value_id ?? values[0].dictionaryValueId,
    );
    if (dictionaryValueId) projected.dictionary_value_id = dictionaryValueId;
    return projected;
  };

  const projectCategory = (category) => {
    if (!isPlainObject(category)) return null;
    const projected = {};
    const id = positiveInteger(category.id);
    const level = positiveInteger(category.level);
    const title = cleanText(category.title);
    const name = cleanText(category.name);
    if (id) projected.id = id;
    if (level) projected.level = level;
    if (title) projected.title = title;
    else if (name) projected.name = name;
    return Object.keys(projected).length ? projected : null;
  };

  const skuCandidates = (value) => {
    const candidates = [];
    const append = (candidate) => {
      if (candidate == null || typeof candidate === 'object') return;
      const text = cleanText(candidate);
      if (text) candidates.push(text);
    };
    const appendEntry = (entry) => {
      if (!isPlainObject(entry)) return append(entry);
      for (const key of ['sku', 'sku_id', 'product_id', 'offer_id', 'value']) append(entry[key]);
    };
    for (const key of ['sku', 'sku_id', 'product_id', 'offer_id', 'variant_id']) append(value?.[key]);
    for (const entries of [value?.skus, value?._searchMeta?.skus]) {
      if (Array.isArray(entries)) entries.forEach(appendEntry);
    }
    return candidates;
  };

  const appendAttribute = (attributes, keys, attribute) => {
    if (!attribute || keys.has(attribute.key)) return;
    attributes.push(attribute);
    keys.add(attribute.key);
  };

  const projectCollectedVariant = (variantData) => {
    if (!isPlainObject(variantData)) return {};
    const attributes = [];
    const keys = new Set();
    for (const attribute of Array.isArray(variantData.attributes) ? variantData.attributes : []) {
      appendAttribute(attributes, keys, projectAttribute(attribute));
    }

    const bundle = isPlainObject(variantData._bundleItem) ? variantData._bundleItem : {};
    for (const [key, value] of [
      [ATTRIBUTE_IDS.weightG, bundle.weight],
      [ATTRIBUTE_IDS.lengthMm, bundle.depth],
      [ATTRIBUTE_IDS.widthMm, bundle.width],
      [ATTRIBUTE_IDS.heightMm, bundle.height],
      ['7822', bundle.barcode],
    ]) {
      const text = cleanText(value);
      if (text) appendAttribute(attributes, keys, { key, value: text });
    }
    for (const attribute of Array.isArray(bundle.attributes) ? bundle.attributes : []) {
      appendAttribute(attributes, keys, projectBundleAttribute(attribute));
    }

    const projected = {};
    const descriptionCategoryId = positiveInteger(variantData.description_category_id);
    const typeId = positiveInteger(variantData.type_id);
    if (descriptionCategoryId) projected.description_category_id = descriptionCategoryId;
    if (typeId) projected.type_id = typeId;

    const categories = Array.isArray(variantData.categories)
      ? variantData.categories.map(projectCategory).filter(Boolean)
      : [];
    if (categories.length) projected.categories = categories;
    if (attributes.length) projected.attributes = attributes;

    const values = attributesByKey({ attributes });
    const weight = firstPositive(
      variantData.weight,
      values.get(ATTRIBUTE_IDS.weightG),
      (values.get(ATTRIBUTE_IDS.weightKg) || []).map((value) => positiveNumber(value) * 1000),
    );
    const depth = firstPositive(variantData.depth, values.get(ATTRIBUTE_IDS.lengthMm));
    const width = firstPositive(variantData.width, values.get(ATTRIBUTE_IDS.widthMm));
    const height = firstPositive(variantData.height, values.get(ATTRIBUTE_IDS.heightMm));
    if (weight) projected.weight = weight;
    if (depth) projected.depth = depth;
    if (width) projected.width = width;
    if (height) projected.height = height;
    return projected;
  };

  const collectEvidenceFromSearchResult = ({ sku, result } = {}) => {
    const requestedSku = cleanText(sku);
    if (!requestedSku) return {};
    const response = result?.status === 'fulfilled' ? result.value : result;
    const items = Array.isArray(response?.items)
      ? response.items
      : Array.isArray(response?.data?.items)
        ? response.data.items
        : [];
    const matched = items.find((item) => skuCandidates(item).includes(requestedSku));
    if (!matched) return {};
    const variantData = projectCollectedVariant(matched);
    if (!Object.keys(variantData).length) return {};

    const evidence = {};
    if (variantData.description_category_id) {
      evidence.description_category_id = variantData.description_category_id;
    }
    if (variantData.type_id) evidence.type_id = variantData.type_id;
    for (const key of ['weight', 'depth', 'width', 'height']) {
      if (variantData[key]) evidence[key] = variantData[key];
    }
    if (evidence.weight) evidence.weight_unit = 'g';
    if (evidence.depth || evidence.width || evidence.height) evidence.dimension_unit = 'mm';
    evidence.variantData = variantData;
    return evidence;
  };

  const firstPositive = (...groups) => {
    for (const value of groups.flat()) {
      const number = positiveNumber(value);
      if (number) return number;
    }
    return 0;
  };

  const normalizeVariantData = ({ sku, variantData, source, capturedAt } = {}) => {
    if (!isPlainObject(variantData)) {
      throw contractError('Ozon 商品补全结果缺少 variantData');
    }
    const attributes = attributesByKey(variantData);
    const result = {
      status: 'COMPLETE',
      contractVersion: CONTRACT_VERSION,
      sku: cleanText(sku),
      descriptionCategoryId: positiveNumber(variantData.description_category_id),
      logistics: {
        weightG: firstPositive(
          attributes.get(ATTRIBUTE_IDS.weightG),
          (attributes.get(ATTRIBUTE_IDS.weightKg) || [])
            .map((value) => positiveNumber(value) * 1000),
          variantData.weight,
        ),
        lengthMm: firstPositive(attributes.get(ATTRIBUTE_IDS.lengthMm), variantData.depth),
        widthMm: firstPositive(attributes.get(ATTRIBUTE_IDS.widthMm), variantData.width),
        heightMm: firstPositive(attributes.get(ATTRIBUTE_IDS.heightMm), variantData.height),
      },
      variantData,
      source: cleanText(source),
      capturedAt: cleanText(capturedAt),
    };
    const typeId = positiveNumber(variantData.type_id);
    if (typeId) result.typeId = typeId;
    if (!result.sku || !result.source || !result.capturedAt) {
      throw contractError('Ozon 商品补全结果格式无效');
    }
    assertComplete(result);
    return result;
  };

  const normalizeResult = (value) => {
    const requiredKeys = RESULT_KEYS.filter((key) => !['typeId', 'sourceCategory'].includes(key));
    if (
      !exactKeys(value, RESULT_KEYS, requiredKeys)
      || value.status !== 'COMPLETE'
      || value.contractVersion !== CONTRACT_VERSION
      || !nativeText(value.sku)
      || !nativeText(value.source)
      || !nativeText(value.capturedAt)
      || !nativeFiniteNumber(value.descriptionCategoryId)
      || !isPlainObject(value.variantData)
      || (Object.hasOwn(value, 'sourceCategory') && !validSourceCategory(value.sourceCategory))
      || !exactKeys(
        value.logistics,
        ['weightG', 'lengthMm', 'widthMm', 'heightMm'],
      )
      || !exactKeys(value.cache, ['hit', 'expiresAt'])
      || typeof value.cache.hit !== 'boolean'
      || !nativeText(value.cache.expiresAt)
      || !nativeFiniteNumber(value.logistics.weightG)
      || !nativeFiniteNumber(value.logistics.lengthMm)
      || !nativeFiniteNumber(value.logistics.widthMm)
      || !nativeFiniteNumber(value.logistics.heightMm)
      || (Object.hasOwn(value, 'typeId') && !nativePositiveNumber(value.typeId))
    ) {
      throw contractError('Ozon 商品补全响应 contract 不匹配');
    }
    assertComplete(value);
    return {
      status: 'COMPLETE',
      contractVersion: CONTRACT_VERSION,
      sku: cleanText(value.sku),
      descriptionCategoryId: value.descriptionCategoryId,
      ...(Object.hasOwn(value, 'typeId') ? { typeId: value.typeId } : {}),
      logistics: {
        weightG: value.logistics.weightG,
        lengthMm: value.logistics.lengthMm,
        widthMm: value.logistics.widthMm,
        heightMm: value.logistics.heightMm,
      },
      variantData: value.variantData,
      ...(Object.hasOwn(value, 'sourceCategory')
        ? { sourceCategory: normalizedSourceCategory(value.sourceCategory) }
        : {}),
      source: cleanText(value.source),
      capturedAt: cleanText(value.capturedAt),
      cache: {
        hit: value.cache.hit,
        expiresAt: cleanText(value.cache.expiresAt),
      },
    };
  };

  const toCollectFields = (value) => {
    assertComplete(value);
    const fields = fieldValues(value);
    const typeId = positiveNumber(value?.typeId);
    return {
      description_category_id: positiveNumber(fields.descriptionCategoryId),
      ...(typeId ? { type_id: typeId } : {}),
      weight: positiveNumber(fields.weightG),
      depth: positiveNumber(fields.lengthMm),
      width: positiveNumber(fields.widthMm),
      height: positiveNumber(fields.heightMm),
      weight_unit: 'g',
      dimension_unit: 'mm',
      variantData: value?.variantData,
      ...(validSourceCategory(value?.sourceCategory)
        ? { sourceCategory: normalizedSourceCategory(value.sourceCategory) }
        : {}),
    };
  };

  const api = Object.freeze({
    CONTRACT_VERSION,
    assertComplete,
    collectEvidenceFromSearchResult,
    missingFields,
    normalizeResult,
    normalizeVariantData,
    toCollectFields,
  });
  root.JzOzonEnrichmentContract = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
