/**
 * 纯 node 测试，无测试框架。从 extension/ 跑：
 *   node tests/title-quality.test.js
 * 退出码非 0 即失败。
 */
const assert = require("assert");
const { checkTitleQuality } = require("../lib/title-quality.js");

let passed = 0;
function check(name, title, expectOk, expectCodes) {
  const r = checkTitleQuality(title);
  assert.strictEqual(
    r.ok,
    expectOk,
    `[${name}] ok 期望 ${expectOk} 实得 ${r.ok}；issues=${JSON.stringify(r.issues)}`,
  );
  if (expectCodes) {
    const got = r.issues.map((i) => i.code).sort();
    for (const c of expectCodes) {
      assert.ok(got.includes(c), `[${name}] 期望含 issue '${c}'，实得 ${JSON.stringify(got)}`);
    }
  }
  passed++;
}

// ── 合法标题：不报警 ────────────────────────────────
check("好-基础", "Чехол силиконовый для смартфона, прозрачный", true);
check("好-带型号", "Наушники беспроводные TWS, белые, с зарядным кейсом", true);
check("好-单缩写不算全大写", "Кабель USB Type-C для зарядки, 1 метр", true);
check("好-含数字但描述充分", "Кружка керамическая 350 мл с крышкой, синяя", true);

// ── CJK：必拒 ──────────────────────────────────────
check("拒-中文", "保温杯 304不锈钢 大容量", false, ["cjk"]);
check("拒-中俄混", "Термокружка 保温杯 нержавеющая сталь", false, ["cjk"]);

// ── 无俄语：纯拉丁/数字 ────────────────────────────
check("拒-纯拉丁", "Wireless Bluetooth Headphones Pro Max", false, ["no_cyrillic"]);
check("拒-纯编码", "SKU-418418745 NEW 2024", false, ["no_cyrillic"]);

// ── 过短 ────────────────────────────────────────────
check("拒-单词", "Чехол", false, ["too_short"]);
check("拒-空", "   ", false, ["empty"]);

// ── 全大写 ──────────────────────────────────────────
check("拒-全大写多词", "ЧЕХОЛ ДЛЯ ТЕЛЕФОНА СИЛИКОНОВЫЙ", false, ["all_caps"]);

// ── 关键词堆砌 ──────────────────────────────────────
check(
  "拒-重复词",
  "Зеркало настенное зеркало в ванную зеркало в коридор зеркало декоративное",
  false,
  ["keyword_pile"],
);
check(
  "拒-超长无句读名词堆",
  "Рюкзак школьный детский подростковый водонепроницаемый вместительный лёгкий прочный модный синий большой удобный",
  false,
  ["keyword_pile"],
);

// ── 编码占比高 ──────────────────────────────────────
check("拒-编码为主", "A1 2024 99999 7822 0000 1111", false, ["code_like", "no_cyrillic"]);

// ── 截断风险 ────────────────────────────────────────
const long = "Чехол " + "защитный ".repeat(30); // 远超 200
check("拒-超长截断", long, false, ["truncation_risk"]);

console.log(`\n✓ title-quality: ${passed} 个用例全部通过`);
