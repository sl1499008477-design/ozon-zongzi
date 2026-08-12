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

const ACCOUNT_SHARED_CATEGORY_REPOSITORY_IMPORTERS = new Set([
  "server/account-shared-ozon-category-runtime.mjs",
]);

function categoryResolutionImportDisposition(specifier) {
  const suffixIndex = specifier.search(/[?#]/);
  const modulePath = suffixIndex === -1 ? specifier : specifier.slice(0, suffixIndex);
  if (/(?:^|\/)account-shared-ozon-category-repository\.mjs$/i.test(modulePath)) {
    return "ACCOUNT_SHARED_REPOSITORY";
  }
  if (/(?:^|\/)db\/.+$/i.test(modulePath)) return "DATABASE";
  return "ALLOWED";
}

export function assertCategoryResolutionPortBoundary(source, {
  label = "module",
  modulePath = "",
} = {}) {
  for (const specifier of importSpecifiers(String(source ?? ""))) {
    const disposition = categoryResolutionImportDisposition(specifier);
    if (disposition === "ALLOWED") continue;
    if (disposition === "ACCOUNT_SHARED_REPOSITORY"
      && ACCOUNT_SHARED_CATEGORY_REPOSITORY_IMPORTERS.has(String(modulePath))) continue;
    throw Object.assign(new Error(`${label} must use the category resolution Port`), {
      code: "CATEGORY_RESOLUTION_MODULE_BOUNDARY",
      specifier,
    });
  }
}
