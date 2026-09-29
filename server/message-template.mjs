export const MESSAGE_VARIABLES = Object.freeze([
  { key: "订单编号", label: "订单编号", description: "当前包裹所属的订单编号。" },
  { key: "包裹编号", label: "包裹编号", description: "当前包裹的编号，拆分包裹分别显示。" },
  { key: "商品清单", label: "商品清单", description: "当前包裹的全部商品名称与数量，每件商品单独一行。" },
  { key: "物流单号", label: "物流单号", description: "当前包裹的物流追踪单号。" },
  { key: "店铺名称", label: "店铺名称", description: "在消息设置中手动填写的面向买家的店铺名称。" },
  { key: "到店日期", label: "到店日期", description: "真实到店事件的日期，按店铺时区以俄文日期格式显示。" },
  { key: "签收日期", label: "签收日期", description: "真实买家签收事件的日期，按店铺时区以俄文日期格式显示。" },
].map(Object.freeze));

export const MESSAGE_TRIGGERS = Object.freeze([
  { value: "PICKUP", label: "到店催取货" },
  { value: "REVIEW", label: "签收后邀请评价" },
  { value: "SHIPPING_READY", label: "备货完成" },
  { value: "SHIPPED", label: "已交付物流" },
].map(Object.freeze));

const variableKeys = new Set(MESSAGE_VARIABLES.map(({ key }) => key));
const triggers = new Set(MESSAGE_TRIGGERS.map(({ value }) => value));

export function defaultMessageTemplates() {
  return [
    {
      name: "到店提醒", trigger: "PICKUP", delayHours: 0,
      text: "Здравствуйте! Посылка {{包裹编号}} по заказу {{订单编号}} находится в пункте выдачи с {{到店日期}}.\nТовары:\n{{商品清单}}\nПожалуйста, заберите её в удобное время в пределах срока хранения, указанного в Ozon.\n{{店铺名称}}",
    },
    {
      name: "邀请真实评价", trigger: "REVIEW", delayHours: 24,
      text: "Здравствуйте! Спасибо за покупку в {{店铺名称}}.\nТовары из заказа {{订单编号}}:\n{{商品清单}}\nЕсли вы уже попробовали их, будем благодарны за честный отзыв о вашем опыте.",
    },
    {
      name: "备货完成通知", trigger: "SHIPPING_READY", delayHours: 0,
      text: "Здравствуйте! Посылка {{包裹编号}} по заказу {{订单编号}} готова к передаче в службу доставки.\nТовары:\n{{商品清单}}\n{{店铺名称}}",
    },
    {
      name: "已交付物流通知", trigger: "SHIPPED", delayHours: 0,
      text: "Здравствуйте! Посылка {{包裹编号}} по заказу {{订单编号}} передана в службу доставки.\nТовары:\n{{商品清单}}\nСтатус доставки можно посмотреть в Ozon.\n{{店铺名称}}",
    },
  ].map((template) => ({ ...template, enabled: false, version: 1 }));
}

function nonemptyText(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function inspectTemplateText(text) {
  if (nonemptyText(text) === undefined) return { keys: [], reason: "消息正文不能为空，且必须是文本。" };
  const keys = new Set();
  for (const [, key] of text.matchAll(/\{\{([^{}]*)\}\}|[{}]/gu)) {
    if (key === undefined) return { keys: [], reason: "变量格式无效，请使用 {{变量名}}。" };
    if (!variableKeys.has(key)) return { keys: [], reason: `未知变量：${key || "（空）"}。` };
    keys.add(key);
  }
  return { keys: [...keys], reason: "" };
}

function invalidTemplate(message) {
  return Object.assign(new Error(message), { status: 400, code: "MESSAGE_TEMPLATE_INVALID" });
}

export function normalizeMessageTemplate(input, previous) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw invalidTemplate("消息模板必须是对象。");
  }
  if (nonemptyText(input.name) === undefined || Array.from(input.name.trim()).length > 80) {
    throw invalidTemplate("模板名称不能为空，且不能超过 80 个字符。");
  }
  if (!triggers.has(input.trigger)) throw invalidTemplate("消息触发类型无效。");
  if (typeof input.delayHours !== "number" || !Number.isFinite(input.delayHours)
    || input.delayHours < 0 || input.delayHours > 72
    || (input.trigger === "REVIEW" && input.delayHours >= 72)) {
    throw invalidTemplate("延时必须为 0 到 72 小时的数字，评价邀请必须小于 72 小时。");
  }
  if (typeof input.enabled !== "boolean") throw invalidTemplate("模板启用状态必须是布尔值。");
  const { reason } = inspectTemplateText(input.text);
  if (reason) throw invalidTemplate(reason);
  if (Array.from(input.text).length > 1000) throw invalidTemplate("消息正文不能超过 1000 个字符。");

  const normalized = {
    name: input.name.trim(), trigger: input.trigger, delayHours: input.delayHours,
    enabled: input.enabled, text: input.text,
  };
  const changed = previous && Object.keys(normalized).some((key) => normalized[key] !== previous[key]);
  return { ...normalized, version: previous ? (previous.version ?? 1) + Number(changed) : 1 };
}

function productList(products) {
  if (!Array.isArray(products) || products.length === 0) return undefined;
  const lines = [];
  for (const product of products) {
    if (nonemptyText(product?.name) === undefined
      || !Number.isSafeInteger(product?.quantity) || product.quantity <= 0) return undefined;
    lines.push(`${product.name} × ${product.quantity}`);
  }
  return lines.join("\n");
}

function eventDate(value) {
  if (typeof value !== "string") return undefined;
  // Require an absolute ISO event time; Date.parse alone also accepts ambiguous dates.
  const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.exec(value);
  if (!match) return undefined;
  const date = new Date(value);
  const day = new Date(`${match[1]}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(day.getTime())
    || day.toISOString().slice(0, 10) !== match[1]) return undefined;
  return date;
}

export function renderMessageTemplate(template, posting, settings) {
  const source = typeof template?.text === "string" ? template.text : "";
  const inspected = inspectTemplateText(source);
  const missing = [];
  const values = new Map();
  let reason = inspected.reason;
  let dateFormatter;

  // Resolve only referenced keys, once each. Optional posting fields stay optional.
  for (const key of inspected.keys) {
    let value;
    switch (key) {
      case "订单编号": value = nonemptyText(posting?.orderNumber); break;
      case "包裹编号": value = nonemptyText(posting?.postingNumber); break;
      case "商品清单": value = productList(posting?.products); break;
      case "物流单号": value = nonemptyText(posting?.trackingNumber); break;
      case "店铺名称": value = nonemptyText(settings?.displayName); break;
      case "到店日期":
      case "签收日期": {
        const date = eventDate(posting?.events?.[key === "到店日期" ? "PICKUP" : "REVIEW"]);
        if (!date) break;
        const timeZone = settings?.timeZone ?? "Europe/Moscow";
        if (typeof timeZone !== "string") {
          reason = "店铺时区无效。";
          continue;
        }
        try {
          dateFormatter ??= new Intl.DateTimeFormat("ru-RU", {
            timeZone, year: "numeric", month: "2-digit", day: "2-digit",
            calendar: "gregory", numberingSystem: "latn",
          });
          value = dateFormatter.format(date);
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
          reason = "店铺时区无效。";
          continue;
        }
        break;
      }
    }
    if (value === undefined) missing.push(key);
    else values.set(key, value);
  }

  // Keep missing tokens visible and never reinterpret braces inside substituted data.
  const text = source.replace(/\{\{([^{}]*)\}\}/gu, (token, key) => values.get(key) ?? token);
  const characterCount = Array.from(text).length;
  if (!reason && missing.length) reason = `缺少变量：${missing.join("、")}。`;
  if (!reason && characterCount > 1000) reason = "渲染后的消息不能超过 1000 个字符。";
  return { text, missing, characterCount, valid: !reason, reason };
}
