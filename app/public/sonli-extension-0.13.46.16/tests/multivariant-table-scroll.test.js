const assert = require("assert");
const fs = require("fs");
const path = require("path");

const extensionRoot = path.resolve(__dirname, "..");
const productJs = fs.readFileSync(path.join(extensionRoot, "content", "ozon-product.js"), "utf8");
const productCss = fs.readFileSync(path.join(extensionRoot, "content", "ozon-product.css"), "utf8");

assert(
  productJs.includes("function jzFitMultiVariantTableViewport"),
  "multi-variant modal should dynamically fit the variant table to the visible viewport",
);

assert(
  productJs.includes("jzScheduleMultiVariantTableFit(panel)") &&
    productJs.includes("window.addEventListener('resize', jzScheduleFit") &&
    productJs.includes("mvBody.addEventListener('scroll', jzScheduleFit"),
  "multi-variant modal should refit the table when opened, resized, or vertically scrolled",
);

assert(
  productJs.includes("previousPanel._jzCleanup?.()"),
  "multi-variant modal should clean viewport-fit listeners when replacing an existing panel",
);

assert(
  !productJs.includes("ozon-helper-mv-xscroll-proxy") &&
    !productJs.includes("function jzBindMultiVariantHorizontalScrollbar"),
  "multi-variant modal should not add a separate top horizontal scrollbar",
);

assert(
  !productCss.includes(".ozon-helper-mv-xscroll-proxy") &&
    !productCss.includes(".ozon-helper-mv-xscroll-spacer"),
  "top horizontal scrollbar proxy styles should not exist",
);

assert(
  productCss.includes("--oh-mv-table-max-height"),
  "variant table wrap should expose a CSS max-height variable controlled by the modal layout fit",
);

assert(
  productCss.includes("max-height: var(--oh-mv-table-max-height, min(52vh, 560px))"),
  "variant table wrap should use the early-visible horizontal scrollbar fallback height",
);

assert(
  productCss.includes(".ozon-helper-mv-card-table .ozon-helper-mv-table tbody td") &&
    productCss.includes("padding: 5px 10px"),
  "variant table rows should use compact padding so more products remain visible above the scrollbar",
);

assert(
  productCss.includes(".ozon-helper-mv-card-table .ozon-helper-mv-table .ozon-helper-mv-thumb") &&
    productCss.includes("width: 44px") &&
    productCss.includes("height: 44px"),
  "variant table thumbnails should use compact sizing for a denser visible row count",
);

assert(
  productJs.includes("const tableRect = tableWrap.getBoundingClientRect()") &&
    productJs.includes("visibleBottom - tableRect.top - 12") &&
    productJs.includes("window.innerHeight * (expandedDensity ? 0.82 : 0.72)") &&
    productJs.includes("expandedDensity ? 820 : 720"),
  "variant table fit should keep the real bottom scrollbar above the footer and move it as the body scrolls",
);

assert(
  productJs.includes("panel.dataset.variantDensity = variants.length >= 6 ? 'expanded' : 'normal'"),
  "multi-variant panel should only enter expanded height mode when it has at least six variants",
);

assert(
  productJs.includes("function jzUpdateMultiVariantDensity(panel)") &&
    productJs.includes("tbody.querySelectorAll('tr').length") &&
    productJs.includes("panel.dataset.variantDensity = rowCount >= 6 ? 'expanded' : 'normal'") &&
    productJs.includes("jzUpdateMultiVariantDensity(panel);"),
  "multi-variant panel should re-detect expanded height mode from rendered table rows after async variant expansion",
);

assert(
  productJs.includes("const expandedDensity = panel.dataset.variantDensity === 'expanded'") &&
    productJs.includes("window.innerHeight * (expandedDensity ? 0.82 : 0.72)") &&
    productJs.includes("expandedDensity ? 820 : 720"),
  "expanded variant panels should get a larger viewport-fit cap without changing smaller panels",
);

assert(
  productCss.includes('.ozon-helper-multivariant-panel[data-variant-density="expanded"] .ozon-helper-mv-dialog') &&
    productCss.includes("max-height: 96vh"),
  "expanded variant panels should slightly increase total dialog height",
);

assert(
  productCss.includes('.ozon-helper-multivariant-panel[data-variant-density="expanded"] .ozon-helper-mv-dialog-v2 .ozon-helper-mv-body > .ozon-helper-mv-card.ozon-helper-mv-card-table') &&
    productCss.includes("min-height: min(540px, 74vh)"),
  "expanded variant panels should reserve enough table-card height for about six visible variants",
);

assert(
  !productCss.includes("min-height: min(580px, 72vh)"),
  "variant table card must not fall back to the old oversized 580px layout",
);

assert(
  productCss.includes("min-height: min(420px, 60vh)"),
  "variant table card should use the early-visible layout instead of forcing the scrollbar below the footer",
);

assert(
  productJs.includes('data-action="copy-skus"') &&
    productJs.includes('data-action="copy-offerids"'),
  "multi-variant table headers should expose one-click copy actions for SKU and offer ID",
);

assert(
  productJs.includes("function jzBuildMultiVariantCopyText(panel, field)") &&
    productJs.includes("jzCollectVisibleMultiVariantCopyRows(panel)") &&
    productJs.includes("row.getAttribute('data-sku')") &&
    productJs.includes(".ozon-helper-mv-offerid"),
  "copy actions should build newline-separated lines from visible variants",
);

assert(
  productJs.includes("return id;") &&
    !productJs.includes("return `${id}\\t${price}`;") &&
    !productJs.includes("const price = jzReadMultiVariantInputValue(row, '.ozon-helper-mv-price');"),
  "copy actions should copy only SKU or offer ID and must not append price",
);

assert(
  productJs.includes("jzShowMultiVariantCopyToast(panel, '一键复制成功')") &&
    productJs.includes("setTimeout(closeToast, 1000)"),
  "copy success feedback should auto-dismiss after one second",
);
