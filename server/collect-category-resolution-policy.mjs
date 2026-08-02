import { createHash } from "node:crypto";

export const TAXONOMY_SCOPE_OZON_DEFAULT = "OZON:DEFAULT";

export const CATEGORY_RESOLUTION_STATUS = Object.freeze({
  WAITING_ENRICHMENT: "WAITING_ENRICHMENT",
  WAITING_STORE: "WAITING_STORE",
  QUEUED: "QUEUED",
  MATCHING: "MATCHING",
  MATCHED: "MATCHED",
  NEEDS_REVIEW: "NEEDS_REVIEW",
  RETRYABLE_ERROR: "RETRYABLE_ERROR",
  INVALIDATED: "INVALIDATED",
});

function positiveId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

function nodeEnabled(node) {
  return node?.disabled !== true
    && node?.is_disabled !== true
    && node?.isDisabled !== true
    && node?.enabled !== false
    && node?.is_enabled !== false
    && node?.isEnabled !== false;
}

function nodeKey({ descriptionCategoryId = 0, typeId = 0 } = {}) {
  return [descriptionCategoryId, typeId];
}

function normalizedNodes(tree) {
  const nodes = [];

  function visit(node, parent, inheritedDescriptionCategoryId = 0, inheritedEnabled = true) {
    if (!node || typeof node !== "object") return;
    const descriptionCategoryId = positiveId(node.description_category_id)
      || positiveId(node.descriptionCategoryId)
      || inheritedDescriptionCategoryId;
    const typeId = positiveId(node.type_id) || positiveId(node.typeId);
    const enabled = inheritedEnabled && nodeEnabled(node);
    const current = { descriptionCategoryId, typeId };
    if (descriptionCategoryId || typeId) {
      nodes.push({
        descriptionCategoryId,
        typeId,
        parent: nodeKey(parent),
        enabled,
      });
    }
    for (const child of Array.isArray(node.children) ? node.children : []) {
      visit(child, current, descriptionCategoryId, enabled);
    }
  }

  for (const node of Array.isArray(tree) ? tree : []) visit(node, { descriptionCategoryId: 0, typeId: 0 });
  return nodes;
}

function normalizeTaxonomy(tree) {
  return normalizedNodes(tree).sort((left, right) =>
    left.descriptionCategoryId - right.descriptionCategoryId
    || left.typeId - right.typeId
    || left.parent[0] - right.parent[0]
    || left.parent[1] - right.parent[1]
    || Number(left.enabled) - Number(right.enabled),
  );
}

export function taxonomyFingerprint(tree) {
  return createHash("sha256").update(JSON.stringify(normalizeTaxonomy(tree))).digest("hex");
}

function enabledLeafCandidates(tree, sourceTypeId) {
  const candidates = [];

  function visit(node, inheritedDescriptionCategoryId = 0, inheritedEnabled = true) {
    if (!node || typeof node !== "object") return;
    const descriptionCategoryId = positiveId(node.description_category_id)
      || positiveId(node.descriptionCategoryId)
      || inheritedDescriptionCategoryId;
    const typeId = positiveId(node.type_id) || positiveId(node.typeId);
    const enabled = inheritedEnabled && nodeEnabled(node);
    const children = Array.isArray(node.children) ? node.children : [];
    if (enabled && children.length === 0 && descriptionCategoryId && typeId === sourceTypeId) {
      candidates.push({ descriptionCategoryId, typeId });
    }
    for (const child of children) visit(child, descriptionCategoryId, enabled);
  }

  for (const node of Array.isArray(tree) ? tree : []) visit(node);
  return candidates.sort((left, right) =>
    left.descriptionCategoryId - right.descriptionCategoryId || left.typeId - right.typeId,
  );
}

export function resolveExactType({ tree, sourceTypeId } = {}) {
  const normalizedTypeId = Number(sourceTypeId);
  const candidates = enabledLeafCandidates(tree, normalizedTypeId);
  if (!Number(sourceTypeId)) return { kind: "NEEDS_REVIEW", reasonCode: "TYPE_MISSING" };
  if (candidates.length !== 1) {
    return {
      kind: "NEEDS_REVIEW",
      reasonCode: candidates.length ? "TYPE_AMBIGUOUS" : "TYPE_NOT_FOUND",
      candidates,
    };
  }
  return { kind: "MATCHED", ...candidates[0] };
}

export function nextResolution(current = {}, event = {}) {
  if (current?.status === CATEGORY_RESOLUTION_STATUS.MATCHED
    && current?.method === "MANUAL"
    && event?.type === "AUTO_MATCHED") {
    return structuredClone(current);
  }
  return structuredClone(event?.resolution ?? current);
}
