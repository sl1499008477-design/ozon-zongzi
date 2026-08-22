const assert = require("assert");
const {
  pickFollowSellDescription,
  mergeSourceHashtagsIntoVariant,
  normalizeSourceHashtags,
  readSourceAttrText,
  extractDescriptionText,
  extractRichContentText,
  extractVisibleDescriptionText,
  pickBestVisibleDescriptionText,
  mergeSourceDescriptionIntoVariant,
  shouldForceCollectRefresh,
  isPlaceholderDescriptionText,
} = require("../lib/follow-sell-content-copy.js");

const sourceVariant = {
  attributes: [
    { key: "4191", value: "Original source product description." },
  ],
};

assert.strictEqual(
  pickFollowSellDescription({
    customDescription: "",
    sourceVariant,
    pageDescription: "Page description.",
    fallbackName: "Product title",
    max: 4096,
  }),
  "Original source product description.",
);

assert.strictEqual(
  pickFollowSellDescription({
    customDescription: "Manual description",
    sourceVariant,
    pageDescription: "Page description.",
    fallbackName: "Product title",
    max: 4096,
  }),
  "Manual description",
);

// 源无真实描述(4191)时不再退页面可见描述(可能是源商品富内容文本)—— 直接退标题,与批量上架一致。
assert.strictEqual(
  pickFollowSellDescription({
    customDescription: "",
    sourceVariant: { attributes: [] },
    pageDescription: "Page description.",
    fallbackName: "Product title",
    max: 4096,
  }),
  "Product title",
);

assert.strictEqual(
  pickFollowSellDescription({
    customDescription: "",
    sourceVariant: { attributes: [{ key: "4191", value: "<p>Elegant bamboo laptop table &amp; tray.</p>" }] },
    pageDescription: "",
    fallbackName: "Product title",
    max: 4096,
  }),
  "Elegant bamboo laptop table &amp; tray.",
);

assert.strictEqual(
  readSourceAttrText(
    { attributes: [{ key: "4191", value: "", values: [{ value: "Values description." }] }] },
    "4191",
  ),
  "Values description.",
);

const mouseRichContent = JSON.stringify({
  content: [
    {
      widgetName: "raTextBlock",
      title: { size: "size5", align: "left", color: "color1", content: ["Комплектация"] },
      text: {
        size: "size2",
        align: "left",
        color: "color1",
        content: [
          "Мышь;",
          "Наноприемник;",
          "1 батарея типа AA (установлена в устройство);",
          "Документация пользователя.",
        ],
      },
    },
  ],
  version: 0.3,
});

assert.strictEqual(
  extractRichContentText(mouseRichContent),
  "Комплектация Мышь; Наноприемник; 1 батарея типа AA (установлена в устройство); Документация пользователя.",
);

assert.strictEqual(
  extractDescriptionText({
    richAnnotationJson: mouseRichContent,
    buttonText: "Развернуть",
  }),
  "Комплектация Мышь; Наноприемник; 1 батарея типа AA (установлена в устройство); Документация пользователя.",
);

// 富内容(richContent 入参)不再回填普通描述 —— 4191/页面描述都空时退到标题,而非富内容正文。
assert.strictEqual(
  pickFollowSellDescription({
    customDescription: "",
    sourceVariant: { attributes: [] },
    pageDescription: "",
    richContent: mouseRichContent,
    fallbackName: "Product title",
    max: 4096,
  }),
  "Product title",
);

// 源 11254 富内容属性同样不再当描述兜底 —— 退到标题。
assert.strictEqual(
  pickFollowSellDescription({
    customDescription: "",
    sourceVariant: { attributes: [{ key: "11254", value: mouseRichContent }] },
    pageDescription: "",
    fallbackName: "Product title",
    max: 4096,
  }),
  "Product title",
);

const visibleDescriptionText = [
  "\u63cf\u8ff0",
  "13.6-inch MacBook Air case fits M4, M3 and M2 models.",
  "1. Matte texture resists fingerprints.",
  "2. Protects the notebook from scratches.",
  "\u88c5\u5907",
  "\u4fdd\u62a4\u58f3",
  "#simple",
  "#portable",
  "\u989c\u8272",
].join("\n");

assert.strictEqual(
  extractVisibleDescriptionText(visibleDescriptionText, 4096),
  "13.6-inch MacBook Air case fits M4, M3 and M2 models. 1. Matte texture resists fingerprints. 2. Protects the notebook from scratches. \u88c5\u5907 \u4fdd\u62a4\u58f3",
);

const ozonSectionDescriptionText = [
  "ARAVIA Laboratories moisturizing face cream",
  "5395 \u043e\u0442\u0437\u044b\u0432\u043e\u0432",
  "\u041f\u043e\u043a\u0430\u0437\u0430\u0442\u044c \u043f\u043e\u043b\u043d\u043e\u0441\u0442\u044c",
  "\u0421\u043e\u0441\u0442\u0430\u0432",
  "Aqua, Propylene Glycol, Ceramide EOP.",
  "\u0421\u043f\u043e\u0441\u043e\u0431 \u043f\u0440\u0438\u043c\u0435\u043d\u0435\u043d\u0438\u044f",
  "Apply the cream every morning.",
  "#\u043a\u0440\u0435\u043c_\u0434\u043b\u044f_\u043b\u0438\u0446\u0430",
  "\u0425\u0430\u0440\u0430\u043a\u0442\u0435\u0440\u0438\u0441\u0442\u0438\u043a\u0438",
].join("\n");

assert.strictEqual(
  extractVisibleDescriptionText(ozonSectionDescriptionText, 4096),
  "\u0421\u043e\u0441\u0442\u0430\u0432 Aqua, Propylene Glycol, Ceramide EOP. \u0421\u043f\u043e\u0441\u043e\u0431 \u043f\u0440\u0438\u043c\u0435\u043d\u0435\u043d\u0438\u044f Apply the cream every morning.",
);

assert.strictEqual(
  typeof pickBestVisibleDescriptionText,
  "function",
  "pickBestVisibleDescriptionText should be exported",
);
if (typeof pickBestVisibleDescriptionText === "function") {
  assert.strictEqual(
    pickBestVisibleDescriptionText(
      [
        "\u041f\u043e\u043a\u0430\u0437\u0430\u0442\u044c \u043f\u043e\u043b\u043d\u043e\u0441\u0442\u044c",
        "\u0425\u0430\u0440\u0430\u043a\u0442\u0435\u0440\u0438\u0441\u0442\u0438\u043a\u0438\n\u0410\u0440\u0442\u0438\u043a\u0443\u043b 2923206163",
        ozonSectionDescriptionText,
      ],
      4096,
    ),
    "\u0421\u043e\u0441\u0442\u0430\u0432 Aqua, Propylene Glycol, Ceramide EOP. \u0421\u043f\u043e\u0441\u043e\u0431 \u043f\u0440\u0438\u043c\u0435\u043d\u0435\u043d\u0438\u044f Apply the cream every morning.",
  );
}

assert.strictEqual(
  typeof shouldForceCollectRefresh,
  "function",
  "shouldForceCollectRefresh should be exported",
);
if (typeof shouldForceCollectRefresh === "function") {
  assert.strictEqual(shouldForceCollectRefresh({}), false);
  assert.strictEqual(shouldForceCollectRefresh({ videoUrl: "https://video.test/a.mp4" }), true);
  assert.strictEqual(shouldForceCollectRefresh({ videoCover: "https://image.test/video-cover.jpg" }), false);
  assert.strictEqual(shouldForceCollectRefresh({ description: "Visible product description." }), true);
  assert.strictEqual(shouldForceCollectRefresh({ richContent: mouseRichContent }), true);
  assert.strictEqual(shouldForceCollectRefresh({ hashtags: ["#case"] }), true);
}

const svWithDescription = { attributes: [{ key: "4180", value: "Name" }] };
mergeSourceDescriptionIntoVariant(svWithDescription, "Visible product description.");
assert.deepStrictEqual(svWithDescription.attributes, [
  { key: "4180", value: "Name" },
  { key: "4191", value: "Visible product description." },
]);

const svAlreadyDescribed = { attributes: [{ key: "4191", value: "Keep existing." }] };
mergeSourceDescriptionIntoVariant(svAlreadyDescribed, "New description.");
assert.deepStrictEqual(svAlreadyDescribed.attributes, [{ key: "4191", value: "Keep existing." }]);

assert.deepStrictEqual(
  normalizeSourceHashtags([" case ", "#phone", "case", ""]),
  ["#case", "#phone"],
);

const svWithTags = { attributes: [{ key: "4180", value: "Name" }] };
mergeSourceHashtagsIntoVariant(svWithTags, ["case", "#phone"]);
assert.deepStrictEqual(svWithTags.attributes, [
  { key: "4180", value: "Name" },
  { key: "23171", value: "#case #phone" },
]);

const svAlreadyTagged = { attributes: [{ key: "23171", value: "#old" }] };
mergeSourceHashtagsIntoVariant(svAlreadyTagged, ["#new"]);
assert.deepStrictEqual(svAlreadyTagged.attributes, [{ key: "23171", value: "#old" }]);

const svEmptyTagged = { attributes: [{ key: "23171", value: "" }] };
mergeSourceHashtagsIntoVariant(svEmptyTagged, ["#new"]);
assert.deepStrictEqual(svEmptyTagged.attributes, [{ key: "23171", value: "#new" }]);

const svIdOnlyTagged = { attributes: [{ id: 23171, value: "#kept" }] };
mergeSourceHashtagsIntoVariant(svIdOnlyTagged, ["#new"]);
assert.deepStrictEqual(svIdOnlyTagged.attributes, [{ id: 23171, value: "#kept", key: "23171" }]);

// ── 「加载失败」占位/展开按钮文案不当描述(实测 cfe3a0d0 把它上架成了新品简介)──
const loadFailPlaceholder =
  "Не удалось загрузить статью. Читать далее Показать полностью";

// 占位识别:占位 → true;真描述(哪怕末尾粘按钮文案)→ false;空值 → false(交上层 falsy)。
assert.strictEqual(isPlaceholderDescriptionText(loadFailPlaceholder), true);
assert.strictEqual(isPlaceholderDescriptionText("Читать далее Показать полностью"), true);
assert.strictEqual(isPlaceholderDescriptionText("Обычное описание товара. Читать далее"), false);
assert.strictEqual(isPlaceholderDescriptionText(""), false);
assert.strictEqual(isPlaceholderDescriptionText(null), false);

// extractDescriptionText:整段占位 → 空;真描述末尾的按钮文案被剥掉、正文保留。
assert.strictEqual(extractDescriptionText(loadFailPlaceholder), "");
assert.strictEqual(
  extractDescriptionText("Крючок самоклеящийся для ванной. Читать далее Показать полностью"),
  "Крючок самоклеящийся для ванной.",
);

// pickFollowSellDescription:源 4191 是占位 → 退标题,而非把报错文案当简介。
assert.strictEqual(
  pickFollowSellDescription({
    customDescription: "",
    sourceVariant: { attributes: [{ key: "4191", value: loadFailPlaceholder }] },
    fallbackName: "Product title",
    max: 4096,
  }),
  "Product title",
);

// mergeSourceDescriptionIntoVariant:占位不写 4191(extract 返空后 rawDescription 兜底也被拦)。
{
  const svPlaceholder = { attributes: [] };
  mergeSourceDescriptionIntoVariant(svPlaceholder, loadFailPlaceholder);
  assert.strictEqual(
    svPlaceholder.attributes.some((a) => String(a.key) === "4191"),
    false,
  );
}

console.log("follow-sell content copy test passed");
