import assert from "node:assert/strict";
import test from "node:test";
import {
  MESSAGE_VARIABLES,
  MESSAGE_TRIGGERS,
  defaultMessageTemplates,
  normalizeMessageTemplate,
  renderMessageTemplate,
} from "../message-template.mjs";

const template = {
  name: "包裹通知",
  trigger: "PICKUP",
  delayHours: 0,
  enabled: false,
  text: "Заказ {{订单编号}}: {{商品清单}}",
};
const posting = {
  orderNumber: "100-200",
  postingNumber: "100-200-1",
  products: [{ name: "Чашка", quantity: 2 }, { name: "Блюдце", quantity: 1 }],
  trackingNumber: "RU123456789",
  events: { PICKUP: "2026-09-10T21:30:00Z", REVIEW: "2026-09-11T22:00:00Z" },
};
const invalidError = { status: 400, code: "MESSAGE_TEMPLATE_INVALID" };

test("variable metadata names exactly the supported buyer-facing values", () => {
  assert.deepEqual(MESSAGE_VARIABLES.map(({ key }) => key), [
    "订单编号", "包裹编号", "商品清单", "物流单号", "店铺名称", "到店日期", "签收日期",
  ]);
  for (const variable of MESSAGE_VARIABLES) {
    assert.equal(typeof variable.label, "string");
    assert.ok(variable.label.trim());
    assert.equal(typeof variable.description, "string");
    assert.ok(variable.description.trim());
  }
  assert.deepEqual(MESSAGE_TRIGGERS.map(({ value }) => value), [
    "PICKUP", "REVIEW", "SHIPPING_READY", "SHIPPED",
  ]);
  for (const trigger of MESSAGE_TRIGGERS) assert.ok(trigger.label.trim());
});

test("four fresh Russian defaults are disabled, normalizable and renderable", () => {
  const defaults = defaultMessageTemplates();
  assert.deepEqual(defaults.map(({ trigger }) => trigger), [
    "PICKUP", "REVIEW", "SHIPPING_READY", "SHIPPED",
  ]);
  for (const value of defaults) {
    assert.deepEqual(Object.keys(value).sort(), ["delayHours", "enabled", "name", "text", "trigger", "version"]);
    assert.equal(value.enabled, false);
    assert.equal(value.version, 1);
    assert.match(value.text, /[А-Яа-яЁё]/u);
    assert.deepEqual(normalizeMessageTemplate(value), value);
    assert.equal(renderMessageTemplate(value, posting, { displayName: "Лавка" }).valid, true);
  }
  defaults[0].enabled = true;
  defaults[0].text = "Изменено";
  assert.equal(defaultMessageTemplates()[0].enabled, false);
  assert.notEqual(defaultMessageTemplates()[0].text, "Изменено");
});

test("default copy distinguishes preparation from delivery handoff and requests honest reviews", () => {
  const defaults = defaultMessageTemplates();
  const ready = defaults.find(({ trigger }) => trigger === "SHIPPING_READY").text;
  const shipped = defaults.find(({ trigger }) => trigger === "SHIPPED").text;
  const review = defaults.find(({ trigger }) => trigger === "REVIEW").text;
  assert.match(ready, /готов[а-я]* к (?:отправке|передаче)/u);
  assert.doesNotMatch(ready, /передан[а-я]* (?:в службу доставки|службе доставки)/u);
  assert.match(shipped, /передан[а-я]* (?:в службу доставки|службе доставки)/u);
  assert.match(review, /честн[а-я]* отзыв/u);
  assert.doesNotMatch(review, /положительн|5 зв[её]зд|пять зв[её]зд|бонус|наград|скидк/iu);
});

test("normalization returns only material fields and a server-owned initial version", () => {
  const input = Object.freeze({ ...template, name: "  包裹通知  ", text: " Спасибо!\n ", id: "ignored", version: 99 });
  assert.deepEqual(normalizeMessageTemplate(input), {
    name: "包裹通知", trigger: "PICKUP", delayHours: 0, enabled: false, text: " Спасибо!\n ", version: 1,
  });
});

test("name and literal template limits count Unicode codepoints without cutting text", () => {
  const input = { ...template, name: "🛍".repeat(80), text: "🧩".repeat(1000) };
  assert.equal(normalizeMessageTemplate(input).text, input.text);
  assert.throws(() => normalizeMessageTemplate({ ...input, name: `${input.name}店` }), invalidError);
  assert.throws(() => normalizeMessageTemplate({ ...input, text: `${input.text} ` }), invalidError);
  assert.throws(() => normalizeMessageTemplate({ ...template, text: `${"а".repeat(1000)}{{订单编号}}` }), invalidError);
});

test("invalid required fields fail with the public validation error without coercion", () => {
  let coercions = 0;
  const malformed = { toString() { coercions += 1; return "accepted"; } };
  for (const input of [null, undefined, [], "template"]) {
    assert.throws(() => normalizeMessageTemplate(input), invalidError);
  }
  for (const patch of [
    { name: " " }, { name: null }, { name: malformed },
    { text: "\n " }, { text: undefined }, { text: 123 }, { text: malformed },
    { trigger: "DELIVERED" }, { trigger: "pickup" }, { trigger: malformed },
    { enabled: undefined }, { enabled: "false" }, { enabled: 0 },
  ]) assert.throws(() => normalizeMessageTemplate({ ...template, ...patch }), invalidError);
  assert.equal(coercions, 0);
});

test("delays accept finite numeric hours up to 72 but reviews must stay below 72", () => {
  for (const trigger of ["PICKUP", "SHIPPING_READY", "SHIPPED"]) {
    for (const delayHours of [0, 0.5, 72]) {
      assert.equal(normalizeMessageTemplate({ ...template, trigger, delayHours }).delayHours, delayHours);
    }
  }
  assert.equal(normalizeMessageTemplate({ ...template, trigger: "REVIEW", delayHours: 71.999 }).delayHours, 71.999);
  assert.throws(() => normalizeMessageTemplate({ ...template, trigger: "REVIEW", delayHours: 72 }), invalidError);
  for (const delayHours of [undefined, null, "1", false, -0.01, 72.001, NaN, Infinity]) {
    assert.throws(() => normalizeMessageTemplate({ ...template, delayHours }), invalidError);
  }
});

test("unchanged normalized fields preserve version while every material change increments once", () => {
  const previous = Object.freeze({ ...template, version: 7 });
  assert.equal(normalizeMessageTemplate({ ...template, name: " 包裹通知 ", id: "new", version: 90 }, previous).version, 7);
  for (const patch of [
    { name: "催取货" }, { trigger: "SHIPPED" }, { delayHours: 1 },
    { enabled: true }, { text: `${template.text}\nСпасибо!` },
  ]) assert.equal(normalizeMessageTemplate({ ...template, ...patch }, previous).version, 8);
  assert.equal(normalizeMessageTemplate({ ...template, enabled: true, delayHours: 2, text: "Спасибо!" }, previous).version, 8);
  assert.equal(previous.version, 7);
});

test("unknown, malformed and expression tokens cannot be saved or previewed as valid", () => {
  for (const text of [
    "{{未知变量}}", "{{订单编号", "订单编号}}", "{{}}", "{{ 订单编号 }}",
    "{{{订单编号}}}", "{{订单编号}}}", "{{订单编号} }", "{订单编号}",
    "{{订单编号.toString()}}", "{{globalThis.process.exit()}}", '{{订单编号 || "fallback"}}',
    "{{订单编号}} / {{未知变量}}", "{{订单编号}}{{}}{{商品清单}}",
  ]) {
    assert.throws(() => normalizeMessageTemplate({ ...template, text }), invalidError, text);
    const preview = renderMessageTemplate({ text }, posting, { displayName: "Лавка" });
    assert.equal(preview.valid, false, text);
    assert.ok(preview.reason, text);
  }
});

test("all supported values render actual posting data with Russian dates and the manual store name", () => {
  const text = MESSAGE_VARIABLES.map(({ key }) => `{{${key}}}`).join(" | ");
  const result = renderMessageTemplate({ text }, posting, { displayName: "Лавка", name: "Internal store" });
  assert.equal(result.text, "100-200 | 100-200-1 | Чашка × 2\nБлюдце × 1 | RU123456789 | Лавка | 11.09.2026 | 12.09.2026");
  assert.deepEqual(result.missing, []);
  assert.equal(result.valid, true);
  assert.equal(result.reason, "");
  assert.equal(result.characterCount, Array.from(result.text).length);
});

test("split postings for one order render only their own products and quantities", () => {
  const first = renderMessageTemplate(template, posting, {});
  const second = renderMessageTemplate(template, {
    ...posting, postingNumber: "100-200-2", products: [{ name: "Ложка", quantity: 3 }],
  }, {});
  assert.equal(first.text, "Заказ 100-200: Чашка × 2\nБлюдце × 1");
  assert.equal(second.text, "Заказ 100-200: Ложка × 3");
  assert.equal(first.valid, true);
  assert.equal(second.valid, true);
});

test("missing unreferenced optional fields and malformed optional settings do not block", () => {
  const result = renderMessageTemplate({ text: "Заказ {{订单编号}}" }, {
    orderNumber: "100-200", products: null, events: { PICKUP: "bad-date" },
  }, { timeZone: "Invalid/Zone" });
  assert.deepEqual(result, { text: "Заказ 100-200", missing: [], characterCount: 13, valid: true, reason: "" });
  assert.equal(renderMessageTemplate({ text: "Спасибо!" }, null, null).valid, true);
});

test("referenced missing fields are deduplicated and internal store labels are never substituted", () => {
  const result = renderMessageTemplate({ text: "{{物流单号}} / {{店铺名称}} / {{物流单号}}" }, {}, {
    name: "Internal name", label: "Internal label",
  });
  assert.deepEqual(result.missing, ["物流单号", "店铺名称"]);
  assert.equal(result.valid, false);
  assert.match(result.reason, /物流单号/u);
  assert.match(result.reason, /店铺名称/u);
  assert.doesNotMatch(result.text, /Internal/u);
});

test("empty or malformed product entries block the whole referenced product list", () => {
  for (const products of [
    undefined, null, {}, [], [null], [{ name: " ", quantity: 1 }],
    [{ name: {}, quantity: 1 }], [{ name: "Чашка" }],
    ...[null, "", "many", {}, 0, -1, NaN, Infinity].map((quantity) => [{ name: "Чашка", quantity }]),
    [{ name: "Чашка", quantity: 2 }, { name: "Блюдце" }],
  ]) {
    const result = renderMessageTemplate({ text: "{{商品清单}}" }, { products }, {});
    assert.deepEqual(result.missing, ["商品清单"]);
    assert.equal(result.valid, false);
  }
});

test("malformed scalar data is missing and is never arbitrarily stringified", () => {
  let coercions = 0;
  const malformed = { toString() { coercions += 1; return "should not appear"; } };
  const result = renderMessageTemplate({ text: "{{订单编号}} {{包裹编号}} {{物流单号}} {{店铺名称}} {{商品清单}}" }, {
    orderNumber: malformed, postingNumber: [], trackingNumber: false,
    products: [{ name: "Чашка", quantity: malformed }],
  }, { displayName: malformed });
  assert.deepEqual(result.missing, ["订单编号", "包裹编号", "物流单号", "店铺名称", "商品清单"]);
  assert.equal(result.valid, false);
  assert.doesNotMatch(result.text, /\[object Object\]|should not appear|false/u);
  assert.equal(coercions, 0);
});

test("substituted values remain literal text and cannot trigger another variable expansion", () => {
  const result = renderMessageTemplate({ text: "{{订单编号}} / {{店铺名称}}" }, {
    orderNumber: "{{物流单号}}",
  }, { displayName: "Лавка $&" });
  assert.equal(result.text, "{{物流单号}} / Лавка $&");
  assert.equal(result.valid, true);
  assert.deepEqual(result.missing, []);
});

test("rendered length permits exactly 1000 Unicode codepoints and preserves excess text", () => {
  for (const count of [1000, 1001]) {
    const orderNumber = "🧩".repeat(count);
    const result = renderMessageTemplate({ text: "{{订单编号}}" }, { orderNumber }, {});
    assert.equal(result.text, orderNumber);
    assert.equal(result.characterCount, count);
    assert.equal(result.valid, count === 1000);
    assert.deepEqual(result.missing, []);
    if (!result.valid) assert.match(result.reason, /1000/u);
  }
});

test("overlong product lists retain every product and block rather than silently truncate", () => {
  const name = "Ё".repeat(1001);
  const result = renderMessageTemplate({ text: "{{商品清单}}" }, {
    products: [{ name, quantity: 2 }, { name: "Ложка", quantity: 1 }],
  }, {});
  assert.equal(result.text, `${name} × 2\nЛожка × 1`);
  assert.equal(result.characterCount, 1015);
  assert.equal(result.valid, false);
  assert.match(result.reason, /1000/u);
});

test("Russian event dates respect explicit store zones, UTC offsets and daylight saving", () => {
  const value = { text: "{{到店日期}} / {{签收日期}}" };
  assert.equal(renderMessageTemplate(value, posting, {}).text, "11.09.2026 / 12.09.2026");
  assert.equal(renderMessageTemplate(value, posting, { timeZone: "UTC" }).text, "10.09.2026 / 11.09.2026");
  assert.equal(renderMessageTemplate({ text: "{{到店日期}}" }, {
    events: { PICKUP: "2026-09-11T00:30:00+03:00" },
  }, { timeZone: "UTC" }).text, "10.09.2026");
  for (const [PICKUP, expected] of [
    ["2026-01-10T04:30:00Z", "09.01.2026"],
    ["2026-07-10T04:30:00Z", "10.07.2026"],
  ]) {
    assert.equal(renderMessageTemplate({ text: "{{到店日期}}" }, { events: { PICKUP } }, {
      timeZone: "America/New_York",
    }).text, expected);
  }
});

test("dates require their own true event and never fall back to sync or delivery facts", () => {
  const value = { text: "{{到店日期}} / {{签收日期}}" };
  const facts = {
    ...posting, events: {}, status: "delivered", firstSyncAt: "2026-09-10T00:00:00Z",
    syncedAt: "2026-09-10T00:00:00Z", fact_delivery_date: "2026-09-10T00:00:00Z",
    analytics_data: { fact_delivery_date: "2026-09-10T00:00:00Z" },
  };
  const result = renderMessageTemplate(value, facts, {});
  assert.deepEqual(result.missing, ["到店日期", "签收日期"]);
  assert.equal(result.valid, false);
  assert.doesNotMatch(result.text, /10\.09\.2026/u);
  assert.deepEqual(renderMessageTemplate(value, {
    ...facts, events: { PICKUP: posting.events.PICKUP },
  }, {}).missing, ["签收日期"]);
});

test("malformed, impossible and zone-less event dates are missing without coercion", () => {
  for (const date of [
    undefined, null, "", {}, 0, "not-a-date", "09/10/2026", "2026-09-10",
    "2026-09-10T12:00:00", "2026-02-30T12:00:00Z", "2026-13-10T12:00:00Z",
  ]) {
    const result = renderMessageTemplate({ text: "{{到店日期}} / {{签收日期}}" }, {
      events: { PICKUP: date, REVIEW: date },
    }, {});
    assert.deepEqual(result.missing, ["到店日期", "签收日期"]);
    assert.equal(result.valid, false);
  }
});

test("invalid time zones block referenced date previews with a usable reason", () => {
  const result = renderMessageTemplate({ text: "{{到店日期}}" }, posting, { timeZone: "Invalid/Zone" });
  assert.equal(result.valid, false);
  assert.match(result.reason, /时区/u);
});

test("empty and malformed preview text returns an invalid result instead of throwing or coercing", () => {
  for (const value of [undefined, null, {}, { text: null }, { text: [] }, { text: " " }]) {
    const result = renderMessageTemplate(value, posting, {});
    assert.equal(result.valid, false);
    assert.equal(typeof result.text, "string");
    assert.equal(result.characterCount, Array.from(result.text).length);
    assert.ok(result.reason);
  }
});
