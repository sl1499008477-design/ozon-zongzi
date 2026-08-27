const assert = require("assert");
const path = require("path");

function loadPlaywright() {
  try {
    return require("playwright");
  } catch {}

  return require(path.join(__dirname, "..", "..", "backend", "node_modules", "playwright"));
}

const { chromium } = loadPlaywright();
const scriptPath = path.join(__dirname, "..", "content", "1688-image-search.js");

async function withImageSearchPage(fn, options = {}) {
  const openResultOnClick = options.openResultOnClick !== false;
  const ignoredClicksBeforeResult = options.ignoredClicksBeforeResult || 0;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.__pageErrors = [];
  page.on("pageerror", (err) => page.__pageErrors.push(err.message));
  const imageUrl = "https://ir-21.ozonru.cn/s3/multimedia-1-7/12030447355.jpg";
  const targetUrl =
    options.entryUrl ||
    "https://s.1688.com/youyuan/index.htm?tab=imageSearch&__jzcOzonImg=" +
      encodeURIComponent(imageUrl);
  const mainBridgeImageId = options.mainBridgeImageId || null;
  const mainBridgeAttemptsBeforeSuccess = options.mainBridgeAttemptsBeforeSuccess || 0;
  const mainBridgeFailureDelayMs = options.mainBridgeFailureDelayMs || 0;

  const fulfillImageSearchPage = async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `
        <!doctype html>
        <html>
          <head>
            <title>1688 image search test</title>
            <style>
              body { margin: 0; font-family: sans-serif; }
              .image-file-reader-wrapper { display: block; margin: 24px; }
              .floating-card { display: block; margin: 24px; }
              .complex-search-button { display: inline-flex; cursor: pointer; }
            </style>
          </head>
          <body>
            <input title type="file" accept=".jpg,.jpeg,.png,.bmp,.webp" multiple class="image-file-reader-wrapper" id="img-search-upload">
            <script>
              window.__searchClicked = false;
              window.__searchClickCount = 0;
              window.__fileCount = 0;
              window.__bridgeUploadRequest = null;
              window.__bridgeUploadRequests = [];
              window.__openResultOnClick = ${openResultOnClick};
              window.__ignoredClicksBeforeResult = ${ignoredClicksBeforeResult};
              ${mainBridgeImageId ? `
              window.addEventListener("message", (event) => {
                const data = event.data || {};
                if (data.source !== "jzc-1688-image-search" || data.type !== "JZC_1688_UPLOAD_IMAGE_ID") return;
                window.__bridgeUploadRequest = {
                  requestId: data.requestId,
                  type: data.type,
                  hasDataUrl: String(data.dataUrl || "").startsWith("data:image/"),
                };
                window.__bridgeUploadRequests.push(window.__bridgeUploadRequest);
                sessionStorage.setItem("__bridgeUploadRequest", JSON.stringify(window.__bridgeUploadRequest));
                sessionStorage.setItem("__bridgeUploadRequests", JSON.stringify(window.__bridgeUploadRequests));
                const respond = () => {
                  if (window.__bridgeUploadRequests.length <= ${mainBridgeAttemptsBeforeSuccess}) {
                    window.postMessage({
                      source: "jzc-1688-image-search-main",
                      type: "JZC_1688_UPLOAD_IMAGE_ID_RESULT",
                      requestId: data.requestId,
                      ok: false,
                      error: "simulated imageId failure",
                    }, "*");
                    return;
                  }
                  window.postMessage({
                    source: "jzc-1688-image-search-main",
                    type: "JZC_1688_UPLOAD_IMAGE_ID_RESULT",
                    requestId: data.requestId,
                    ok: true,
                    imageId: "${mainBridgeImageId}",
                  }, "*");
                };
                if (${mainBridgeFailureDelayMs} > 0 && window.__bridgeUploadRequests.length <= ${mainBridgeAttemptsBeforeSuccess}) {
                  setTimeout(respond, ${mainBridgeFailureDelayMs});
                } else {
                  respond();
                }
              });
              ` : ""}
              document.getElementById("img-search-upload").addEventListener("change", (event) => {
                window.__fileCount = event.target.files.length;
                const card = document.createElement("div");
                card.className = "floating-card copy-image-container";
                card.innerHTML = '<div class="complex-search-button search-btn" role="button"><i></i><span>\u641c\u7d22\u56fe\u7247</span></div>';
                card.querySelector(".complex-search-button").addEventListener("click", () => {
                  window.__searchClicked = true;
                  window.__searchClickCount += 1;
                  if (window.__searchClickCount <= window.__ignoredClicksBeforeResult) return;
                  if (window.__openResultOnClick) {
                    const resultUrl = "https://air.1688.com/kapp/1688-search/pc-image-search/?tab=imageSearch&imageId=abc123&imageIdList=abc123&spm=test";
                    window.open(resultUrl, "_blank");
                  }
                });
                document.body.appendChild(card);
              });
            </script>
          </body>
        </html>
      `,
    });
  };

  await page.route("https://s.1688.com/youyuan/index.htm**", fulfillImageSearchPage);
  await page.route("https://air.1688.com/kapp/1688-search/pc-image-search/**", fulfillImageSearchPage);

  await page.goto(targetUrl);
  await page.evaluate(() => {
    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage(message, cb) {
          window.__proxyFetchMessage = message;
          cb({
            ok: true,
            dataUrl: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2w==",
          });
        },
      },
    };
  });

  await page.addScriptTag({ path: scriptPath });

  try {
    await fn(page);
  } finally {
    await browser.close();
  }
}

async function testUploadedImageSearchButtonIsClicked() {
  await withImageSearchPage(async (page) => {
    await page.waitForFunction(() => window.__fileCount === 1);

    assert.deepStrictEqual(await page.evaluate(() => window.__proxyFetchMessage), {
      action: "proxyImageFetch",
      url: "https://ir-21.ozonru.cn/s3/multimedia-1-7/12030447355.jpg",
    });

    try {
      await page.waitForFunction(() => window.__searchClickCount > 0, null, { timeout: 10000 });
    } catch (err) {
      const debug = await page.evaluate(() =>
        Array.from(document.querySelectorAll("button, a, [role='button'], div, span")).map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            tag: el.tagName,
            role: el.getAttribute("role"),
            className: el.className,
            text: (el.textContent || "").replace(/\s+/g, ""),
            width: rect.width,
            height: rect.height,
          };
        }),
      );
      const state = await page.evaluate(() => ({
        searchClicked: window.__searchClicked,
        searchClickCount: window.__searchClickCount,
        ignoredClicksBeforeResult: window.__ignoredClicksBeforeResult,
      }));
      throw new Error(`${err.message}\nState: ${JSON.stringify(state)}\nPageErrors: ${JSON.stringify(page.__pageErrors)}\nCandidates: ${JSON.stringify(debug)}`);
    }
  }, { openResultOnClick: false });
}

async function testUsesPageBridgeImageIdForFinalNavigation() {
  const imageUrl = "https://ir-21.ozonru.cn/s3/multimedia-1-7/12030447355.jpg";
  const entryUrl =
    "https://air.1688.com/kapp/1688-search/pc-image-search/?tab=imageSearch&__jzcOzonImg=" +
    encodeURIComponent(imageUrl);

  await withImageSearchPage(async (page) => {
    try {
      await page.waitForURL(/imageId=bridge123/, { timeout: 5000 });
    } catch (err) {
      const state = await page.evaluate(() => ({
        href: location.href,
        proxyFetchMessage: window.__proxyFetchMessage,
        bridgeUploadRequest: window.__bridgeUploadRequest,
        storedBridgeUploadRequest: sessionStorage.getItem("__bridgeUploadRequest"),
        fileCount: window.__fileCount,
        searchClickCount: window.__searchClickCount,
      }));
      throw new Error(`${err.message}\nState: ${JSON.stringify(state)}\nPageErrors: ${JSON.stringify(page.__pageErrors)}`);
    }
    const finalUrl = new URL(page.url());
    const bridgeUploadRequest = await page.evaluate(() => JSON.parse(sessionStorage.getItem("__bridgeUploadRequest") || "null"));

    assert.strictEqual(bridgeUploadRequest && bridgeUploadRequest.hasDataUrl, true);

    assert.strictEqual(finalUrl.searchParams.get("imageId"), "bridge123");
    assert.strictEqual(finalUrl.searchParams.get("imageIdList"), "bridge123");
    assert.strictEqual(finalUrl.searchParams.has("__jzcOzonImg"), false);
  }, { entryUrl, mainBridgeImageId: "bridge123", openResultOnClick: false });
}

async function testRetriesPageBridgeImageIdAfterFailure() {
  const imageUrl = "https://ir-21.ozonru.cn/s3/multimedia-1-7/12030447355.jpg";
  const entryUrl =
    "https://air.1688.com/kapp/1688-search/pc-image-search/?tab=imageSearch&__jzcOzonImg=" +
    encodeURIComponent(imageUrl);

  await withImageSearchPage(async (page) => {
    await page.waitForURL(/imageId=retry456/, { timeout: 7000 });
    const finalUrl = new URL(page.url());
    const bridgeUploadRequests = await page.evaluate(() => JSON.parse(sessionStorage.getItem("__bridgeUploadRequests") || "[]"));

    assert.strictEqual(finalUrl.searchParams.get("imageId"), "retry456");
    assert.strictEqual(finalUrl.searchParams.has("__jzcOzonImg"), false);
    assert(bridgeUploadRequests.length >= 2, "expected bridge to retry after a failed imageId request");
  }, {
    entryUrl,
    mainBridgeImageId: "retry456",
    mainBridgeAttemptsBeforeSuccess: 1,
    openResultOnClick: false,
  });
}

async function testFallsBackToNativeClickPromptlyWhenBridgeDoesNotReturnImageId() {
  await withImageSearchPage(async (page) => {
    const startedAt = Date.now();
    const popupPromise = page.waitForEvent("popup", { timeout: 14000 });
    const popup = await popupPromise;
    const elapsedMs = Date.now() - startedAt;

    assert.match(popup.url(), /imageId=abc123/);
    assert(
      elapsedMs >= 9500 && elapsedMs < 12500,
      `expected imageId bridge fallback after about 10000ms, got ${elapsedMs}ms`,
    );
  });
}

async function testNative1688ResultPopupIsNotBlockedByContentScript() {
  await withImageSearchPage(async (page) => {
    const popupPromise = page.waitForEvent("popup", { timeout: 16000 });
    const popup = await popupPromise;
    await popup.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});

    assert.match(popup.url(), /imageId=abc123/);
    assert.doesNotMatch(page.url(), /imageId=abc123/, "content script should not monkey-patch the page into same-tab navigation");
  });
}

async function testRetriesIgnoredImageSearchClicksUntilResultOpens() {
  await withImageSearchPage(async (page) => {
    const popupPromise = page.waitForEvent("popup", { timeout: 16000 });
    const popup = await popupPromise;

    assert.match(popup.url(), /imageId=abc123/);
    assert.strictEqual(await page.evaluate(() => window.__searchClickCount), 3);
  }, { ignoredClicksBeforeResult: 2 });
}

(async () => {
  await testUploadedImageSearchButtonIsClicked();
  await testUsesPageBridgeImageIdForFinalNavigation();
  await testRetriesPageBridgeImageIdAfterFailure();
  await testFallsBackToNativeClickPromptlyWhenBridgeDoesNotReturnImageId();
  await testNative1688ResultPopupIsNotBlockedByContentScript();
  await testRetriesIgnoredImageSearchClicksUntilResultOpens();
  console.log("1688 image search flow tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
