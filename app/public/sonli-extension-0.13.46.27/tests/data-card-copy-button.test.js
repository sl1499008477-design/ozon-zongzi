const assert = require("assert");
const fs = require("fs");
const path = require("path");

const extensionRoot = path.resolve(__dirname, "..");
const sharedUtils = fs.readFileSync(path.join(extensionRoot, "content", "shared-utils.js"), "utf8");
const ozonProduct = fs.readFileSync(path.join(extensionRoot, "content", "ozon-product.js"), "utf8");

const sharedBindCalls = (sharedUtils.match(/window\.jzBindDataCardCopyButtons\(panel\)/g) || []).length;

assert(
  sharedUtils.includes("window.jzSafeCopyText"),
  "shared data cards should expose a safe clipboard helper",
);
assert(
  sharedUtils.includes("navigator.clipboard && window.isSecureContext"),
  "safe clipboard helper should prefer navigator.clipboard in secure contexts",
);
assert(
  sharedUtils.includes("ta.focus()") && sharedUtils.includes("ta.setSelectionRange(0, value.length)"),
  "safe clipboard fallback should focus and select the hidden textarea",
);
assert(
  sharedUtils.includes("window.jzBindDataCardCopyButtons"),
  "shared data cards should expose a reusable copy-button binder",
);
assert(
  sharedUtils.includes("closest?.('.ozon-helper-copy-btn')") ||
    sharedUtils.includes("closest('.ozon-helper-copy-btn')"),
  "copy handler should work when clicking the icon inside a copy button",
);
assert(
  sharedUtils.includes("e.stopImmediatePropagation?.()"),
  "copy handler should stop row/card click handlers from stealing the click",
);
assert(
  sharedBindCalls >= 2,
  "both shared data-card renderers should bind copy buttons",
);
assert(
  sharedUtils.includes("btn.innerHTML = btn.dataset.copyIcon"),
  "copy buttons should restore the original icon after feedback",
);
assert(
  ozonProduct.includes("window.jzSafeCopyText(text)"),
  "product detail copy helper should delegate to the shared safe clipboard helper",
);
assert(
  ozonProduct.includes("window.jzBindDataCardCopyButtons(card)"),
  "product detail data cards should use the shared copy button binder",
);
assert(
  ozonProduct.includes("const valueText = String(r.value == null ? '' : r.value)") &&
    ozonProduct.includes("_escHtml(valueText)"),
  "product detail copy values should be HTML-escaped before entering attributes",
);
assert(
  !ozonProduct.includes("data-copy=\"' + r.value + '\""),
  "product detail data-copy attributes should not inject raw row values",
);
assert(
  !ozonProduct.includes("setTimeout(() => { btn.textContent"),
  "copy feedback should restore the icon markup, not replace it with plain text",
);

console.log("data card copy button test passed");
