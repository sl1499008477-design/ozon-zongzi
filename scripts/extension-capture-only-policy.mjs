import assert from "node:assert/strict";
import {
  REQUIRED_CAPTURE_ONLY_PERMISSIONS,
  REQUIRED_CAPTURE_ONLY_URLS,
  REVIEWED_CAPTURE_ONLY_CAPABILITIES,
} from "./extension-capture-only-baseline.mjs";

export const REQUIRED_CAPTURE_ONLY_FILES = Object.freeze([
  "background/collector-client.js",
  "background/collector-ozon-enrichment-agent.js",
  "background/collector-ozon-enrichment-client.js",
  "background/service-worker.js",
  "lib/collector-session.js",
  "lib/ozon-enrichment-contract.js",
  "popup/popup.html",
  "popup/popup.js",
  "tests/collector-ozon-enrichment-client.test.js",
  "tests/collector-session.test.js",
  "tests/ozon-enrichment-contract.test.js",
  "tests/sync-capability-removed.test.js",
]);

const SELLER_API_URLS = Object.freeze([
  "https://api-seller.ozon.ru/v3/product/info/list",
  "http://api-seller.ozon.ru/v2/posting/fbo/list",
]);

const REVIEWED_LOCAL_HOST_PERMISSIONS = new Set([
  "http://127.0.0.1:3000/*",
  "https://www.ozon.kz/*",
]);

const RETIRED_SYNC_FILE = /^(?:background\/sync\/|tests\/(?:postings-manual-sync-window|sync-state-watermark)\.test\.js$)/;
const RETIRED_SYNC_REFERENCE = /(?:sync\/(?:backend-client|diff-index|lease-client|opi-client|sync-engine|sync-state)\.js|api-seller\.ozon\.ru|\/ozon\/sync\/|\/local\/sync\/|sync-credentials|cache\/import-with-hash)/i;

export function chromeMatchPatternCovers(pattern, input) {
  if (pattern === "<all_urls>") {
    return ["http:", "https:", "file:", "ftp:"].includes(new URL(input).protocol);
  }
  const match = String(pattern).match(/^(\*|http|https):\/\/([^/]+)(\/.*)$/);
  if (!match) return false;
  const [, scheme, hostPattern] = match;
  const url = new URL(input);
  const schemeAllowed =
    scheme === "*"
      ? ["http:", "https:"].includes(url.protocol)
      : url.protocol === `${scheme}:`;
  if (!schemeAllowed) return false;

  const hostname = url.hostname.toLowerCase();
  const normalizedHostPattern = hostPattern
    .toLowerCase()
    .replace(/:\d+$/, "");
  const hostAllowed =
    normalizedHostPattern === "*"
    || (
      normalizedHostPattern.startsWith("*.")
      && (
        hostname === normalizedHostPattern.slice(2)
        || hostname.endsWith(`.${normalizedHostPattern.slice(2)}`)
      )
    )
    || hostname === normalizedHostPattern;
  return hostAllowed;
}

export function assertCaptureOnlyPermissionPolicy(localManifest, upstreamManifest) {
  const upstreamPermissions = new Set(upstreamManifest.permissions || []);
  for (const permission of localManifest.permissions || []) {
    assert.ok(
      upstreamPermissions.has(permission),
      `unreviewed extension permission: ${permission}`,
    );
  }

  const reviewedOptionalPermissions = new Set([
    ...(upstreamManifest.permissions || []),
    ...(upstreamManifest.optional_permissions || []),
  ]);
  for (const permission of localManifest.optional_permissions || []) {
    assert.ok(
      reviewedOptionalPermissions.has(permission),
      `unreviewed optional extension permission: ${permission}`,
    );
  }

  const localHostPermissions = [
    ...(localManifest.host_permissions || []),
    ...(localManifest.optional_host_permissions || []),
  ];
  for (const sellerApiUrl of SELLER_API_URLS) {
    assert.equal(
      localHostPermissions.some((pattern) =>
        chromeMatchPatternCovers(pattern, sellerApiUrl)),
      false,
      `extension host permissions must not cover Seller API: ${sellerApiUrl}`,
    );
  }

  const upstreamHosts = new Set(upstreamManifest.host_permissions || []);
  for (const permission of localManifest.host_permissions || []) {
    assert.ok(
      upstreamHosts.has(permission) || REVIEWED_LOCAL_HOST_PERMISSIONS.has(permission),
      `unreviewed extension host permission: ${permission}`,
    );
  }

  const reviewedOptionalHosts = new Set([
    ...(upstreamManifest.host_permissions || []),
    ...(upstreamManifest.optional_host_permissions || []),
  ]);
  for (const permission of localManifest.optional_host_permissions || []) {
    assert.ok(
      reviewedOptionalHosts.has(permission) || REVIEWED_LOCAL_HOST_PERMISSIONS.has(permission),
      `unreviewed optional extension host permission: ${permission}`,
    );
  }
}

export function assertReviewedCaptureOnlyPermissionPolicy(candidateManifest) {
  assertCaptureOnlyPermissionPolicy(
    candidateManifest,
    REVIEWED_CAPTURE_ONLY_CAPABILITIES,
  );

  const candidatePermissions = new Set(candidateManifest.permissions || []);
  for (const permission of REQUIRED_CAPTURE_ONLY_PERMISSIONS) {
    assert.ok(
      candidatePermissions.has(permission),
      `required capture-only permission missing: ${permission}`,
    );
  }

  const candidateHosts = candidateManifest.host_permissions || [];
  for (const requiredUrl of REQUIRED_CAPTURE_ONLY_URLS) {
    assert.ok(
      candidateHosts.some((pattern) =>
        chromeMatchPatternCovers(pattern, requiredUrl)),
      `required capture-only host access missing: ${requiredUrl}`,
    );
  }
}

export function assertCaptureOnlyFileSet(files) {
  const fileSet = new Set(files);
  for (const required of REQUIRED_CAPTURE_ONLY_FILES) {
    assert.ok(fileSet.has(required), `required capture-only file missing: ${required}`);
  }
  for (const file of fileSet) {
    assert.doesNotMatch(file, RETIRED_SYNC_FILE, `retired sync module packaged: ${file}`);
  }
}

export function assertPopupWebLoginGuidance(popupHtml, popupJs, serviceWorkerSource) {
  for (const guidance of [
    "请先登录 Web 管理后台，再使用采集功能",
    "前往登录",
    "重新检查",
  ]) {
    assert.match(popupHtml, new RegExp(guidance), `popup Web login guidance missing: ${guidance}`);
  }
  assert.match(
    popupJs,
    /sendMessage\(\{\s*action:\s*["']openFrontend["'],\s*path:\s*["']\/login["']\s*\}\)/,
    "popup must route Web login through openFrontend",
  );
  assert.doesNotMatch(
    popupJs,
    /chrome\.tabs\.create\(\{\s*url:\s*["']http:\/\/127\.0\.0\.1:3000\/login["']/,
    "popup must not create the Web login tab directly",
  );
  assert.match(
    serviceWorkerSource,
    /const\s+LOCAL_FRONTEND_BASE_URL\s*=\s*["']http:\/\/127\.0\.0\.1:3000["']/,
    "service worker local frontend base URL missing",
  );
  assert.match(
    serviceWorkerSource,
    /message\.path\.startsWith\(["']\/["']\)/,
    "openFrontend must accept only a leading-slash path",
  );
  assert.match(
    serviceWorkerSource,
    /:\s*`https:\/\/\$\{BRAND_WEB_HOST\}`/,
    "service worker hosted frontend base URL missing",
  );
  assert.match(
    serviceWorkerSource,
    /const\s+url\s*=\s*`\$\{frontendBase\}\$\{path\}`/,
    "service worker must construct the trusted frontend URL",
  );
  assert.match(
    serviceWorkerSource,
    /data:\s*await\s+openFrontendTab\(\{\s*url\s*\}\)/,
    "openFrontend must delegate the trusted URL to the frontend tab opener",
  );
  assert.doesNotMatch(
    `${popupHtml}\n${popupJs}`,
    /账号登录|短信登录|login-password|getStores|checkSellerCookies|syncSellerCookies/,
    "popup must not expose retired extension/Seller login flows",
  );
}

export function assertCaptureOnlyServiceWorker(serviceWorkerSource) {
  assert.match(serviceWorkerSource, /\.\.\/lib\/collector-session\.js/);
  assert.match(
    serviceWorkerSource,
    /collector-client\.js/,
    "Collector client dependency missing from service worker",
  );
  assert.match(
    serviceWorkerSource,
    /\.\.\/lib\/ozon-enrichment-contract\.js/,
    "Ozon enrichment contract dependency missing from service worker",
  );
  assert.match(
    serviceWorkerSource,
    /collector-ozon-enrichment-agent\.js/,
    "Collector Ozon agent dependency missing from service worker",
  );
  assert.match(
    serviceWorkerSource,
    /collector-ozon-enrichment-client\.js/,
    "Collector Ozon client dependency missing from service worker",
  );
  assert.doesNotMatch(
    serviceWorkerSource,
    RETIRED_SYNC_REFERENCE,
    "packaged service worker must start capture-only",
  );
}
