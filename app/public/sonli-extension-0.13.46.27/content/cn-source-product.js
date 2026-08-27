(function () {
  if (window.__JZC_CN_SOURCE_PRODUCT_INJECTED__) return;
  window.__JZC_CN_SOURCE_PRODUCT_INJECTED__ = true;

  function mountWhenReady() {
    const scraper = window.JZCnSourceScraper;
    const panel = window.JZCnSourcePanel;
    if (!scraper || !panel) return;
    const platform = scraper.detectPlatform();
    if (!platform) return;

    panel.mount({
      platform,
      buildPayload: () => scraper.buildPayload(platform),
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountWhenReady, { once: true });
  } else {
    mountWhenReady();
  }

  setTimeout(mountWhenReady, 800);
})();
