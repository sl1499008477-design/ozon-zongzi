// Structured values are the collector contract; flattened text is only a legacy fallback.
export function collectedAttributeValues(attribute = {}) {
  if (Array.isArray(attribute.values)) return attribute.values;
  const dictionaryId = attribute.dictionary_value_id ?? attribute.dictionaryValueId;
  if (Array.isArray(attribute.collection) && attribute.collection.length) {
    return attribute.collection.map(value => {
      const entry = value && typeof value === "object" ? value : { value };
      return attribute.collection.length === 1 && dictionaryId !== undefined
        && entry.dictionary_value_id === undefined && entry.dictionaryValueId === undefined
        ? { ...entry, dictionary_value_id: dictionaryId } : entry;
    });
  }
  if (attribute.value === undefined && dictionaryId === undefined) return [];
  return [{ ...(attribute.value !== undefined ? { value: attribute.value } : {}),
    ...(dictionaryId !== undefined ? { dictionary_value_id: dictionaryId } : {}) }];
}
