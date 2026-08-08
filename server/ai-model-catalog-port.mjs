export function createAiModelCatalogPort({ listModels } = {}) {
  if (typeof listModels !== "function") throw new TypeError("AI model catalog operation is required");
  return Object.freeze({ listModels });
}
