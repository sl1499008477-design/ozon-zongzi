// Generated from shared/sale-pricing.mjs; run scripts/build-sale-pricing-extension.mjs.
var SalePricing = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // shared/sale-pricing.mjs
  var sale_pricing_exports = {};
  __export(sale_pricing_exports, {
    DEFAULT_REAL_PRICE_FORMULA: () => DEFAULT_REAL_PRICE_FORMULA,
    DEFAULT_SALE_PRICE_FORMULA: () => DEFAULT_SALE_PRICE_FORMULA,
    amountToSaleMinor: () => amountToSaleMinor,
    calculateRealPrice: () => calculateRealPrice,
    calculateSalePrice: () => calculateSalePrice,
    displaySalePriceFormula: () => displaySalePriceFormula,
    normalizeListingPricingRules: () => normalizeListingPricingRules,
    normalizeRealPricingRules: () => normalizeRealPricingRules,
    normalizeSalePricingRules: () => normalizeSalePricingRules,
    saleMinorToAmount: () => saleMinorToAmount,
    salePriceUsesRealPrice: () => salePriceUsesRealPrice
  });
  var DEFAULT_REAL_PRICE_FORMULA = "IF(\u9ED1\u6807\u4EF7 < 80, \u9ED1\u6807\u4EF7 / 1.0715, IF(\u6709\u7EFF\u6807\u4EF7, (\u9ED1\u6807\u4EF7 - \u7EFF\u6807\u4EF7) * 2.25 + \u9ED1\u6807\u4EF7, \u9ED1\u6807\u4EF7))";
  var DEFAULT_SALE_PRICE_FORMULA = "(\u771F\u5B9E\u552E\u4EF7 + 0) * 1";
  var MAX_MINOR = 9223372036854775807n;
  var fail = (code, message) => Object.assign(new Error(message), { code, status: 422, statusCode: 422 });
  var syntax = (message) => fail("SALE_PRICING_FORMULA_INVALID", message);
  var symbols = { "\uFF08": "(", "\uFF09": ")", "\uFF0B": "+", "\u2212": "-", "\uFF0D": "-", "\xD7": "*", "\xF7": "/", "\uFF0C": "," };
  var clean = (value) => typeof value === "string" ? value.trim().replaceAll("\u7ADE\u54C1\u771F\u5B9E\u552E\u4EF7\u8BA1\u7B97", "\u771F\u5B9E\u552E\u4EF7").replace(/[（）＋−－×÷，]/g, (c) => symbols[c]) : "";
  var displaySalePriceFormula = (value) => String(value ?? "").replace(/竞品真实售价计算|真实售价/g, "\u7ADE\u54C1\u771F\u5B9E\u552E\u4EF7\u8BA1\u7B97");
  var abs = (n) => n < 0n ? -n : n;
  function fraction(n, d = 1n) {
    if (!d) throw fail("SALE_PRICING_DIVISION_BY_ZERO", "\u516C\u5F0F\u4E2D\u51FA\u73B0\u9664\u4EE5 0\uFF0C\u8BF7\u4FEE\u6539\u516C\u5F0F\u6216\u4EF7\u683C\u8F93\u5165");
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    if (abs(n).toString().length > 120 || d.toString().length > 120) throw fail("PRICE_INPUT_INVALID", "\u516C\u5F0F\u8BA1\u7B97\u7ED3\u679C\u8D85\u51FA\u6709\u6548\u8303\u56F4");
    let a = abs(n), b = d;
    while (b) {
      const next = a % b;
      a = b;
      b = next;
    }
    return { n: n / a, d: d / a };
  }
  function decimal(text) {
    const [whole, part = ""] = text.split(".");
    return fraction(BigInt(whole + part), 10n ** BigInt(part.length));
  }
  function parse(text, allowReal) {
    if (!text || text.length > 512) throw syntax("\u516C\u5F0F\u987B\u4E3A 1\uFF5E512 \u5B57");
    const tokens = [];
    let index = 0;
    while (index < text.length) {
      if (/\s/.test(text[index])) {
        index++;
        continue;
      }
      const match = /^(\d+(?:\.\d+)?|[A-Za-z_\u4e00-\u9fff]+|<=|>=|==|!=|[+*/(),<>-])/.exec(text.slice(index));
      if (!match) throw syntax(`\u516C\u5F0F\u542B\u4E0D\u652F\u6301\u7684\u5B57\u7B26\uFF1A${text[index]}`);
      tokens.push(match[0]);
      index += match[0].length;
      if (tokens.length > 160) throw syntax("\u516C\u5F0F\u8FC7\u957F\uFF0C\u8BF7\u7B80\u5316");
    }
    let at = 0, depth = 0;
    const take = (expected) => {
      if (tokens[at++] !== expected) throw syntax(`\u516C\u5F0F\u7F3A\u5C11 ${expected}`);
    };
    const vars = /* @__PURE__ */ new Set(["\u9ED1\u6807\u4EF7", "\u7EFF\u6807\u4EF7", "\u6709\u7EFF\u6807\u4EF7", ...allowReal ? ["\u771F\u5B9E\u552E\u4EF7"] : []]);
    const precedence = { "==": 1, "!=": 1, "<": 1, ">": 1, "<=": 1, ">=": 1, "+": 2, "-": 2, "*": 3, "/": 3 };
    function expression(min = 0) {
      if (++depth > 32) throw syntax("\u516C\u5F0F\u62EC\u53F7\u5C42\u6570\u8FC7\u591A");
      const token = tokens[at++];
      let left;
      if (token === "-" || token === "+") left = { unary: token, value: expression(4) };
      else if (token === "(") {
        left = expression();
        take(")");
      } else if (token === "IF") {
        take("(");
        const condition = expression();
        take(",");
        const yes = expression();
        take(",");
        const no = expression();
        take(")");
        left = { condition, yes, no };
      } else if (token && /^\d/.test(token)) {
        if (!/^\d{1,18}(?:\.\d{1,8})?$/.test(token)) throw syntax("\u5E38\u6570\u6700\u591A 18 \u4F4D\u6574\u6570\u548C 8 \u4F4D\u5C0F\u6570");
        left = { number: decimal(token) };
      } else if (vars.has(token)) left = { variable: token };
      else throw syntax(`\u65E0\u6CD5\u8BC6\u522B\u516C\u5F0F\u4E2D\u7684 ${token || "\u7A7A\u767D"}\uFF0C\u8BF7\u4F7F\u7528\u4EF7\u683C\u53D8\u91CF\u3001\u6570\u5B57\u548C\u8FD0\u7B97\u7B26`);
      while (precedence[tokens[at]] >= min) {
        const operator = tokens[at++];
        left = { operator, left, right: expression(precedence[operator] + 1) };
      }
      depth--;
      return left;
    }
    const ast = expression();
    if (at !== tokens.length) throw syntax(`\u516C\u5F0F\u4E2D\u591A\u51FA ${tokens[at]}`);
    return ast;
  }
  function evaluate(ast, variables) {
    if (ast.number) return ast.number;
    if (ast.variable) {
      const value = variables[ast.variable];
      if (value == null) throw fail("SALE_PRICING_INPUT_MISSING", `\u7F3A\u5C11${ast.variable}\uFF0C\u65E0\u6CD5\u6309\u6B64\u516C\u5F0F\u8BA1\u7B97`);
      return value;
    }
    if (ast.condition) return evaluate(evaluate(ast.condition, variables).n !== 0n ? ast.yes : ast.no, variables);
    if (ast.unary) {
      const v = evaluate(ast.value, variables);
      return ast.unary === "-" ? fraction(-v.n, v.d) : v;
    }
    const a = evaluate(ast.left, variables), b = evaluate(ast.right, variables);
    const left = a.n * b.d, right = b.n * a.d;
    switch (ast.operator) {
      case "+":
        return fraction(left + right, a.d * b.d);
      case "-":
        return fraction(left - right, a.d * b.d);
      case "*":
        return fraction(a.n * b.n, a.d * b.d);
      case "/":
        return fraction(a.n * b.d, a.d * b.n);
      default:
        return fraction(BigInt({ "==": left === right, "!=": left !== right, "<": left < right, ">": left > right, "<=": left <= right, ">=": left >= right }[ast.operator]));
    }
  }
  function currencyRule(currency) {
    if (!["CNY", "RUB"].includes(currency)) throw fail("SALE_PRICING_CURRENCY_INVALID", "\u8BF7\u9009\u62E9\u4EBA\u6C11\u5E01\u6216\u5362\u5E03");
    return currency;
  }
  function normalizeRealPricingRules(raw = {}) {
    const realPriceFormula = clean(raw.realPriceFormula);
    parse(realPriceFormula, false);
    return { currency: currencyRule(raw.currency), realPriceFormula };
  }
  function normalizeListingPricingRules(raw = {}) {
    const salePriceFormula = clean(raw.salePriceFormula);
    parse(salePriceFormula, true);
    return { currency: currencyRule(raw.currency), salePriceFormula };
  }
  function normalizeSalePricingRules(raw = {}) {
    return { ...normalizeRealPricingRules(raw), ...normalizeListingPricingRules(raw) };
  }
  function salePriceUsesRealPrice(formula) {
    const visit = (ast) => ast.variable === "\u771F\u5B9E\u552E\u4EF7" || Object.values(ast).some((value) => value && typeof value === "object" && visit(value));
    return visit(parse(clean(formula), true));
  }
  function amountToSaleMinor(value) {
    const text = String(value ?? "").trim();
    if (!/^\d{1,17}(?:\.\d{1,2})?$/.test(text)) throw fail("PRICE_INPUT_INVALID", "\u4EF7\u683C\u987B\u4E3A\u6B63\u6570\uFF0C\u6700\u591A\u4E24\u4F4D\u5C0F\u6570");
    const [whole, part = ""] = text.split(".");
    return String(BigInt(whole) * 100n + BigInt(part.padEnd(2, "0")));
  }
  function saleMinorToAmount(value) {
    const n = BigInt(value);
    return `${n < 0n ? "-" : ""}${abs(n) / 100n}.${String(abs(n) % 100n).padStart(2, "0")}`;
  }
  function minor(value, required = false) {
    if (value == null || value === "") {
      if (required) throw fail("SALE_PRICING_INPUT_MISSING", "\u7F3A\u5C11\u5546\u54C1\u4EF7\u683C");
      return null;
    }
    if (!/^\d{1,19}$/.test(String(value))) throw fail("PRICE_INPUT_INVALID", "\u5546\u54C1\u4EF7\u683C\u65E0\u6548");
    const n = BigInt(value);
    if (n <= 0n || n > MAX_MINOR) throw fail("PRICE_INPUT_INVALID", "\u5546\u54C1\u4EF7\u683C\u987B\u5927\u4E8E 0 \u4E14\u5728\u6709\u6548\u8303\u56F4\u5185");
    return fraction(n, 100n);
  }
  function roundedMinor(value) {
    const n = (abs(value.n) * 100n * 2n + value.d) / (value.d * 2n) * (value.n < 0n ? -1n : 1n);
    if (abs(n) > MAX_MINOR) throw fail("PRICE_INPUT_INVALID", "\u516C\u5F0F\u8BA1\u7B97\u7ED3\u679C\u8D85\u51FA\u6709\u6548\u8303\u56F4");
    return n;
  }
  function priceVariables(input) {
    return {
      get \u9ED1\u6807\u4EF7() {
        return minor(input.blackKopecks ?? input.sourcePriceKopecks, true);
      },
      get \u7EFF\u6807\u4EF7() {
        const green = minor(input.greenKopecks);
        if (green) {
          const black = this.\u9ED1\u6807\u4EF7;
          if (green.n * black.d > black.n * green.d) throw fail("PRICE_INPUT_INVALID", "\u7EFF\u6807\u4EF7\u4E0D\u80FD\u9AD8\u4E8E\u9ED1\u6807\u4EF7");
        }
        return green;
      },
      "\u6709\u7EFF\u6807\u4EF7": fraction(input.greenKopecks != null && input.greenKopecks !== "" ? 1n : 0n)
    };
  }
  function checkCurrency(rules, input) {
    if (input.currency !== rules.currency) throw fail("SALE_PRICING_CURRENCY_MISMATCH", "\u552E\u4EF7\u914D\u7F6E\u5E01\u79CD\u4E0E\u5546\u54C1 / \u5E97\u94FA\u5E01\u79CD\u4E0D\u4E00\u81F4\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9\u914D\u7F6E");
  }
  function calculateRealPrice(rules, input) {
    checkCurrency(rules, input);
    const real = roundedMinor(input.sourcePriceKopecks != null ? minor(input.sourcePriceKopecks, true) : evaluate(parse(clean(rules.realPriceFormula), false), priceVariables(input)));
    if (real <= 0n) throw fail("PRICE_FINAL_NOT_POSITIVE", "\u7ADE\u54C1\u771F\u5B9E\u552E\u4EF7\u8BA1\u7B97\u7ED3\u679C\u4E0D\u5927\u4E8E 0");
    return { currency: rules.currency, realPriceKopecks: String(real) };
  }
  function calculateSalePrice(rules, input) {
    checkCurrency(rules, input);
    const variables = priceVariables(input);
    let real = null;
    const readReal = () => {
      if (real === null) real = BigInt(calculateRealPrice({ ...rules, currency: rules.realPricingCurrency || rules.currency }, input).realPriceKopecks);
      return fraction(real, 100n);
    };
    if (rules.pricingVersion !== 2) readReal();
    Object.defineProperty(variables, "\u771F\u5B9E\u552E\u4EF7", { get: readReal });
    const final = roundedMinor(evaluate(parse(clean(rules.salePriceFormula), true), variables));
    if (final <= 0n) throw fail("PRICE_FINAL_NOT_POSITIVE", "\u516C\u5F0F\u8BA1\u7B97\u540E\u7684\u552E\u4EF7\u4E0D\u5927\u4E8E 0");
    return { currency: rules.currency, branch: "SALE_PRICING_PROFILE", realPriceKopecks: real === null ? null : String(real), finalPriceKopecks: String(final) };
  }
  return __toCommonJS(sale_pricing_exports);
})();
