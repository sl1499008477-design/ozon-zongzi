(function (root) {
  "use strict";

  function safeText(value, max) {
    if (value == null) return "";
    const text = String(value).replace(/\s+/g, " ").trim();
    return max && text.length > max ? text.slice(0, max) : text;
  }

  function htmlToText(value) {
    return String(value || "")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/p\s*>/gi, " ")
      .replace(/<[^>]*>/g, " ");
  }

  // ── Ozon「加载失败」占位 / 展开按钮文案过滤 ────────────────────────────
  // 实测坑(任务 cfe3a0d0):源页描述区没渲染出来时,页面/page-json 抽到的是
  // 「Не удалось загрузить статью. Читать далее Показать полностью」(加载失败占位 +
  // 两个展开按钮文案),被当"真描述"写进 4191 → 原样上架成了新品简介。
  // 统一口径:按钮文案剥掉(真描述末尾偶尔会粘到),剥完为空、或开头是「加载失败」类
  // 提示 → 判占位,当空处理(上层自然退下一候选/标题)。
  const DESCRIPTION_UI_CHROME_RE = /(читать далее|показать полностью|свернуть описание|развернуть описание)/gi;
  const DESCRIPTION_LOAD_FAIL_RE = /(не удалось загрузить|ошибка загрузки|попробуйте (обновить|позже)|failed to load)/i;

  function stripDescriptionUiChrome(value) {
    return safeText(String(value == null ? "" : value).replace(DESCRIPTION_UI_CHROME_RE, " "));
  }

  function isPlaceholderDescriptionText(value) {
    const raw = String(value == null ? "" : value).trim();
    if (!raw) return false; // 本来就空 → 交给上层 falsy 处理,不算"占位"
    const cleaned = stripDescriptionUiChrome(raw);
    if (!cleaned) return true; // 剥掉按钮文案后什么都不剩 → 纯 UI 噪声
    return DESCRIPTION_LOAD_FAIL_RE.test(cleaned.slice(0, 120));
  }

  function extractRichContentText(value, max) {
    const maxChars = max || 2000;
    let doc = value;
    if (typeof value === "string") {
      try {
        doc = JSON.parse(value);
      } catch {
        return "";
      }
    }
    if (!doc || typeof doc !== "object") return "";

    const skipKeys = new Set([
      "widgetName", "align", "size", "color", "type", "src", "img", "imgLink",
      "url", "link", "gifUrl", "videoUrl", "previewUrl", "backgroundColor",
      "theme", "padding", "margin", "id", "reff", "fontColor", "borderColor",
      // 语义噪声容器:走对象兜底(页面 state blob)时别把规格/评论/问答/标签拼进描述。
      // 只跳明确的容器键,不跳 name/value(后者是合法描述字段,见 directKeys)。
      "characteristics", "specifications", "reviews", "questions", "comments",
      "aspects", "params", "feedbacks", "hashtags", "tags",
    ]);
    const out = [];
    let total = 0;
    const pushText = (raw) => {
      if (total >= maxChars) return;
      const text = safeText(htmlToText(raw));
      if (text.length < 2) return;
      if (/^https?:\/\//i.test(text)) return;
      if (!/\p{L}/u.test(text)) return;
      out.push(text);
      total += text.length + 1;
    };
    const walk = (node, key, depth) => {
      if (total >= maxChars || depth > 64) return;
      if (typeof node === "string") {
        if (!key || !skipKeys.has(key)) pushText(node);
        return;
      }
      if (Array.isArray(node)) {
        for (const item of node) walk(item, key, depth + 1);
        return;
      }
      if (node && typeof node === "object") {
        for (const k of Object.keys(node)) {
          if (skipKeys.has(k)) continue;
          walk(node[k], k, depth + 1);
        }
      }
    };

    walk(doc, undefined, 0);
    const seen = new Set();
    const deduped = out.filter((text) => {
      const key = text.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return deduped.join(" ").slice(0, maxChars).trim();
  }

  function extractDescriptionText(value, max) {
    const maxChars = max || 4096;
    const text = extractDescriptionTextInner(value, maxChars);
    if (!text) return "";
    // 占位/按钮文案清洗:SW page-json 与内容脚本抽 state 都走本函数 —— 单一收口。
    // 「Читать далее/Показать полностью」剥掉;整段是「Не удалось загрузить…」→ 当空。
    const cleaned = stripDescriptionUiChrome(text);
    if (!cleaned || isPlaceholderDescriptionText(cleaned)) return "";
    return cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned;
  }

  function extractDescriptionTextInner(value, maxChars) {
    if (value == null) return "";
    if (typeof value === "string") {
      const richText = extractRichContentText(value, maxChars);
      if (richText) return richText;
      // 看起来是富内容/结构化 JSON(如纯图 11254)但抽不出文字 → 返回空,让上层用
      // 下一候选(页面描述/标题),绝不把原始 JSON 串当描述发上 Ozon。
      if (/^\s*[[{]/.test(value)) return "";
      return safeText(htmlToText(value), maxChars);
    }
    if (typeof value !== "object") return safeText(value, maxChars);

    const richKeys = ["richAnnotationJson", "richContent", "richContentJson", "richJson"];
    for (const key of richKeys) {
      const text = extractRichContentText(value[key], maxChars);
      if (text) return text;
    }

    const directKeys = ["description", "text", "content", "html", "value"];
    for (const key of directKeys) {
      const raw = value[key];
      const richText = extractRichContentText(raw, maxChars);
      if (richText) return richText;
      if (typeof raw === "string") {
        const text = safeText(htmlToText(raw), maxChars);
        if (text) return text;
      }
    }

    return extractRichContentText(value, maxChars);
  }

  function visibleTextToLines(value) {
    return String(value || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|section|article|tr)\s*>/gi, "\n")
      .replace(/<[^>]*>/g, " ")
      .split(/\r?\n/)
      .map((line) => safeText(line))
      .filter(Boolean);
  }

  function normalizeHeading(value) {
    return safeText(value)
      .replace(/[:：]+$/g, "")
      .trim()
      .toLowerCase();
  }

  function isDescriptionHeading(line) {
    const text = normalizeHeading(line);
    return [
      "description",
      "\u041e\u043f\u0438\u0441\u0430\u043d\u0438\u0435".toLowerCase(),
      "\u63cf\u8ff0",
      "\u5546\u54c1\u63cf\u8ff0",
    ].includes(text);
  }

  function isDescriptionSectionHeading(line) {
    const text = normalizeHeading(line);
    return [
      "\u0421\u043e\u0441\u0442\u0430\u0432".toLowerCase(),
      "\u0421\u043f\u043e\u0441\u043e\u0431 \u043f\u0440\u0438\u043c\u0435\u043d\u0435\u043d\u0438\u044f".toLowerCase(),
    ].includes(text);
  }

  function isDescriptionStopLine(line) {
    const text = safeText(line);
    if (!text) return false;
    if (/^#[\p{L}\p{N}_-]+/u.test(text)) return true;
    return [
      "hashtags",
      "tags",
      "characteristics",
      "specifications",
      "reviews",
      "questions",
      "color",
      "\u0445\u0430\u0440\u0430\u043a\u0442\u0435\u0440\u0438\u0441\u0442\u0438\u043a\u0438",
      "\u043e\u0442\u0437\u044b\u0432\u044b",
      "\u0432\u043e\u043f\u0440\u043e\u0441\u044b",
      "\u0442\u0435\u0433\u0438",
      "\u4e3b\u9898\u6807\u7b7e",
      "\u6807\u7b7e",
      "\u7279\u5f81",
      "\u89c4\u683c",
      "\u53c2\u6570",
      "\u8bc4\u8bba",
      "\u95ee\u9898",
      "\u989c\u8272",
    ].includes(normalizeHeading(text));
  }

  function isDescriptionUiNoiseText(value) {
    const text = normalizeHeading(value);
    return [
      "show more",
      "show full",
      "read more",
      "\u043f\u043e\u043a\u0430\u0437\u0430\u0442\u044c \u043f\u043e\u043b\u043d\u043e\u0441\u0442\u044c",
      "\u0440\u0430\u0437\u0432\u0435\u0440\u043d\u0443\u0442\u044c",
      "\u5c55\u5f00",
      "\u663e\u793a\u5168\u90e8",
      "\u67e5\u770b\u5168\u90e8",
    ].includes(text);
  }

  function extractVisibleDescriptionText(value, max) {
    const maxChars = max || 4096;
    const lines = visibleTextToLines(value);
    if (lines.length === 0) return "";

    let start = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (isDescriptionHeading(lines[i])) {
        start = i + 1;
        break;
      }
      if (isDescriptionSectionHeading(lines[i])) {
        start = i;
        break;
      }
    }

    const bodyLines = [];
    const candidates = start >= 0 ? lines.slice(start) : lines;
    for (const line of candidates) {
      if (isDescriptionStopLine(line)) break;
      if (isDescriptionHeading(line)) continue;
      const tagStart = line.search(/\s#[\p{L}\p{N}_-]{2,}/u);
      bodyLines.push(tagStart > 0 ? line.slice(0, tagStart).trim() : line);
      if (bodyLines.join(" ").length >= maxChars) break;
    }

    const text = safeText(bodyLines.join(" "), maxChars);
    if (
      !text ||
      isDescriptionHeading(text) ||
      isDescriptionStopLine(text) ||
      isDescriptionUiNoiseText(text)
    ) return "";
    return text;
  }

  function scoreVisibleDescriptionCandidate(raw, text) {
    if (!text || isDescriptionUiNoiseText(text)) return Number.NEGATIVE_INFINITY;
    const rawLines = visibleTextToLines(raw);
    const textLines = visibleTextToLines(text);
    const letterCount = (text.match(/\p{L}/gu) || []).length;
    if (letterCount < 8) return Number.NEGATIVE_INFINITY;
    let score = Math.min(text.length, 1200);
    if (rawLines.some(isDescriptionHeading)) score += 400;
    if (rawLines.some(isDescriptionSectionHeading)) score += 700;
    if (textLines.some(isDescriptionSectionHeading)) score += 250;
    if (/\d+\./.test(text)) score += 60;
    if (text.length < 30) score -= 300;
    if (isDescriptionStopLine(textLines[0] || "")) score -= 500;
    return score;
  }

  function pickBestVisibleDescriptionText(values, max) {
    const maxChars = max || 4096;
    const candidates = Array.isArray(values) ? values : [values];
    let best = "";
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const raw of candidates) {
      const text = extractVisibleDescriptionText(raw, maxChars);
      const score = scoreVisibleDescriptionCandidate(raw, text);
      if (score > bestScore) {
        bestScore = score;
        best = text;
      }
    }
    return best;
  }

  function readSourceAttrText(sourceVariant, key) {
    const attrs = Array.isArray(sourceVariant?.attributes) ? sourceVariant.attributes : [];
    const hit = attrs.find((attr) => String(attr?.key ?? attr?.id) === String(key));
    if (!hit) return "";
    const candidates = [
      hit.value,
      Array.isArray(hit.collection) ? hit.collection.join(" ") : "",
      Array.isArray(hit.values) ? hit.values.map((v) => v?.value).filter(Boolean).join(" ") : "",
    ];
    for (const value of candidates) {
      const text = safeText(value);
      if (text) return text;
    }
    return "";
  }

  function pickFollowSellDescription(input) {
    const max = input?.max || 4096;
    // 商品简介只取真实描述字段:自定义 → 源 4191 → 标题兜底。
    // **不再用 pageDescription(页面可见描述)兜底**:源商品把内容做成富内容时,页面可见描述抓回来的
    // 就是一坨富内容文本(手动跟卖实测漏点)。批量上架走 sku-collect 直读源 4191、从不碰实时页面 DOM,
    // 本就不漏;去掉 pageDescription 让手动跟卖对齐批量 —— 源无真实 4191 即退标题,而非页面富内容。
    // 富内容继续作为独立富内容块下发(pickSourceRichContent / jzInjectRichContentAttr),正文不回填普通描述。
    return (
      safeText(input?.customDescription, max) ||
      safeText(extractDescriptionText(readSourceAttrText(input?.sourceVariant, "4191"), max), max) ||
      safeText(input?.fallbackName, max)
    );
  }

  function mergeSourceDescriptionIntoVariant(sourceVariant, rawDescription) {
    const text = safeText(extractDescriptionText(rawDescription, 4096) || rawDescription, 4096);
    // extractDescriptionText 判占位返空后,`|| rawDescription` 兜底会把原始占位文案重新放进来
    // —— 这里再拦一道,加载失败占位绝不写进 4191。
    if (!text || isPlaceholderDescriptionText(text)) return sourceVariant;
    const target = sourceVariant && typeof sourceVariant === "object" ? sourceVariant : {};
    const attrs = Array.isArray(target.attributes) ? target.attributes : [];
    const existing = attrs.find((attr) => String(attr?.key ?? attr?.id) === "4191");
    if (existing) {
      if (existing.key == null) existing.key = String(existing.id ?? "4191");
      if (readSourceAttrText({ attributes: [existing] }, "4191")) return target;
      existing.value = text;
      return target;
    }
    target.attributes = [...attrs, { key: "4191", value: text }];
    return target;
  }

  function normalizeSourceHashtags(raw) {
    const values = Array.isArray(raw) ? raw : String(raw || "").split(/[\s,\uFF0C]+/);
    const out = [];
    const seen = new Set();
    for (const item of values) {
      // \u5B57\u7B26\u767D\u540D\u5355\u6E05\u6D17 \u2014\u2014 \u4E0E\u540E\u7AEF buildHashtagValues \u5BF9\u9F50(Ozon attr 23171 \u53EA\u5141\u8BB8
      // \u5B57\u6BCD/\u6570\u5B57/\u4E0B\u5212\u7EBF,\u6807\u7B7E\u5185\u4E0D\u80FD\u6709\u7A7A\u683C)\u3002\u672C\u51FD\u6570\u628A\u6807\u7B7E\u5199\u8FDB _sourceVariant \u7684 23171,
      // \u540E\u7AEF sv \u81EA\u7531\u6587\u672C\u5206\u652F\u4F1A\u539F\u6837\u900F\u4F20(\u4E0D\u8FC7 buildHashtagValues),\u6240\u4EE5\u810F\u6807\u7B7E\u4F1A\u88AB Ozon
      // \u76F4\u63A5\u62D2(BR_hashtags_symbols_validation / BR_hashtag_validation)\u3002\u65E7\u5B9E\u73B0\u53EA\u8865 #
      // \u622A\u65AD,\u65E2\u4E0D\u8F6C\u7A7A\u683C\u4E5F\u4E0D\u8F6C\u8FDE\u5B57\u7B26 \u2192 \u591A\u8BCD\u5173\u952E\u8BCD\u77ED\u8BED\u4F1A\u5E26\u7A7A\u683C\u548C\u8FDE\u5B57\u7B26\u6CC4\u6F0F\u3002
      let body = safeText(item)
        .replace(/^#+/, "") // \u5148\u5265\u5DF2\u6709 #,\u7EDF\u4E00\u7531\u672C\u51FD\u6570\u8865
        .replace(/[\s-]+/g, "_") // \u7A7A\u767D\u548C\u8FDE\u5B57\u7B26 \u2192 \u4E0B\u5212\u7EBF
        .replace(/[^A-Za-z\u0410-\u042F\u0430-\u044F\u0401\u04510-9_\u4E00-\u9FFF]/g, "") // \u5220\u975E\u6CD5\u5B57\u7B26(\u70B9/\u9017\u53F7/\u659C\u6760/emoji \u7B49),\u4FDD\u7559 CJK
        .replace(/_+/g, "_")
        .replace(/^_|_$/g, "");
      if (!body) continue;
      if (body.length > 29) body = body.slice(0, 29); // #+body \u2264 30
      const tag = `#${body}`;
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(tag);
      if (out.length >= 30) break;
    }
    return out;
  }

  function mergeSourceHashtagsIntoVariant(sourceVariant, rawHashtags) {
    const tags = normalizeSourceHashtags(rawHashtags);
    if (tags.length === 0 || !sourceVariant || typeof sourceVariant !== "object") return sourceVariant;
    const attrs = Array.isArray(sourceVariant.attributes) ? sourceVariant.attributes : [];
    const existing = attrs.find((attr) => String(attr?.key ?? attr?.id) === "23171");
    if (existing) {
      if (existing.key == null) existing.key = String(existing.id ?? "23171");
      if (readSourceAttrText({ attributes: [existing] }, "23171")) return sourceVariant;
      existing.value = tags.join(" ");
      return sourceVariant;
    }
    sourceVariant.attributes = [...attrs, { key: "23171", value: tags.join(" ") }];
    return sourceVariant;
  }

  function shouldForceCollectRefresh(input) {
    if (!input || typeof input !== "object") return false;
    if (safeText(input.videoUrl)) return true;
    if (safeText(input.description)) return true;
    if (safeText(input.richContent)) return true;
    return normalizeSourceHashtags(input.hashtags).length > 0;
  }

  const api = {
    safeText,
    extractDescriptionText,
    stripDescriptionUiChrome,
    isPlaceholderDescriptionText,
    extractVisibleDescriptionText,
    pickBestVisibleDescriptionText,
    extractRichContentText,
    readSourceAttrText,
    pickFollowSellDescription,
    mergeSourceDescriptionIntoVariant,
    normalizeSourceHashtags,
    mergeSourceHashtagsIntoVariant,
    shouldForceCollectRefresh,
  };

  root.JZFollowSellContentCopy = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
