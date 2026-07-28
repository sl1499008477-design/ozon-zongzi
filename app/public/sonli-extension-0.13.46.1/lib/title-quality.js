/**
 * 标题质量预检（纯规则、无 LLM）。
 *
 * 跟卖把源 SKU 的标题（attr 4180）原样复制到新卡片。源标题常是跨境机翻 / 关键词
 * 堆砌的劣质俄语 —— 原卡片是老审核遗留，但跟卖出来的新卡片要重新过审，会被现在
 * 更严的审核判为「无意义文本 / 语法错误 / 买家看不出这是什么商品」
 * （Ozon: «В названии бессмысленный текст или грамматические ошибки. Составьте
 * название, которое поможет покупателю понять, что это за товар»）。
 *
 * 这里做的是**高精度、保守**的事前体检：只在标题有明显问题时报警，宁可漏报不要误报
 * （误报会让用户对每条好标题都看到警告而忽略它）。真正能修好的手段是 AI 重写
 * （backend product.service.ts applyAiRewrite）——本检查只负责在没开 AI 重写时
 * 提前告诉用户「这条大概率会被拒，去开 AI 重写或手动改标题」。
 *
 * 与 v3-payload.js 同款 IIFE + 双导出（浏览器 window.JZTitleQuality / node require），
 * 方便 tests/title-quality.test.js 用纯 node 跑。
 */
(function (root) {
  "use strict";

  // Ozon 名称硬上限 200（naming-requirements）。safeText 在 v3-payload 里按 200 硬切，
  // 越接近上限越可能被截断到半句 → 文本不连贯。≥190 视为截断风险。
  const NAME_MAX = 200;
  const TRUNCATION_RISK_LEN = 190;

  const RE_CYRILLIC = /[Ѐ-ӿ]/;
  // CJK 统一表意 + 日文假名 + 谚文 —— 标题里出现 = Ozon 必拒。
  const RE_CJK = /[぀-ヿ㐀-䶿一-鿿가-힯]/;
  const RE_LETTER = /[A-Za-zЀ-ӿ]/;

  // 一个 token 是否「全大写」（≥3 个字母、且字母全大写）。Ozon 明确拒绝
  // прописными буквами（全大写词），真实缩写（ГОСТ / USB / LED）才允许，所以
  // 只在出现 ≥2 个全大写词时才算异常（单个多半是合法缩写）。
  function isAllCapsWord(tok) {
    const letters = tok.replace(/[^A-Za-zЀ-ӿ]/g, "");
    if (letters.length < 3) return false;
    return letters === letters.toUpperCase() && letters !== letters.toLowerCase();
  }

  /**
   * @param {string} rawName 待检标题（buildV3Item 里的 item.name / distilled.name）
   * @returns {{ ok: boolean, issues: Array<{code:string,label:string}> }}
   *   ok=false 表示标题大概率过不了 Ozon 审核。issues 给人看的中文原因。
   */
  function checkTitleQuality(rawName) {
    const issues = [];
    const add = (code, label) => issues.push({ code, label });

    const name = (rawName == null ? "" : String(rawName)).trim();

    if (!name) {
      add("empty", "标题为空");
      return { ok: false, issues };
    }

    // CJK：必拒，优先级最高。
    if (RE_CJK.test(name)) {
      add("cjk", "标题含中文/日文/韩文字符（Ozon 必拒）");
    }

    // 完全没有西里尔字母：俄语市场的标题却一个俄文字母都没有，买家看不懂、审核判无意义。
    if (!RE_CYRILLIC.test(name)) {
      add("no_cyrillic", "标题不含俄语，疑似纯拉丁/数字（买家看不出是什么商品）");
    }

    const tokens = name.split(/\s+/).filter(Boolean);

    // 过短：少于 2 个词 或 总长 < 6，基本不可能说清「这是什么商品」。
    if (name.length < 6 || tokens.length < 2) {
      add("too_short", "标题过短，说不清商品是什么");
    }

    // 全大写词 ≥2：транслит/прописными 触发审核。
    const capsWords = tokens.filter(isAllCapsWord);
    if (capsWords.length >= 2) {
      add("all_caps", "多个全大写词（Ozon 拒绝 прописными/全大写标题）");
    }

    // 关键词堆砌：
    //   (a) 同一个词（归一化小写、≥3 字母）出现 ≥3 次；或
    //   (b) ≥12 个词且整条没有任何句读分隔（. , : / "）—— 经典名词堆。
    const counts = new Map();
    for (const t of tokens) {
      const norm = t.toLowerCase().replace(/[^a-zЀ-ӿ]/g, "");
      if (norm.length < 3) continue;
      counts.set(norm, (counts.get(norm) || 0) + 1);
    }
    let maxRepeat = 0;
    for (const c of counts.values()) if (c > maxRepeat) maxRepeat = c;
    const hasPunct = /[.,:/"]/.test(name);
    if (maxRepeat >= 3 || (tokens.length >= 12 && !hasPunct)) {
      add("keyword_pile", "疑似关键词堆砌（重复词/超长无句读名词堆）");
    }

    // 像编码：去掉空格后字母占比 < 40%（大部分是数字/符号/SKU 码）。
    const compact = name.replace(/\s+/g, "");
    const letterCount = (compact.match(/[A-Za-zЀ-ӿ]/g) || []).length;
    if (compact.length >= 6 && letterCount / compact.length < 0.4) {
      add("code_like", "标题大部分是数字/编码，缺少描述性词语");
    }

    // 截断风险：贴近 200 硬切；若 200 处刚好落在词中间，截断后更不连贯。
    if (name.length >= TRUNCATION_RISK_LEN) {
      const cutsMidWord =
        name.length > NAME_MAX &&
        RE_LETTER.test(name[NAME_MAX - 1] || "") &&
        RE_LETTER.test(name[NAME_MAX] || "");
      add(
        "truncation_risk",
        cutsMidWord ? "标题超 200 字将被从词中间截断" : "标题接近 200 字上限，可能被截断",
      );
    }

    return { ok: issues.length === 0, issues };
  }

  const api = { checkTitleQuality };
  if (root) root.JZTitleQuality = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : null);
