/**
 * Shared Ozon PDP video extraction helpers.
 *
 * Ozon moves video URLs between gallery widget shapes fairly often. Keep the
 * URL mining logic here so content scripts, service worker injections, and
 * tests do not drift apart.
 */
(function(root) {
  "use strict";

  const VIDEO_URL_KEYS = [
    "videoUrl",
    "video_url",
    "mp4Url",
    "mp4",
    "playUrl",
    "videoPlayUrl",
    "contentUrl",
    "fileUrl",
    "url",
    "src",
    "link",
  ];
  const VIDEO_STREAM_KEYS = [
    "hlsUrl",
    "hls_url",
    "m3u8Url",
    "m3u8",
    "streamUrl",
    "stream_url",
  ];
  const VIDEO_COVER_KEYS = [
    "videoCover",
    "videoCoverUrl",
    "video_cover",
    "video_cover_url",
    "previewUrl",
    "preview_url",
    "poster",
    "posterUrl",
    "cover",
    "coverUrl",
    "coverImage",
    "image",
    "imageUrl",
    "thumbnail",
    "thumbnailUrl",
    "picture",
    "pictureUrl",
  ];
  const PREFERRED_CONTAINER_KEYS = [
    "videos",
    "video",
    "videoInfo",
    "mainVideo",
    "mainVideoInfo",
    "media",
    "gallery",
    "items",
  ];
  const MAX_DEPTH = 8;
  const MP4_URL_RE = /https?:[\\\/]+[^"'<>\s]+?\.mp4(?:[^"'<>\s]*)?/gi;
  const IMAGE_URL_RE = /https?:[\\\/]+[^"'<>\s]+?\.(?:jpg|jpeg|png|webp|gif|avif)(?:[^"'<>\s]*)?/gi;

  function normalizeHttpUrl(raw) {
    if (typeof raw !== "string") return null;
    let value = raw.trim();
    if (!value) return null;
    value = value
      .replace(/\\u0026/gi, "&")
      .replace(/\\u003d/gi, "=")
      .replace(/\\u002f/gi, "/")
      .replace(/\\+\//g, "/")
      .replace(/&amp;/g, "&")
      .replace(/\\+"/g, '"');
    value = value.replace(/[\\),.;\]}]+$/g, "");
    if (/^\/\//.test(value)) value = `https:${value}`;
    if (!/^https?:\/\//i.test(value)) return null;
    return value;
  }

  function normalizeVideoUrl(raw) {
    const value = normalizeHttpUrl(raw);
    if (!value) return null;
    if (!/\.mp4(?:[?#]|$)/i.test(value)) return null;
    return value;
  }

  function normalizeCoverUrl(raw, { allowAnyHttp = false } = {}) {
    const value = normalizeHttpUrl(raw);
    if (!value) return null;
    if (/\.(?:mp4|m3u8)(?:[?#]|$)/i.test(value)) return null;
    if (allowAnyHttp || /\.(?:jpg|jpeg|png|webp|gif|avif)(?:[?#]|$)/i.test(value)) {
      return value;
    }
    return null;
  }

  function emptyMedia() {
    return { mp4: null, cover: null };
  }

  function mergeMedia(a, b) {
    return {
      mp4: a.mp4 || b.mp4 || null,
      cover: a.cover || b.cover || null,
    };
  }

  function extractOzonMp4FromText(text) {
    if (typeof text !== "string" || !text) return null;
    const matches = text.match(MP4_URL_RE) || [];
    for (const match of matches) {
      const url = normalizeVideoUrl(match);
      if (url) return url;
    }
    return normalizeVideoUrl(text);
  }

  function extractOzonVideoFromText(text) {
    const media = emptyMedia();
    if (typeof text !== "string" || !text) return media;
    media.mp4 = extractOzonMp4FromText(text);
    const matches = text.match(IMAGE_URL_RE) || [];
    for (const match of matches) {
      const cover = normalizeCoverUrl(match);
      if (cover) {
        media.cover = cover;
        break;
      }
    }
    return media;
  }

  function keyLooksVideoish(key) {
    return /video/i.test(String(key || ""));
  }

  function objectLooksVideoish(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return false;
    const typeText = String(input.type || input.mediaType || input.kind || input.contentType || "").toLowerCase();
    if (typeText.includes("video")) return true;
    if (VIDEO_STREAM_KEYS.some((key) => key in input)) return true;
    return VIDEO_URL_KEYS.some((key) => normalizeVideoUrl(input[key]));
  }

  function findMediaInObject(input, seen, depth, videoContext) {
    if (input == null || depth > MAX_DEPTH) return emptyMedia();
    if (typeof input === "string") {
      const media = extractOzonVideoFromText(input);
      if (!videoContext && !media.mp4 && !/video|\.m3u8|\.mp4/i.test(input)) {
        media.cover = null;
      }
      return media;
    }
    if (typeof input !== "object") return emptyMedia();
    if (seen.has(input)) return emptyMedia();
    seen.add(input);

    const ownVideoContext = videoContext || objectLooksVideoish(input);
    let media = emptyMedia();

    if (Array.isArray(input)) {
      for (const item of input) {
        media = mergeMedia(media, findMediaInObject(item, seen, depth + 1, ownVideoContext));
        if (media.mp4 && media.cover) return media;
      }
      return media;
    }

    for (const key of VIDEO_URL_KEYS) {
      if (!(key in input)) continue;
      const urlContext = ownVideoContext || keyLooksVideoish(key) || !!normalizeVideoUrl(input[key]);
      const found = findMediaInObject(input[key], seen, depth + 1, urlContext);
      media = mergeMedia(media, found);
      if (media.mp4 && media.cover) return media;
    }
    for (const key of VIDEO_COVER_KEYS) {
      if (!(key in input)) continue;
      const coverContext = ownVideoContext || keyLooksVideoish(key);
      const cover = coverContext
        ? normalizeCoverUrl(input[key], { allowAnyHttp: true })
        : null;
      if (cover && !media.cover) media.cover = cover;
      const found = findMediaInObject(input[key], seen, depth + 1, coverContext);
      media = mergeMedia(media, found);
      if (media.mp4 && media.cover) return media;
    }
    for (const key of PREFERRED_CONTAINER_KEYS) {
      if (!(key in input)) continue;
      const found = findMediaInObject(input[key], seen, depth + 1, ownVideoContext || keyLooksVideoish(key));
      media = mergeMedia(media, found);
      if (media.mp4 && media.cover) return media;
    }
    for (const [key, value] of Object.entries(input)) {
      const found = findMediaInObject(value, seen, depth + 1, ownVideoContext || keyLooksVideoish(key));
      media = mergeMedia(media, found);
      if (media.mp4 && media.cover) return media;
    }
    return media;
  }

  function extractOzonVideoFromSources(sources) {
    const list = Array.isArray(sources) ? sources : [sources];
    let media = emptyMedia();
    for (const source of list) {
      media = mergeMedia(media, findMediaInObject(source, new WeakSet(), 0, false));
      if (media.mp4 && media.cover) break;
    }
    return media.mp4 ? media : emptyMedia();
  }

  function extractOzonMp4FromSources(sources) {
    return extractOzonVideoFromSources(sources).mp4;
  }

  function extractOzonVideoFromDocument(doc) {
    if (!doc || typeof doc.querySelectorAll !== "function") return emptyMedia();
    let media = emptyMedia();
    const mediaNodes = doc.querySelectorAll("video, video source, source");
    for (const node of Array.from(mediaNodes)) {
      const found = extractOzonVideoFromSources([
        node.currentSrc,
        typeof node.getAttribute === "function" ? node.getAttribute("src") : "",
        typeof node.getAttribute === "function" ? node.getAttribute("poster") : "",
      ]);
      media = mergeMedia(media, found);
      if (media.mp4 && media.cover) return media;
    }

    const metaNodes = doc.querySelectorAll(
      'meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"], meta[name="twitter:player:stream"]',
    );
    for (const node of Array.from(metaNodes)) {
      const found = extractOzonVideoFromText(node.getAttribute("content") || "");
      media = mergeMedia(media, found);
      if (media.mp4 && media.cover) return media;
    }

    const stateNodes = doc.querySelectorAll("[data-state]");
    for (const node of Array.from(stateNodes)) {
      const raw = node.getAttribute("data-state") || "";
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        const found = extractOzonVideoFromSources(parsed);
        media = mergeMedia(media, found);
        if (media.mp4 && media.cover) return media;
      } catch {}
      const found = extractOzonVideoFromText(raw);
      media = mergeMedia(media, found);
      if (media.mp4 && media.cover) return media;
    }

    return media;
  }

  function extractOzonMp4FromDocument(doc) {
    return extractOzonVideoFromDocument(doc).mp4;
  }

  const api = {
    extractOzonVideoFromSources,
    extractOzonVideoFromText,
    extractOzonVideoFromDocument,
    extractOzonMp4FromSources,
    extractOzonMp4FromText,
    extractOzonMp4FromDocument,
  };

  root.JZOzonVideoExtract = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : (typeof self !== "undefined" ? self : window));
