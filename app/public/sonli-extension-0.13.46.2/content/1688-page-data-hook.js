/**
 * Runs in the page MAIN world so the isolated 1688 scraper can read page-owned
 * globals such as window.__INIT_DATA__ without moving extension API calls into
 * the page world.
 */
(() => {
  if (window.__JZC_1688_PAGE_DATA_HOOK__) return;
  window.__JZC_1688_PAGE_DATA_HOOK__ = true;

  const SOURCE = "jzc-1688-page-data-hook";
  const REQUEST_SOURCE = "jzc-1688-scraper";
  const RESPONSE_TYPE = "JZC_1688_PAGE_DATA";
  const REQUEST_TYPE = "JZC_1688_REQUEST_PAGE_DATA";
  const GLOBAL_KEYS = [
    "__INIT_DATA__",
    "detailData",
    "runParams",
    "__detail_data__",
    "offerDetail",
    "pageData",
    "offerInfo",
    "__INIT__",
    "hummerData",
  ];

  function cloneJson(value) {
    if (!value || typeof value !== "object") return null;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return null;
    }
  }

  function readGlobals() {
    const globals = {};
    for (const key of GLOBAL_KEYS) {
      try {
        const cloned = cloneJson(window[key]);
        if (cloned) globals[key] = cloned;
      } catch {}
    }
    return globals;
  }

  function readJsonLd() {
    const out = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
      try {
        const data = JSON.parse(script.textContent || "");
        if (data) out.push(data);
      } catch {}
    });
    return out;
  }

  function postPageData() {
    window.postMessage(
      {
        source: SOURCE,
        type: RESPONSE_TYPE,
        payload: {
          globals: readGlobals(),
          jsonLd: readJsonLd(),
        },
      },
      "*",
    );
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const message = event.data || {};
    if (message.source !== REQUEST_SOURCE || message.type !== REQUEST_TYPE) return;
    postPageData();
  });

  setTimeout(postPageData, 0);
  setTimeout(postPageData, 800);
})();
