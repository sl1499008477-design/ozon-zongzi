export class AiGatewayError extends Error {
  constructor(code, { retryable = false, status = null, requestId = "", message = "AI 网关调用失败" } = {}) {
    super(message);
    this.name = "AiGatewayError";
    this.code = code;
    this.retryable = Boolean(retryable);
    this.status = Number.isInteger(status) ? status : null;
    this.requestId = typeof requestId === "string" ? requestId : "";
  }
}

export function createAiGatewayPort({
  createTextResponse,
  generateImage,
  inspectImage,
  testCapabilities,
} = {}) {
  const operations = { createTextResponse, generateImage, inspectImage, testCapabilities };
  for (const [name, operation] of Object.entries(operations)) {
    if (typeof operation !== "function") throw new TypeError(`AI gateway operation ${name} is required`);
  }
  return Object.freeze({ ...operations });
}
