(function () {
  if (window.__JZC_CN_SOURCE_DEBUG__) return;

  const PAGE_SOURCE = "jzc-cn-source-debug-page";
  const BRIDGE_SOURCE = "jzc-cn-source-debug-bridge";
  const REQUEST_TYPE = "JZC_CN_SOURCE_DEBUG_REQUEST";
  const RESPONSE_TYPE = "JZC_CN_SOURCE_DEBUG_RESPONSE";

  window.__JZC_CN_SOURCE_DEBUG__ = () => new Promise((resolve) => {
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve({ raw: null, error: "debug bridge timeout" });
    }, 3000);

    function onMessage(event) {
      const data = event.data || {};
      if (data.source !== BRIDGE_SOURCE || data.type !== RESPONSE_TYPE || data.requestId !== requestId) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(data.payload);
    }

    window.addEventListener("message", onMessage);
    window.postMessage({ source: PAGE_SOURCE, type: REQUEST_TYPE, requestId }, "*");
  });
})();
