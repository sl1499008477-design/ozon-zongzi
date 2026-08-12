import { createHash } from "node:crypto";

export const TAXONOMY_SCOPE_OZON_DEFAULT = "OZON:DEFAULT";

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
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
  const active = new WeakSet();

  function visit(node, parent, inheritedDescriptionCategoryId = 0, inheritedEnabled = true) {
    if (!node || typeof node !== "object" || active.has(node)) return;
    active.add(node);
    const descriptionCategoryId = positiveId(node.description_category_id)
      || positiveId(node.descriptionCategoryId)
      || inheritedDescriptionCategoryId;
    const typeId = positiveId(node.type_id) || positiveId(node.typeId);
    const enabled = inheritedEnabled && nodeEnabled(node);
    const current = { descriptionCategoryId, typeId };
    if (descriptionCategoryId || typeId) {
      nodes.push({ descriptionCategoryId, typeId, parent: nodeKey(parent), enabled });
    }
    for (const child of Array.isArray(node.children) ? node.children : []) {
      visit(child, current, descriptionCategoryId, enabled);
    }
    active.delete(node);
  }

  for (const node of Array.isArray(tree) ? tree : []) {
    visit(node, { descriptionCategoryId: 0, typeId: 0 });
  }
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

export function enabledLeafCandidates(tree, sourceTypeId = null) {
  const candidates = [];
  const active = new WeakSet();
  const normalizedTypeId = sourceTypeId === null ? null : positiveId(sourceTypeId);

  function visit(node, inheritedDescriptionCategoryId = 0, inheritedEnabled = true) {
    if (!node || typeof node !== "object" || active.has(node)) return;
    active.add(node);
    const descriptionCategoryId = positiveId(node.description_category_id)
      || positiveId(node.descriptionCategoryId)
      || inheritedDescriptionCategoryId;
    const typeId = positiveId(node.type_id) || positiveId(node.typeId);
    const enabled = inheritedEnabled && nodeEnabled(node);
    const children = Array.isArray(node.children) ? node.children : [];
    if (enabled && children.length === 0 && descriptionCategoryId && typeId
      && (normalizedTypeId === null || typeId === normalizedTypeId)) {
      candidates.push(Object.freeze({ descriptionCategoryId, typeId }));
    }
    for (const child of children) visit(child, descriptionCategoryId, enabled);
    active.delete(node);
  }

  for (const node of Array.isArray(tree) ? tree : []) visit(node);
  candidates.sort((left, right) =>
    left.descriptionCategoryId - right.descriptionCategoryId || left.typeId - right.typeId,
  );
  return Object.freeze(candidates);
}

export function resolveExactType({ tree, sourceTypeId } = {}) {
  const normalizedTypeId = positiveId(sourceTypeId);
  if (!normalizedTypeId) return Object.freeze({ kind: "NEEDS_REVIEW", reasonCode: "TYPE_MISSING" });
  const rawCandidates = enabledLeafCandidates(tree, normalizedTypeId);
  const unique = [];
  const keys = new Set();
  let duplicate = false;
  for (const candidate of rawCandidates) {
    const key = `${candidate.descriptionCategoryId}:${candidate.typeId}`;
    if (keys.has(key)) duplicate = true;
    else {
      keys.add(key);
      unique.push(candidate);
    }
  }
  const candidates = Object.freeze(unique);
  if (duplicate) {
    return Object.freeze({ kind: "NEEDS_REVIEW", reasonCode: "TYPE_DUPLICATE", candidates });
  }
  if (candidates.length !== 1) {
    return Object.freeze({
      kind: "NEEDS_REVIEW",
      reasonCode: candidates.length ? "TYPE_AMBIGUOUS" : "TYPE_NOT_FOUND",
      candidates,
    });
  }
  return Object.freeze({ kind: "UNIQUE_MATCH", ...candidates[0] });
}
