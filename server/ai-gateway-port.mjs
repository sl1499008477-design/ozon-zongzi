import { createAiModelCatalogPort } from "./ai-model-catalog-port.mjs";

function diagnosticToken(value, { model = false } = {}) {
  if (typeof value !== "string") return "";
  const token = value.trim();
  const allowed = model ? /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$/u : /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
  return allowed.test(token) && !token.includes("://") && !/^(?:sk|sess|bearer)[-_]/iu.test(token) ? token : "";
}

// Persist this projection, never a provider response body or Error stack. Adapter
// messages are fixed application text; upstream messages can echo paid prompts.
export function getAiGatewayDiagnostic(error) {
  if (!(error instanceof AiGatewayError)) return null;
  return {
    code: diagnosticToken(error.code),
    requestId: diagnosticToken(error.requestId),
    httpStatus: Number.isInteger(error.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599 ? error.httpStatus : null,
    upstreamCode: diagnosticToken(error.upstreamCode),
    message: error.message.slice(0, 300),
    requestedModel: diagnosticToken(error.requestedModel, { model: true }),
    reportedModel: diagnosticToken(error.reportedModel, { model: true }),
    deliveryState: ["NOT_SENT", "POSSIBLY_SENT"].includes(error.deliveryState) ? error.deliveryState : null,
  };
}

export class AiGatewayError extends Error {
  constructor(code, { retryable = false, status = null, httpStatus = status, requestId = "", message = "AI 网关调用失败", upstreamCode = "", requestedModel = "", reportedModel = "" } = {}) {
    super(message);
    this.name = "AiGatewayError";
    this.code = code;
    this.retryable = Boolean(retryable);
    this.status = Number.isInteger(status) ? status : null;
    this.requestId = diagnosticToken(requestId);
    this.httpStatus = Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null;
    this.upstreamCode = diagnosticToken(upstreamCode);
    this.requestedModel = diagnosticToken(requestedModel, { model: true });
    this.reportedModel = diagnosticToken(reportedModel, { model: true });
  }

  get diagnostic() { return getAiGatewayDiagnostic(this); }
}

export function createAiGatewayPort({
  createTextResponse,
  generateImage,
  inspectImage,
  listModels,
  testCapabilities,
} = {}) {
  const operations = { createTextResponse, generateImage, inspectImage, testCapabilities };
  for (const [name, operation] of Object.entries(operations)) {
    if (typeof operation !== "function") throw new TypeError(`AI gateway operation ${name} is required`);
  }
  return Object.freeze({ ...operations, ...createAiModelCatalogPort({ listModels }) });
}
