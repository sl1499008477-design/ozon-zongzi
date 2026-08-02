const normalizedDictionaryId = (value) => {
  const text = String(value ?? "").trim();
  return /^\d+$/.test(text) && Number(text) > 0 ? text : "";
};

const dictionaryIdOf = (value) => normalizedDictionaryId(
  value && typeof value === "object"
    ? value.dictionary_value_id ?? value.dictionaryValueId ?? value.id
    : value,
);

export function collectEditDictionaryIdsOf(attribute = {}) {
  const candidates = [
    attribute.dictionary_value_id,
    attribute.dictionaryValueId,
    ...(Array.isArray(attribute.values) ? attribute.values : []),
    ...(Array.isArray(attribute.collection) ? attribute.collection : []),
  ];
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    const id = dictionaryIdOf(candidate);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

export function resolveCollectEditDictionaryValue({
  dictionaryIds = [],
  options = [],
  multiple = false,
} = {}) {
  const optionById = new Map();
  for (const option of Array.isArray(options) ? options : []) {
    const id = dictionaryIdOf(option?.dictionaryValueId ?? option?.dictionary_value_id ?? option?.id);
    const value = String(option?.value ?? "").trim();
    if (id && value && !optionById.has(id)) optionById.set(id, value);
  }
  const matches = [];
  const seenValues = new Set();
  for (const candidate of Array.isArray(dictionaryIds) ? dictionaryIds : []) {
    const value = optionById.get(normalizedDictionaryId(candidate));
    if (!value || seenValues.has(value)) continue;
    seenValues.add(value);
    matches.push(value);
    if (!multiple) break;
  }
  return matches.length
    ? { matchedById: true, value: multiple ? matches : matches[0] }
    : { matchedById: false, value: undefined };
}

const comparableValue = (value) => Array.isArray(value)
  ? value.map((item) => String(item ?? "").trim()).filter(Boolean)
  : String(value ?? "").trim();

export function shouldApplyCollectEditDictionaryDefault({
  currentValue,
  sourceValue,
  matchedById,
} = {}) {
  if (matchedById !== true) return false;
  const current = comparableValue(currentValue);
  const source = comparableValue(sourceValue);
  if (Array.isArray(current)) {
    if (!current.length) return true;
    return Array.isArray(source)
      && current.length === source.length
      && current.every((item, index) => item === source[index]);
  }
  return current === "" || current === source;
}
