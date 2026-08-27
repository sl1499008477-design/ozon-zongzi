const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const contentScript = fs.readFileSync(path.join(root, "content", "ozon-product.js"), "utf8");
const serviceWorker = fs.readFileSync(path.join(root, "background", "service-worker.js"), "utf8");

assert(
  contentScript.includes("jzCollectOzonRichContentPagePaths"),
  "current-page collection must follow Ozon paginator.nextPage rich-content pages",
);
assert(
  serviceWorker.includes("collectOzonRichContentPagePaths"),
  "buyer-tab batch collection must follow Ozon paginator.nextPage rich-content pages",
);
assert(
  contentScript.includes("pdpPage2column") && serviceWorker.includes("pdpPage2column"),
  "both rich-content collectors must target Ozon pdpPage2column page-json",
);
assert(
  contentScript.includes("jzOzonProductId") && serviceWorker.includes("ozonProductId"),
  "nextPage filtering must compare Ozon product numeric ids so batch /product/{sku} paths match slugged PDP paths",
);
assert(
  !contentScript.includes("if (out.length > 0) return { images: out, richContent };"),
  "current-page gallery collection must not return after images before full rich content is checked",
);
assert(
  !contentScript.includes("jzWaitForDomRichContent") &&
    !contentScript.includes("extractOzonRichContentFromDocument"),
  "rich-content collection must not depend on rendered DOM fallback",
);
assert(
  !contentScript.includes("copyableDescription") && !serviceWorker.includes("copyableDescription"),
  "rich-content collection must not rebuild attribute 11254 from copyableDescription",
);
assert(
  contentScript.includes("richContentHasText") && serviceWorker.includes("richContentHasText"),
  "both collectors must keep searching when the first richAnnotationJson is image-only",
);
assert(
  contentScript.includes("!jzRichContentHasText(rc)") &&
    contentScript.includes("window.location.pathname + window.location.search"),
  "current-page cached state must still fetch page-json when cached rich content has no text",
);

console.log("ozon rich content page-json test passed");
