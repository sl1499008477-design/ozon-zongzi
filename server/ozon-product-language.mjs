// Product prose must come from the Russian source; identifiers, model and video names,
// URLs and units remain verbatim. Used at collection/upload write boundaries.
export const hasChineseProductText = value => typeof value === "string" && /\p{Script=Han}/u.test(value);
export function preferOzonRussianText(...values) {
  const texts = values.filter(value => typeof value === "string" && value.trim()).map(value => value.trim());
  return texts.find(value => !hasChineseProductText(value)) || texts[0] || "";
}

const textFields = new Set(["name", "title", "nameLabel", "description", "descriptionHTML", "scraped_description",
  "webDescription", "richContent", "rich_content", "brand", "brandName", "modelName", "model_name",
  "scraped_model_name", "typeName", "categoryName", "categoryPath", "tags", "hashtags", "_aiHashtags",
  "aspectValues", "path", "characteristics", "attributes", "complex_attributes", "bundleComplexAttrs", "categories"]);
const productContainers = new Set(["payload", "raw", "variantData", "variants", "listingDraft", "sourceCategory", "sourceVariant", "_sourceVariant", "bundleItem", "_bundleItem"]);
const mediaFields = new Set(["url", "src", "link", "images", "image", "coverUrl", "coverImage", "sourceUrl", "videoUrl", "videoCover"]);
export function assertOzonRussianProductText(product, { sku = "", operation = "上传" } = {}) {
  const visit = (value, path, all, currentSku) => {
    if (typeof value === "string") {
      // Rich content is a JSON string; inspect decoded text, including \u escapes.
      if (/^\s*[\[{]/u.test(value)) {
        let decoded; try { decoded = JSON.parse(value); } catch { /* plain prose */ }
        if (decoded && typeof decoded === "object") return visit(decoded, path, true, currentSku);
      }
      if (all && hasChineseProductText(value) && !/^https?:\/\//iu.test(value)) {
        throw Object.assign(new Error(`SKU ${currentSku || "未知"}：${operation}字段 ${path} 含中文，请重新采集或补全俄语原文`),
          { status: 422, code: "ZONGZI_PRODUCT_RUSSIAN_REQUIRED" });
      }
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach((child, index) => visit(child, `${path}[${child?.id || child?.key || index}]`, all, currentSku));
    const ownSku = String(value.sku || value.sourceSku || value.scraped_sku || currentSku || "");
    // Seller article numbers, model names and product-card grouping keys are identifiers,
    // not translatable product prose.
    const identifierAttribute = /(?:^|\.)attributes\[[^\]]+\]$/.test(path)
      && ["9024", "9048", "10289"].includes(String(value.id ?? value.key ?? value.attribute_id ?? value.attributeId));
    const videoNameAttribute = /(?:^|\.)(?:attributes|bundleComplexAttrs)\[[^\]]+\]$/.test(path)
      && String(value.id ?? value.key ?? value.attribute_id ?? value.attributeId) === "21837";
    const videoEntry = /(?:^|\.)videos(?:\[[^\]]+\])?$/.test(path);
    for (const [key, child] of Object.entries(value)) {
      if ((identifierAttribute || videoNameAttribute) && ["value", "values", "collection"].includes(key)) continue;
      if (videoEntry && ["name", "title"].includes(key)) continue;
      if (["modelName", "model_name", "scraped_model_name"].includes(key)) continue;
      if (mediaFields.has(key)) continue;
      if (all || textFields.has(key)) visit(child, path ? `${path}.${key}` : key, true, ownSku);
      else if (productContainers.has(key) || key === "videos") visit(child, path ? `${path}.${key}` : key, false, ownSku);
    }
  };
  visit(product, "", false, sku);
}
