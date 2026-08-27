/**
 * CDN 历史污染兜底 helper — Chrome extension 版。
 *
 * 等价于 frontend/lib/cdn-buster.ts,但 extension 不在 Next.js 体系,通过
 * importScripts(SW)/ content_scripts 数组(content script)加载,挂到
 * `globalThis.JzCdnBuster` 命名空间共享。
 *
 * 详细背景与开关时机参考 frontend/lib/cdn-buster.ts 头注释。
 * 改这里时请同步 frontend/lib/cdn-buster.ts(及 Tauri 注入脚本里的内联 const)。
 */
(function () {
  const CDN_BUSTER_ENABLED = true;
  const CDN_CLEAR_VERSION = "v1";

  function withCdnBuster(url) {
    if (!CDN_BUSTER_ENABLED) return url;
    return url + (url.includes("?") ? "&" : "?") + "_t=" + Date.now();
  }

  globalThis.JzCdnBuster = {
    CDN_BUSTER_ENABLED,
    CDN_CLEAR_VERSION,
    CLEAR_CACHE_FLAG_KEY: "jz-cdn-cache-cleared-" + CDN_CLEAR_VERSION,
    withCdnBuster,
  };
})();
