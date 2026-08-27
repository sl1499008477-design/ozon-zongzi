/**
 * Quick-list parser — 把用户粘贴的 textarea 文本解析成行数组。
 * 移植自 frontend/lib/quick-list-parser.ts，去类型注解。挂在 window.JZQuickListParser。
 *
 * 10 种格式：
 *   1: sku, 售价
 *   2: sku, 售价, 自定义货号
 *   3: sku, 售价, 重量g
 *   4: sku, 售价, 长度mm
 *   5: sku, 售价, 长度mm, 宽度mm
 *   6: sku, 售价, 长度mm, 宽度mm, 高度mm
 *   7: sku, 售价, 重量g, 长度mm, 宽度mm, 高度mm
 *   8: sku, 售价, 自定义货号, 重量g
 *   9: sku, 售价, 自定义货号, 重量g, 长度mm, 宽度mm, 高度mm
 *  10: sku, 售价, ~最低价   ← 以 ~ 前缀标记最低价,可放任意位置(可与 1-9 任意组合)
 */
(function (root) {
  "use strict";

  // Ozon SKU 长度近年从 8-10 位逐步扩展到 13+ 位；宽松到 6-16
  const SKU_RE = /^\d{6,16}$/;
  const OFFER_ID_RE = /[A-Za-z\-_]/;
  // 显式单位:重量(克)/ 长度(毫米)。整串必须是「数字+单位」才算带单位的数值,
  // 否则(含其它字母/结构,如 2290580408-TXZMK)才是货号。中俄英常见写法都收。
  const WEIGHT_TOKEN_RE = /^(\d+(?:\.\d+)?)\s*(?:g|克|г|gram|grams)$/i;
  const LENGTH_TOKEN_RE = /^(\d+(?:\.\d+)?)\s*(?:mm|мм|毫米)$/i;
  const BARE_NUM_RE = /^\d+(?:\.\d+)?$/;
  // 最低价标记:列以 `~` 开头(如 `~75` / `~75.5`),抽出后剩余列继续按 1-9 格式分类
  const MIN_PRICE_RE = /^~/;
  // 严格校验 `~<num>` 形态:必须 `~` 后纯数字(可带 1 个小数点)。
  // 不复用 asNumber() — asNumber 会剥非数字字符,会让 `~~75` / `~abc75` / `~75руб` 静默通过。
  const MIN_PRICE_STRICT_RE = /^~\d+(\.\d+)?$/;

  function splitCols(line) {
    return line
      .split(/[,，\t]|\s{2,}/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  function asNumber(s) {
    if (!s) return null;
    const n = Number(String(s).replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(n) ? n : null;
  }

  // 把一列解析成「带单位的数值」:返回 {num, unit:'weight'|'length'|null};
  // 不是纯数值(含单位以外的字母/结构)→ 返回 null,视为货号/文本。
  function parseValueToken(s) {
    const t = String(s == null ? "" : s).trim();
    let m;
    if ((m = WEIGHT_TOKEN_RE.exec(t))) return { num: parseFloat(m[1]), unit: "weight" };
    if ((m = LENGTH_TOKEN_RE.exec(t))) return { num: parseFloat(m[1]), unit: "length" };
    if (BARE_NUM_RE.test(t)) return { num: parseFloat(t), unit: null };
    return null;
  }

  function classifyNumeric(nums, units) {
    units = units || [];
    if (nums.length === 0) return { kind: "unknown" };
    if (nums.length === 1) {
      // 显式单位优先:g→重量,mm→长度。无单位才按 ≤3000→长度 / >3000→重量 猜测。
      if (units[0] === "weight") return { kind: "weight", weight: nums[0] };
      if (units[0] === "length") return { kind: "dim1", l: nums[0] };
      if (nums[0] <= 3000) return { kind: "dim1", l: nums[0] };
      return { kind: "weight", weight: nums[0] };
    }
    if (nums.length === 2) return { kind: "dim2", l: nums[0], w: nums[1] };
    if (nums.length === 3) return { kind: "dim3", l: nums[0], w: nums[1], h: nums[2] };
    if (nums.length === 4) {
      return { kind: "w-dim3", weight: nums[0], l: nums[1], w: nums[2], h: nums[3] };
    }
    return { kind: "unknown" };
  }

  function emptyRow(index, raw) {
    return {
      index,
      raw: raw || "",
      sku: "",
      price: null,
      minPrice: null,
      offerId: null,
      weightG: null,
      lengthMm: null,
      widthMm: null,
      heightMm: null,
      formatHint: 0,
      valid: false,
      reason: null,
    };
  }

  function parseLine(line, index) {
    if (index == null) index = 0;
    const trimmed = String(line || "").trim();
    if (!trimmed) return Object.assign(emptyRow(index, line), { reason: "空行" });

    const cols = splitCols(trimmed);
    if (cols.length < 2) {
      return Object.assign(emptyRow(index, trimmed), {
        sku: cols[0] || "",
        reason: "至少 2 列：sku, 售价",
      });
    }

    const sku = cols[0];
    if (!SKU_RE.test(sku)) {
      return Object.assign(emptyRow(index, trimmed), {
        sku,
        reason: "SKU 格式不合法（应是 6-16 位纯数字）",
      });
    }

    const price = asNumber(cols[1]);
    if (!price || price <= 0) {
      return Object.assign(emptyRow(index, trimmed), {
        sku,
        reason: "售价必须大于 0",
      });
    }

    const row = Object.assign(emptyRow(index, trimmed), {
      sku,
      price,
      valid: true,
    });

    if (cols.length === 2) {
      return Object.assign(row, { formatHint: 1 });
    }

    // 先把所有 `~` 前缀列抽出来作为最低价(多个 ~ 列只保留第一个;非数值/<=0 报错)。
    // 抽出后剩余列继续按 1-9 既有定位语义分类,所以 ~ 可与任意组合共存。
    let minPrice = null;
    const rest0 = cols.slice(2);
    const rest = [];
    for (const c of rest0) {
      if (MIN_PRICE_RE.test(c)) {
        if (minPrice != null) {
          return Object.assign(row, {
            valid: false,
            reason: "最低价(~)只能出现一次",
          });
        }
        // 严格正则:挡掉 `~~75` / `~abc75` / `~75руб` 等 asNumber 会静默吞掉的非法形态
        if (!MIN_PRICE_STRICT_RE.test(c)) {
          return Object.assign(row, {
            valid: false,
            reason: `最低价格式无效: "${c}"(应为 ~数字,如 ~75 或 ~75.5)`,
          });
        }
        const mp = Number(c.slice(1));
        if (!Number.isFinite(mp) || mp <= 0) {
          return Object.assign(row, {
            valid: false,
            reason: `最低价必须 > 0: "${c}"`,
          });
        }
        if (mp > price) {
          return Object.assign(row, {
            valid: false,
            reason: `最低价(${mp})不应大于售价(${price})`,
          });
        }
        minPrice = mp;
      } else {
        rest.push(c);
      }
    }
    if (minPrice != null) row.minPrice = minPrice;

    // 仅有 sku + 售价 + ~最低价 三段(其余列已被抽走)→ format 10
    if (minPrice != null && rest.length === 0) {
      return Object.assign(row, { formatHint: 10 });
    }

    // 货号判定:rest[0] 若不是「数值(可带 g/mm 单位)」才算货号 —— 这样 "45g"/"45mm"
    // 这类带单位的数不会被当成货号(旧 OFFER_ID_RE 见字母即货号的 bug)。
    const offerCandidate = rest[0];
    let offerId = null;
    let valueCols = rest;
    if (offerCandidate != null && parseValueToken(offerCandidate) == null) {
      offerId = offerCandidate;
      valueCols = rest.slice(1);
    }

    const nums = [];
    const units = []; // 与 nums 对齐:'weight' | 'length' | null
    const numericOffset = 2 + (offerId ? 1 : 0);
    for (let i = 0; i < valueCols.length; i++) {
      const c = valueCols[i];
      const tok = parseValueToken(c);
      if (tok == null || tok.num < 0) {
        return Object.assign(row, {
          offerId,
          valid: false,
          reason: `第 ${numericOffset + i + 1} 列不是有效数值: "${c}"`,
        });
      }
      nums.push(tok.num);
      units.push(tok.unit);
    }

    const cls = classifyNumeric(nums, units);
    const hasOffer = offerId != null;

    if (cls.kind === "unknown") {
      if (hasOffer && nums.length === 0) {
        return Object.assign(row, { offerId, formatHint: 2 });
      }
      return Object.assign(row, { offerId, valid: false, reason: "列数过多或无法识别" });
    }

    if (cls.kind === "dim1") {
      // 含货号时单个数字只可能是重量(格式 8)—— 不存在"货号 + 长度"格式;
      // ≤3000→长度 的猜测只在无货号(格式 4 vs 3 消歧)时才适用。
      if (hasOffer) return Object.assign(row, { offerId, weightG: cls.l, formatHint: 8 });
      return Object.assign(row, { lengthMm: cls.l, formatHint: 4 });
    }
    if (cls.kind === "weight") {
      return Object.assign(row, {
        offerId,
        weightG: cls.weight,
        formatHint: hasOffer ? 8 : 3,
      });
    }
    if (cls.kind === "dim2") {
      if (!hasOffer) {
        return Object.assign(row, { lengthMm: cls.l, widthMm: cls.w, formatHint: 5 });
      }
      return Object.assign(row, {
        offerId,
        valid: false,
        reason: "含货号时第二段数字应为 重量+长×宽×高 (4 个)",
      });
    }
    if (cls.kind === "dim3") {
      if (!hasOffer) {
        return Object.assign(row, {
          lengthMm: cls.l,
          widthMm: cls.w,
          heightMm: cls.h,
          formatHint: 6,
        });
      }
      return Object.assign(row, {
        offerId,
        valid: false,
        reason: "含货号时尺寸前应有重量列（共 4 列数字）",
      });
    }
    if (cls.kind === "w-dim3") {
      if (!hasOffer) {
        return Object.assign(row, {
          weightG: cls.weight,
          lengthMm: cls.l,
          widthMm: cls.w,
          heightMm: cls.h,
          formatHint: 7,
        });
      }
      return Object.assign(row, {
        offerId,
        weightG: cls.weight,
        lengthMm: cls.l,
        widthMm: cls.w,
        heightMm: cls.h,
        formatHint: 9,
      });
    }
    return Object.assign(row, { offerId, valid: false, reason: "未知格式" });
  }

  function parseQuickListText(text) {
    return String(text || "")
      .split(/\r?\n/)
      .map((line, i) => parseLine(line, i + 1))
      .filter((r) => r.raw.length > 0);
  }

  const FORMAT_LABELS = {
    1: "sku, 售价",
    2: "sku, 售价, 自定义货号",
    3: "sku, 售价, 重量g",
    4: "sku, 售价, 长度mm",
    5: "sku, 售价, 长度mm, 宽度mm",
    6: "sku, 售价, 长度mm, 宽度mm, 高度mm",
    7: "sku, 售价, 重量g, 长度mm, 宽度mm, 高度mm",
    8: "sku, 售价, 自定义货号, 重量g",
    9: "sku, 售价, 自定义货号, 重量g, 长度mm, 宽度mm, 高度mm",
    10: "sku, 售价, ~最低价",
  };

  function genSalt() {
    return Math.random().toString(36).slice(2, 8);
  }

  root.JZQuickListParser = {
    parseLine,
    parseQuickListText,
    FORMAT_LABELS,
    genSalt,
  };
})(typeof self !== "undefined" ? self : window);
