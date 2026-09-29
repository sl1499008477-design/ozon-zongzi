import { createHash } from "node:crypto";
import { types } from "node:util";

export const TAXONOMY_SCOPE_OZON_DEFAULT = "OZON:DEFAULT";

const MAX_TAXONOMY_NODES = 10_000;
const MAX_TAXONOMY_DEPTH = 128;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function invalidTaxonomy() {
  return Object.assign(new TypeError("Ozon taxonomy input is invalid"), {
    code: "ZONGZI_TAXONOMY_CONTRACT_INVALID",
  });
}

function positiveId(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : 0;
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) return 0;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : 0;
}

function dataDescriptors(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalidTaxonomy();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || DANGEROUS_KEYS.has(key)
      || descriptors[key].get || descriptors[key].set) throw invalidTaxonomy();
  }
  return descriptors;
}

function dataArray(value) {
  if (!Array.isArray(value) || types.isProxy(value) || value.length > MAX_TAXONOMY_NODES) {
    throw invalidTaxonomy();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  let elements = 0;
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (descriptor.get || descriptor.set) throw invalidTaxonomy();
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key)
      || Number(key) >= value.length || descriptor.enumerable !== true) throw invalidTaxonomy();
    elements += 1;
  }
  if (elements !== value.length) throw invalidTaxonomy();
  return descriptors;
}

function descriptorValue(descriptors, ...keys) {
  for (const key of keys) {
    if (Object.hasOwn(descriptors, key)) return descriptors[key].value;
  }
  return undefined;
}

function nodeEnabled(descriptors) {
  return descriptorValue(descriptors, "disabled") !== true
    && descriptorValue(descriptors, "is_disabled") !== true
    && descriptorValue(descriptors, "isDisabled") !== true
    && descriptorValue(descriptors, "enabled") !== false
    && descriptorValue(descriptors, "is_enabled") !== false
    && descriptorValue(descriptors, "isEnabled") !== false;
}

function normalizedNodes(tree) {
  const roots = dataArray(tree);
  const seen = new WeakSet();
  const nodes = [];
  const pending = [];
  let visitedNodes = 0;
  for (let index = tree.length - 1; index >= 0; index -= 1) {
    pending.push({
      node: roots[String(index)].value,
      parent: [0, 0],
      inheritedDescriptionCategoryId: 0,
      inheritedEnabled: true,
      depth: 1,
    });
  }

  while (pending.length) {
    const current = pending.pop();
    if (current.depth > MAX_TAXONOMY_DEPTH || visitedNodes >= MAX_TAXONOMY_NODES
      || seen.has(current.node)) throw invalidTaxonomy();
    const descriptors = dataDescriptors(current.node);
    seen.add(current.node);
    visitedNodes += 1;
    const descriptionCategoryId = positiveId(descriptorValue(
      descriptors, "description_category_id", "descriptionCategoryId",
    )) || current.inheritedDescriptionCategoryId;
    const typeId = positiveId(descriptorValue(descriptors, "type_id", "typeId"));
    const enabled = current.inheritedEnabled && nodeEnabled(descriptors);
    const childrenValue = Object.hasOwn(descriptors, "children")
      ? descriptors.children.value
      : [];
    const children = dataArray(childrenValue);
    const normalized = {
      descriptionCategoryId,
      typeId,
      parent: current.parent,
      enabled,
      leaf: childrenValue.length === 0,
    };
    if (descriptionCategoryId || typeId) nodes.push(normalized);
    const parent = [descriptionCategoryId, typeId];
    for (let index = childrenValue.length - 1; index >= 0; index -= 1) {
      pending.push({
        node: children[String(index)].value,
        parent,
        inheritedDescriptionCategoryId: descriptionCategoryId,
        inheritedEnabled: enabled,
        depth: current.depth + 1,
      });
    }
  }
  return nodes;
}

function normalizeTaxonomy(tree) {
  return normalizedNodes(tree).map(({ leaf: _leaf, ...node }) => node).sort((left, right) =>
    left.descriptionCategoryId - right.descriptionCategoryId
    || left.typeId - right.typeId
    || left.parent[0] - right.parent[0]
    || left.parent[1] - right.parent[1]
    || Number(left.enabled) - Number(right.enabled),
  );
}

export function taxonomyFingerprint(tree) {
  try {
    return createHash("sha256").update(JSON.stringify(normalizeTaxonomy(tree))).digest("hex");
  } catch (error) {
    if (error?.code === "ZONGZI_TAXONOMY_CONTRACT_INVALID") throw error;
    throw invalidTaxonomy();
  }
}

export function enabledLeafCandidates(tree, sourceTypeId = null) {
  try {
    const normalizedTypeId = sourceTypeId === null ? null : positiveId(sourceTypeId);
    const candidates = normalizedNodes(tree)
      .filter((node) => node.enabled && node.leaf && node.descriptionCategoryId && node.typeId
        && (normalizedTypeId === null || node.typeId === normalizedTypeId))
      .map((node) => Object.freeze({
        descriptionCategoryId: node.descriptionCategoryId,
        typeId: node.typeId,
      }));
    candidates.sort((left, right) =>
      left.descriptionCategoryId - right.descriptionCategoryId || left.typeId - right.typeId,
    );
    return Object.freeze(candidates);
  } catch (error) {
    if (error?.code === "ZONGZI_TAXONOMY_CONTRACT_INVALID") throw error;
    throw invalidTaxonomy();
  }
}

function exactTypeInput(input) {
  const descriptors = dataDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== 2 || !Object.hasOwn(descriptors, "tree")
    || !Object.hasOwn(descriptors, "sourceTypeId")
    || descriptors.tree.enumerable !== true
    || descriptors.sourceTypeId.enumerable !== true) throw invalidTaxonomy();
  return {
    tree: descriptors.tree.value,
    sourceTypeId: descriptors.sourceTypeId.value,
  };
}

export function resolveExactType(input = {}) {
  const { tree, sourceTypeId } = exactTypeInput(input);
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
