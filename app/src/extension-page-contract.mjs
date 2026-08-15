export const EXTENSION_VERSION = "0.13.46.3";
export const EXTENSION_DOWNLOAD_PATH =
  `/sonli-extension-${EXTENSION_VERSION}.zip`;
export const EXTENSION_POPUP_PREVIEW_PATH =
  `/sonli-extension-${EXTENSION_VERSION}/popup/popup.html`;

const capability = (label, file) => Object.freeze([label, file]);

export const EXTENSION_CAPABILITIES = Object.freeze([
  capability("Ozon 商品采集", "content/ozon-product.js"),
  capability("Ozon 搜索采集", "content/ozon-search.js"),
  capability("Seller 页面采集桥", "content/ozon-seller-bridge.js"),
  capability("1688 商品采集", "content/alibaba-1688.js"),
  capability("批量上架页", "batch-upload/index.html"),
  capability("采集会话与上传调度", "background/service-worker.js"),
]);
