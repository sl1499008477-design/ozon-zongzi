const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  extractOzonVideoFromSources,
  extractOzonMp4FromSources,
  extractOzonMp4FromText,
} = require("../lib/ozon-video-extract.js");

const extensionRoot = path.resolve(__dirname, "..");

const galleryWithNewVideoShape = {
  images: [{ src: "https://ir.ozone.ru/s3/multimedia-1/a.jpg" }],
  coverImage: "https://ir.ozone.ru/s3/multimedia-1/a.jpg",
  videos: [
    {
      previewUrl: "https://ir.ozone.ru/s3/video-preview/poster.jpg",
      videoUrl: "https://cdn1.ozone.ru/s3/video-1/main-video.mp4?hash=abc",
    },
  ],
};

assert.strictEqual(
  extractOzonMp4FromSources([galleryWithNewVideoShape]),
  "https://cdn1.ozone.ru/s3/video-1/main-video.mp4?hash=abc",
);
assert.deepStrictEqual(
  extractOzonVideoFromSources([galleryWithNewVideoShape]),
  {
    mp4: "https://cdn1.ozone.ru/s3/video-1/main-video.mp4?hash=abc",
    cover: "https://ir.ozone.ru/s3/video-preview/poster.jpg",
  },
);

const galleryWithStreamOnlyVideo = {
  videos: [
    {
      hlsUrl: "https://cdn1.ozone.ru/s3/video-1/main-video.m3u8?hash=abc",
      previewUrl: "https://ir.ozone.ru/s3/video-preview/stream-poster.jpg",
    },
  ],
};

assert.deepStrictEqual(
  extractOzonVideoFromSources([galleryWithStreamOnlyVideo]),
  {
    mp4: null,
    cover: null,
  },
);

assert.deepStrictEqual(
  extractOzonVideoFromSources([
    {
      images: [{ url: "https://ir.ozone.ru/s3/multimedia-1/ordinary.jpg" }],
      coverImage: "https://ir.ozone.ru/s3/multimedia-1/ordinary-cover.jpg",
    },
  ]),
  { mp4: null, cover: null },
);

const nestedVideoInfo = {
  gallery: {
    media: [
      {
        videoInfo: {
          playUrl: "https://cdn2.ozone.ru/s3/video-2/nested-video.mp4#fragment",
        },
      },
    ],
  },
};

assert.strictEqual(
  extractOzonMp4FromSources([nestedVideoInfo]),
  "https://cdn2.ozone.ru/s3/video-2/nested-video.mp4#fragment",
);

const escapedState = String.raw`{"widgetStates":{"webGallery-123":"{\"videos\":[{\"url\":\"https:\\/\\/cdn3.ozone.ru\\/s3\\/video-3\\/state-video.mp4?x=1\"}]}"}}`;

assert.strictEqual(
  extractOzonMp4FromText(escapedState),
  "https://cdn3.ozone.ru/s3/video-3/state-video.mp4?x=1",
);

assert.strictEqual(
  extractOzonMp4FromSources([{ videos: [{ url: "https://cdn.ozone.ru/video.m3u8" }] }]),
  null,
);

const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, "manifest.json"), "utf8"));
const productGroup = manifest.content_scripts
  .map((entry) => entry.js || [])
  .find((scripts) => scripts.includes("content/ozon-product.js"));
assert(productGroup, "expected ozon product content script group");
assert(productGroup.includes("lib/ozon-video-extract.js"), "video helper should be loaded on Ozon pages");
assert(
  productGroup.indexOf("lib/ozon-video-extract.js") < productGroup.indexOf("content/ozon-product.js"),
  "video helper should load before ozon-product.js",
);

const serviceWorker = fs.readFileSync(path.join(extensionRoot, "background/service-worker.js"), "utf8");
assert(
  serviceWorker.includes("lib/ozon-video-extract.js") && serviceWorker.includes("JZOzonVideoExtract"),
  "service worker buyer-tab media fetch should inject and use the shared video helper",
);

console.log("ozon video extract test passed");
