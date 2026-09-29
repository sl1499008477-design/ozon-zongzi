const LISTING_ONLY_ATTRIBUTE_IDS = new Set([
  "85", "4180", "4191", "4194", "4195", "4389", "4497", "7822", "8790",
  "9024", "9048", "9454", "9455", "9456", "10400", "11254", "11650",
  "22232", "22390", "23171", "23249", "23379", "23380", "23524", "23536",
]);

const LISTING_ONLY_COPY = /(?:название модели\s*\(\s*для объединения в одну карточку\s*\)|объединить в похожие товары|код продавца|артикул(?: продавца)?|количеств[оа] заводских упаковок|количество товара в уеи|нужен код маркировки|страна[- ]изготовитель|хештег|таможенн|тн\s*вэд|штрихкод|rich\s*content|богатый контент|гаранти|сертификац|медицинск)/iu;
const CREATIVE_UNSAFE_COPY = Object.freeze([
  /(?:https?|ftp|file|data):\/\//iu,
  /www\./iu,
  /(?<![\p{L}\p{N}])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+[A-Za-z]{2,63}(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])(?:price|цена|скидк\p{L}*|акци\p{L}*|sale|промокод)(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])\d{1,3}\s*%(?![\p{L}\p{N}])/u,
  /\b[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[A-Za-z]{2,}\b/iu,
  /(?<![\p{L}\p{N}])(?:\+?7|8)[\s()-]*\d{3}[\s()-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?![\p{L}\p{N}])/u,
  /(?<![\p{L}\p{N}])(?:\+\d{1,3}|00\d{1,3})[\s().-]*\d(?:[\s().-]*\d){6,14}(?![\p{L}\p{N}])/u,
  /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|password|secret)\b\s*[:=]/iu,
  /\bbearer\b(?:\s+|\s*[:=]\s*)[A-Za-z0-9._~+/=-]{8,}/iu,
]);
const SOURCE_IMAGE_UNSAFE_FACT_KINDS = new Set([
  "CERTIFICATION", "WARRANTY", "EXTERNAL_OVERLAY", "PROMOTION", "FORBIDDEN_TEXT",
  "PRICE", "DISCOUNT", "SALE", "RANK", "SELLER", "SHOP", "CONTACT", "URL", "QR",
  "MEDICAL", "SAFETY", "COMPATIBILITY", "THIRD_PARTY",
]);

const attributeIdFromFact = (fact) => String(fact?.factId || "")
  .match(/^fact\.attribute\.([^.]+)\./u)?.[1] || null;

export function isAutoListingCreativeAttributeId(attributeId) {
  return typeof attributeId === "string" && attributeId.length > 0
    && !LISTING_ONLY_ATTRIBUTE_IDS.has(attributeId);
}

export function isAutoListingCreativeFact(fact) {
  if (SOURCE_IMAGE_UNSAFE_FACT_KINDS.has(String(fact?.kind || ""))) return false;
  const text = `${String(fact?.kind || "")} ${String(fact?.value || "")}`;
  if (CREATIVE_UNSAFE_COPY.some((rule) => rule.test(text))) return false;
  if (LISTING_ONLY_COPY.test(text)) return false;
  const attributeId = attributeIdFromFact(fact);
  if (attributeId && !isAutoListingCreativeAttributeId(attributeId)) return false;
  if (!attributeId && !String(fact?.kind || "").startsWith("ATTRIBUTE:")) return true;
  return true;
}
