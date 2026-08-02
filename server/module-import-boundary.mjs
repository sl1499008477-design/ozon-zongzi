import { parse } from "acorn";

function importSpecifiers(source) {
  const program = parse(source, {
    allowHashBang: true,
    ecmaVersion: "latest",
    sourceType: "module",
  });
  const specifiers = [];
  const pending = [program];

  while (pending.length > 0) {
    const node = pending.pop();
    if (node.type === "ImportDeclaration" && typeof node.source?.value === "string") {
      specifiers.push(node.source.value);
    } else if (node.type === "ImportExpression"
      && node.source?.type === "Literal"
      && typeof node.source.value === "string") {
      specifiers.push(node.source.value);
    }

    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child.type === "string") pending.push(child);
        }
      } else if (value && typeof value.type === "string") {
        pending.push(value);
      }
    }
  }

  return specifiers;
}

function forbiddenCategoryResolutionSpecifier(specifier) {
  const suffixIndex = specifier.search(/[?#]/);
  const modulePath = suffixIndex === -1 ? specifier : specifier.slice(0, suffixIndex);
  return /(?:^|\/)collect-category-resolution-repository\.mjs$/i.test(modulePath)
    || /(?:^|\/)db\/.+$/i.test(modulePath);
}

export function assertCategoryResolutionPortBoundary(source, { label = "module" } = {}) {
  for (const specifier of importSpecifiers(String(source ?? ""))) {
    if (!forbiddenCategoryResolutionSpecifier(specifier)) continue;
    throw Object.assign(new Error(`${label} must use the category resolution Port`), {
      code: "CATEGORY_RESOLUTION_MODULE_BOUNDARY",
      specifier,
    });
  }
}
