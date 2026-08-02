const STATIC_FROM_IMPORT = /\bimport[\s\S]*?\bfrom\s*["']([^"']+)["']/g;
const SIDE_EFFECT_IMPORT = /\bimport\s*["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function forbiddenCategoryResolutionSpecifier(specifier) {
  return /(?:^|\/)collect-category-resolution-repository\.mjs$/i.test(specifier)
    || /(?:^|\/)db\/.+$/i.test(specifier);
}

export function assertCategoryResolutionPortBoundary(source, { label = "module" } = {}) {
  const moduleSource = String(source ?? "");
  for (const pattern of [STATIC_FROM_IMPORT, SIDE_EFFECT_IMPORT, DYNAMIC_IMPORT]) {
    for (const match of moduleSource.matchAll(pattern)) {
      const specifier = match[1];
      if (!forbiddenCategoryResolutionSpecifier(specifier)) continue;
      throw Object.assign(new Error(`${label} must use the category resolution Port`), {
        code: "CATEGORY_RESOLUTION_MODULE_BOUNDARY",
        specifier,
      });
    }
  }
}
