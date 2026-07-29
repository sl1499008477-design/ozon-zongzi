const localApiBase = String(import.meta.env?.VITE_LOCAL_API_BASE || "/api").replace(/\/$/, "");

export function apiResponseError(response = {}, data = null) {
  return Object.assign(
    new Error(data?.message || data?.error || `HTTP ${response.status}`),
    {
      status: Number(response.status) || 0,
      code: data?.code || "",
      body: data,
    },
  );
}

export const apiRequest = async (path, options = {}) => {
  const token = localStorage.getItem("token");
  const response = await fetch(`${localApiBase}${path}`, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw apiResponseError(response, data);
  }
  return data;
};

export const postMessageRequest = (message, responseKey, timeoutMs = 1200) =>
  new Promise((resolve, reject) => {
    const id = message.id || `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("浏览器插件未响应"));
    }, timeoutMs);
    const onMessage = (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data[responseKey] !== 1 || data.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      if (data.ok === false) reject(new Error(data.error || "插件返回失败"));
      else resolve(data);
    };
    window.addEventListener("message", onMessage);
    window.postMessage({ ...message, id }, window.location.origin);
  });
