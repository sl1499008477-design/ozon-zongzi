import { collectedAttributeValues } from "./collector-attribute-values.mjs";
import { explicitOzonListingTarget } from "./collect-enrichment-policy.mjs";

function cleanText(value, maxLength = 500) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function normalizeCurrencyCode(value) {
  const code = String(value || "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : "";
}

export function listingFirstText(...values) {
  for (const value of values) {
    const text = cleanText(value, 500);
    if (text) return text;
  }
  return "";
}

export function listingNumber(value) {
  const text = String(value ?? "").replace(",", ".").trim();
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return 0;
  const number = Number(match[0]);
  return Number.isFinite(number) ? number : 0;
}

function listingSourceCategoryEvidence(...candidates) {
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const descriptionCategoryId = Number(listingFirstText(
      candidate.descriptionCategoryId,
      candidate.description_category_id,
    ));
    if (Number.isFinite(descriptionCategoryId) && descriptionCategoryId > 0) return candidate;
  }
  return {};
}

export function listingImageList(...values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const rawList = Array.isArray(value) ? value : value ? [value] : [];
    for (const raw of rawList) {
      const url = cleanText(typeof raw === "object" ? raw.file_name || raw.url || raw.src || raw.image || raw.value : raw, 1000);
      if (!url) continue;
      const key = url.split("?")[0].split("#")[0].toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(url);
    }
  }
  return out;
}

function listingAttributeValues(attr = {}) {
  return collectedAttributeValues(attr).filter(value =>
    cleanText(value?.value ?? value?.name ?? value?.title) || Number(value?.dictionary_value_id ?? value?.dictionaryValueId) > 0);
}

function listingDraftAttributes(draft = {}, item = {}) {
  const source = Array.isArray(draft.categoryAttributes)
    ? draft.categoryAttributes
    : Array.isArray(item.attributes)
      ? item.attributes
      : [];
  return source
    .map((attr) => {
      const id = Number(attr.id || attr.attribute_id || attr.attributeId || attr.key) || 0;
      const values = listingAttributeValues(attr);
      if (!id || (!values.length && !Array.isArray(attr.values))) return null;
      return {
        id,
        name: attr.name || attr.label || "",
        values,
        is_required: !!attr.required || !!attr.is_required,
      };
    })
    .filter(Boolean);
}

function listingVariantSourceSnapshot(variant = {}, item = {}, rowSku = "", anchorSku = "") {
  const direct = [
    variant.sourceVariant,
    variant._sourceVariant,
    variant.variantData,
    variant.variant_data,
    variant.sv,
  ].find((value) => value && typeof value === "object" && !Array.isArray(value));
  if (direct) return direct;
  if (Array.isArray(variant.attributes) && variant.attributes.length) return variant;
  // The current collector retains each SKU's bundle attributes with its source
  // category. Adapt that persisted shape without borrowing another SKU's data.
  if (Array.isArray(variant.sourceCategory?.attributes) && variant.sourceCategory.attributes.length) {
    return { ...variant, attributes: variant.sourceCategory.attributes };
  }
  if (String(rowSku || "") !== String(anchorSku || "")) return {};
  return [
    item._sourceVariant,
    item.sourceVariant,
    item.variantData,
    item.variant_data,
    item.raw?.variantData,
    item.raw?.variant_data,
  ].find((value) => value && typeof value === "object" && !Array.isArray(value)) || null;
}

function listingSourceAttribute(source = {}, attributeId) {
  const key = String(attributeId);
  return (Array.isArray(source.attributes) ? source.attributes : []).find((attr) =>
    String(attr?.key ?? attr?.id ?? attr?.attribute_id ?? attr?.attributeId) === key
  );
}

function listingSourceImages(source = {}) {
  const primary = listingSourceAttribute(source, 4194);
  const gallery = listingSourceAttribute(source, 4195);
  return listingImageList(
    primary?.value,
    primary?.values,
    primary?.collection,
    gallery?.value,
    gallery?.values,
    gallery?.collection,
    source.images,
    source.image,
  );
}

function listingVariantDraftAttributes(variant = {}, fallback = []) {
  if (Array.isArray(variant.categoryAttributes)) {
    return listingDraftAttributes({ categoryAttributes: variant.categoryAttributes }, {});
  }
  if (Array.isArray(variant.attributes) && variant.attributes.length) {
    return listingDraftAttributes({ categoryAttributes: variant.attributes }, {});
  }
  return fallback;
}

export function buildCollectBoxListingItems(item = {}, targetStoreId = "") {
  const draft = item.listingDraft && typeof item.listingDraft === "object" ? item.listingDraft : {};
  const draftSourceCategory = listingSourceCategoryEvidence(
    draft.sourceCategory,
    draft.categoryResolution?.source,
    item.sourceCategory,
    item.categoryResolution?.source,
  );
  const draftLogistics = draft.logistics && typeof draft.logistics === "object"
    ? draft.logistics
    : {};
  const sku = listingFirstText(draft.sku, item.sku, item.product_id, item.productId, item.id);
  const baseTitle = listingFirstText(draft.title, item.name, item.title, sku);
  const currencyCode = normalizeCurrencyCode(listingFirstText(draft.currencyCode, draft.currency_code, item.currency_code, item.currencyCode)) || "CNY";
  const sourceCurrencyCode = normalizeCurrencyCode(listingFirstText(item.currency_code, item.currencyCode, item.price?.currency_code));
  const canReuseSourcePrice = sourceCurrencyCode === currencyCode;
  const basePrice = listingNumber(listingFirstText(
    draft.price,
    canReuseSourcePrice ? listingFirstText(item.price?.price, item.price, item.priceText) : "",
  ));
  const offerPrefix = listingFirstText(draft.offerPrefix, item.offerPrefix, "jz-") || "jz-";
  const sharedImages = listingImageList(draft.images, draft.image, item.images, item.image);
  const anchorTarget = explicitOzonListingTarget(
    draft.categoryResolution || item.categoryResolution,
    { targetStoreId },
  ) || {};
  const anchorAttributes = listingDraftAttributes(draft, item);
  const sharedModelName = listingFirstText(draft.modelName, item.modelName, item.model_name, sku);
  const variants = Array.isArray(draft.variants) && draft.variants.length ? draft.variants : [];
  const rows = variants.length ? variants : [{
    sku,
    name: baseTitle,
    sellPrice: basePrice,
    oldPrice: canReuseSourcePrice ? item.old_price || item.oldPrice : "",
    offerId: listingFirstText(item.offer_id, item.offerId, `${offerPrefix}${sku}`),
    image: sharedImages[0] || "",
    images: sharedImages,
  }];

  return rows.map((variant, index) => {
    const rowSku = listingFirstText(variant.sku, variant.product_id, sku);
    const isAnchor = rowSku === sku;
    const savedSource = listingVariantSourceSnapshot(variant, item, rowSku, sku);
    // Desktop single-SKU captures persist their Seller facts at the draft root.
    const usesDraftSource = !savedSource && isAnchor && Array.isArray(draft.sourceCategory?.attributes);
    const sourceVariant = usesDraftSource ? { ...draft, attributes: draft.sourceCategory.attributes } : savedSource || {};
    // Empty edits are authoritative; only the actual anchor may use draft-root facts.
    const contentValue = key => [variant, ...(isAnchor ? [draft] : []), sourceVariant, ...(isAnchor ? [item] : [])]
      .find(carrier => Object.hasOwn(carrier, key) && carrier[key] !== undefined)?.[key];
    const sourceArticle = listingSourceAttribute(sourceVariant, 9024);
    // Use the current SKU's Seller article verbatim, ahead of generated draft IDs.
    const originalArticle = [
      sourceArticle?.values?.[0]?.value, sourceArticle?.value,
      sourceArticle?.collection?.[0]?.value ?? sourceArticle?.collection?.[0],
      variant.article, sourceVariant.article,
      ...(isAnchor ? [draft.article, item.article] : []),
    ].find(value => typeof value === "string" && value.trim());
    const offerId = originalArticle ?? listingFirstText(
      variant.offerId,
      variant.offer_id,
      rowSku ? `${offerPrefix}${rowSku}${rows.length > 1 ? `-${String(index + 1).padStart(2, "0")}` : ""}` : "",
    );
    const price = listingNumber(Object.hasOwn(variant, "sellPrice") ? variant.sellPrice : listingFirstText(
      variant.price, rows.length === 1 ? basePrice : "",
    ));
    const oldPrice = listingNumber(listingFirstText(
      variant.oldPrice, variant.old_price,
      rows.length === 1 && canReuseSourcePrice ? listingFirstText(item.old_price, item.oldPrice) : "",
    ));
    const ownImages = listingImageList(variant.image, variant.images, variant.picture,
      usesDraftSource && sharedImages.length ? [] : listingSourceImages(sourceVariant));
    const variantImages = ownImages.length ? ownImages : sharedImages;
    const variantAttributes = listingVariantDraftAttributes(variant, isAnchor ? anchorAttributes : []);
    const variantTarget = explicitOzonListingTarget(
      variant.categoryResolution,
      { targetStoreId },
    ) || {};
    const descriptionCategoryId = variantTarget.descriptionCategoryId
      || anchorTarget.descriptionCategoryId
      || 0;
    const typeId = variantTarget.typeId || anchorTarget.typeId || 0;
    const description = [
      variant.descriptionHTML,
      variant.description,
      variant.scraped_description,
      isAnchor ? draft.descriptionHTML || draft.description : "",
    ].find(value => typeof value === "string" && value.trim())?.trim() || "";
    const richContent = contentValue("richContent") ?? contentValue("rich_content");
    const tags = Array.isArray(variant.tags)
      ? variant.tags
      : (isAnchor && Array.isArray(draft.tags) ? draft.tags : undefined);
    const variantLogistics = variant.logistics && typeof variant.logistics === "object"
      ? variant.logistics
      : {};
    const sourceCategory = listingSourceCategoryEvidence(
      variant.sourceCategory,
      variant.categoryResolution?.source,
      draftSourceCategory,
    );
    const weight = Math.round(listingNumber(listingFirstText(
      variant.packageWeight,
      variant.weight,
      variantLogistics.weightG,
      isAnchor ? listingFirstText(draft.packageWeight, draftLogistics.weightG) : "",
    )));
    const depth = Math.round(listingNumber(listingFirstText(
      variant.packageLength,
      variant.depth,
      variantLogistics.lengthMm,
      isAnchor ? listingFirstText(draft.packageLength, draftLogistics.lengthMm) : "",
    )));
    const width = Math.round(listingNumber(listingFirstText(
      variant.packageWidth,
      variant.width,
      variantLogistics.widthMm,
      isAnchor ? listingFirstText(draft.packageWidth, draftLogistics.widthMm) : "",
    )));
    const height = Math.round(listingNumber(listingFirstText(
      variant.packageHeight,
      variant.height,
      variantLogistics.heightMm,
      isAnchor ? listingFirstText(draft.packageHeight, draftLogistics.heightMm) : "",
    )));
    return {
      offer_id: offerId,
      name: listingFirstText(variant.name, variant.title, baseTitle, rowSku),
      price: price > 0 ? price.toFixed(2) : "",
      old_price: oldPrice > 0 ? oldPrice.toFixed(2) : (price > 0 ? (price * 1.25).toFixed(2) : ""),
      vat: listingFirstText(variant.vat, "0"),
      currency_code: normalizeCurrencyCode(listingFirstText(variant.priceCurrency, variant.currencyCode, variant.currency_code, currencyCode)) || currencyCode,
      images: variantImages,
      scraped_description: contentValue("contentDiagnostics")?.description?.source === "manual"
        ? (contentValue("description") ?? "") : description || undefined,
      scraped_sku: rowSku,
      // Ozon uses the shared model name to merge otherwise independent variants.
      scraped_model_name: sharedModelName,
      brand: listingFirstText(variant.brand, isAnchor ? draft.brand : ""),
      _aiHashtags: tags,
      richContent,
      videos: Array.isArray(contentValue("videos")) ? structuredClone(contentValue("videos")) : undefined,
      color_image: contentValue("color_image"),
      videoCoverUrl: contentValue("videoCoverUrl"),
      contentDiagnostics: contentValue("contentDiagnostics"),
      videoUrl: listingFirstText(variant.video, contentValue("videoUrl"), variant.video_url) || undefined,
      videoCover: listingFirstText(contentValue("videoCover"), variant.video_cover) || undefined,
      _sourceVariant: sourceVariant,
      _bundleItem: variant._bundleItem || sourceVariant._bundleItem || {},
      attributes: variantAttributes,
      complex_attributes: Array.isArray(variant.complex_attributes) ? variant.complex_attributes : [],
      bundleComplexAttrs: variant.bundleComplexAttrs || sourceVariant._bundleComplexAttrs || undefined,
      sourceCategory: Object.keys(sourceCategory).length
        ? structuredClone(sourceCategory)
        : undefined,
      barcode: listingFirstText(variant.barcode, isAnchor ? item.barcode : "") || undefined,
      description_category_id: descriptionCategoryId || undefined,
      type_id: typeId || undefined,
      weight,
      depth,
      width,
      height,
      weight_unit: "g",
      dimension_unit: "mm",
    };
  });
}
