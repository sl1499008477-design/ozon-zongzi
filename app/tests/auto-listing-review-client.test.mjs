import assert from "node:assert/strict";
import test from "node:test";

import { loadAutoListingReviewImage } from "../src/auto-listing-review-client.js";

const WEBP_BYTES = new Uint8Array(Buffer.from(
  "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==",
  "base64",
));

function imageResponse() {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "image/webp", "content-length": String(WEBP_BYTES.byteLength) }),
    arrayBuffer: async () => WEBP_BYTES.buffer,
  };
}

test("review image client accepts only the authenticated same-item preview path", async () => {
  let request = null;
  const blob = await loadAutoListingReviewImage(
    "/auto-listing/items/item-a/assets/asset-a/preview",
    {
      token: "review-token",
      fetchImpl: async (url, options) => { request = { url, options }; return imageResponse(); },
    },
  );

  assert.equal(blob.type, "image/webp");
  assert.equal(request.url, "/api/auto-listing/items/item-a/assets/asset-a/preview");
  assert.equal(request.options.headers.Authorization, "Bearer review-token");
});

test("review image client starts at most two protected downloads at once", async () => {
  const replies = [];
  let starts = 0;
  const fetchImpl = async () => {
    starts += 1;
    return new Promise((resolve) => replies.push(resolve));
  };
  const requests = ["a", "b", "c"].map((assetId) => loadAutoListingReviewImage(
    `/auto-listing/items/item-a/assets/${assetId}`,
    { token: "review-token", fetchImpl },
  ));
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(starts, 2);
  replies.shift()(imageResponse());
  for (let turn = 0; turn < 10 && starts < 3; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(starts, 3);
  for (const resolve of replies) resolve(imageResponse());
  await Promise.all(requests);
});
