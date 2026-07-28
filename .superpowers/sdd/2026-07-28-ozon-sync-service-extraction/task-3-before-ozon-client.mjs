const OZON_API_BASE = process.env.OZON_API_BASE || "https://api-seller.ozon.ru";

function shortText(value, max = 600) {
  return String(value ?? "").trim().slice(0, max);
}

function networkError(apiPath, error, timeoutMs, phase = "请求") {
  const aborted = error?.name === "AbortError";
  const detail = shortText(error?.cause?.message || error?.message || error, 500);
  const code = shortText(error?.cause?.code || error?.code, 80);
  const next = new Error(
    aborted
      ? `Ozon API 请求超时：${apiPath}（${timeoutMs}ms）`
      : `Ozon API ${phase}失败：${apiPath}${code ? `（${code}）` : ""}${detail ? `：${detail}` : ""}`,
  );
  next.status = aborted ? 504 : 502;
  next.code = code || (aborted ? "OZON_TIMEOUT" : "OZON_NETWORK_ERROR");
  next.body = {
    apiPath,
    network: true,
    code: next.code,
    detail,
    phase,
  };
  next.cause = error;
  return next;
}

export async function callOzonSellerApi(store, apiPath, body, timeoutMs = 60000) {
  if (!store?.clientId || !store?.apiKey) {
    const error = new Error("Ozon Client ID / API Key 未配置");
    error.status = 400;
    error.code = "OZON_CREDENTIALS_MISSING";
    throw error;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetch(`${OZON_API_BASE}${apiPath}`, {
        method: "POST",
        headers: {
          "Client-Id": String(store.clientId),
          "Api-Key": String(store.apiKey),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body || {}),
        signal: controller.signal,
      });
    } catch (error) {
      throw networkError(apiPath, error, timeoutMs);
    }
    let responseText = "";
    try {
      responseText = await response.text();
    } catch (error) {
      throw networkError(apiPath, error, timeoutMs, "读取响应");
    }
    let data = null;
    try {
      data = responseText ? JSON.parse(responseText) : null;
    } catch {
      data = { raw: responseText };
    }
    if (!response.ok) {
      const error = new Error(`Ozon ${response.status}: ${responseText.slice(0, 500)}`);
      error.status = response.status;
      error.code = `OZON_HTTP_${response.status}`;
      error.body = data;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}
