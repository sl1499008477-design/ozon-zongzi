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
    const requiredKeys = RESULT_KEYS.filter((key) => key !== 'typeId');
    if (
      !exactKeys(value, RESULT_KEYS, requiredKeys)
      || value.status !== 'COMPLETE'
      || value.contractVersion !== CONTRACT_VERSION
      || !nativeText(value.sku)
      || !nativeText(value.source)
      || !nativeText(value.capturedAt)
      || !nativeFiniteNumber(value.descriptionCategoryId)
      || !isPlainObject(value.variantData)
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
    };
  };

  const api = Object.freeze({
    CONTRACT_VERSION,
    assertComplete,
    missingFields,
    normalizeResult,
    normalizeVariantData,
    toCollectFields,
  });
  root.JzOzonEnrichmentContract = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
