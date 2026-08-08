import dns from "node:dns/promises";
import net from "node:net";

function boundaryError(code, retryable = false) {
  const error = new Error(code === "SUB2API_GATEWAY_DNS_FAILED"
    ? "AI 网关域名暂时无法验证" : "AI 网关地址不符合安全边界");
  error.code = code;
  error.retryable = retryable;
  return error;
}

const SECRET_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,119}$/u;

function iterableValues(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value) || value instanceof Set) return [...value];
  throw boundaryError("SUB2API_GATEWAY_POLICY_INVALID");
}

function hostText(value) {
  return String(value || "").trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
}

function ipv4Parts(value) {
  if (net.isIP(value) !== 4) return null;
  return value.split(".").map(Number);
}

function mappedIpv4Parts(value) {
  const host = hostText(value);
  if (!host.startsWith("::ffff:")) return null;
  const tail = host.slice("::ffff:".length);
  const dotted = ipv4Parts(tail);
  if (dotted) return dotted;
  const match = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!match) return null;
  const high = Number.parseInt(match[1], 16);
  const low = Number.parseInt(match[2], 16);
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff];
}

function expandedIpv6Parts(value) {
  const host = hostText(value);
  if (net.isIP(host) !== 6) return null;
  const halves = host.split("::");
  if (halves.length > 2) return null;
  const parseHalf = (part) => part ? part.split(":").filter(Boolean).map((token) => Number.parseInt(token, 16)) : [];
  const left = parseHalf(halves[0]);
  const right = halves.length === 2 ? parseHalf(halves[1]) : [];
  if ([...left, ...right].some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff)) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  return [...left, ...Array(Math.max(0, missing)).fill(0), ...right];
}

function isPrivateIpv4Parts(parts) {
  if (!parts) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && [0, 168].includes(b))
    || (a === 198 && [18, 19].includes(b));
}

function isLoopbackIp(value) {
  const host = hostText(value);
  const parts = ipv4Parts(host);
  if (parts) return parts[0] === 127;
  return host === "::1";
}

function isPrivateOrLocalIp(value) {
  const host = hostText(value);
  const parts = ipv4Parts(host);
  if (parts) {
    return isPrivateIpv4Parts(parts);
  }
  // Never allow IPv4 destinations to bypass an IPv6-only boundary check.
  // Public and private mapped forms are equally outside this gateway contract.
  if (mappedIpv4Parts(host)) return true;
  if (net.isIP(host) !== 6) return false;
  if (host === "::" || host === "::1" || host.startsWith("ff")) return true;
  if (/^f[cd]/.test(host) || /^fe[89a-f]/.test(host)) return true;
  const groups = expandedIpv6Parts(host);
  if (!groups) return true;
  // Reject transition mechanisms that can carry an otherwise hidden IPv4
  // destination. This includes IPv4-compatible, NAT64, Teredo and 6to4.
  if (groups.slice(0, 6).every((part) => part === 0)) return true;
  if (groups[0] === 0x64 && groups[1] === 0xff9b
    && (groups[2] === 0 || groups[2] === 1)) return true;
  if (groups[0] === 0x2001 && groups[1] === 0) return true;
  if (groups[0] === 0x2002) return true;
  return false;
}

function explicitLoopbackHost(hostname) {
  const host = hostText(hostname);
  return host === "localhost" || host.endsWith(".localhost") || isLoopbackIp(host);
}

export function normalizeSub2ApiGatewayBaseUrl(value, { allowLocalGateway = false } = {}) {
  if (typeof allowLocalGateway !== "boolean") throw boundaryError("SUB2API_GATEWAY_BOUNDARY_INVALID");
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || raw.length > 2048) throw boundaryError("SUB2API_GATEWAY_BOUNDARY_INVALID");
  let parsed;
  try { parsed = new URL(raw); } catch { throw boundaryError("SUB2API_GATEWAY_BOUNDARY_INVALID"); }
  const local = explicitLoopbackHost(parsed.hostname);
  const literalIp = net.isIP(hostText(parsed.hostname)) > 0;
  if (parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.hostname
    || (parsed.protocol !== "https:" && !(allowLocalGateway && local && parsed.protocol === "http:"))
    || (!allowLocalGateway && local)
    || (literalIp && isPrivateOrLocalIp(parsed.hostname) && !(allowLocalGateway && local))) {
    throw boundaryError("SUB2API_GATEWAY_BOUNDARY_INVALID");
  }
  const pathname = parsed.pathname.endsWith("/") ? parsed.pathname : `${parsed.pathname}/`;
  parsed.pathname = pathname.replace(/\/+/g, "/");
  return parsed.toString().replace(/\/$/, "");
}

export function createSub2ApiGatewayPolicy({
  allowedSecretEnvNames = [],
  allowedGatewayBaseUrls = [],
  allowedGatewayOrigins = [],
  allowLocalGateway = false,
} = {}) {
  if (typeof allowLocalGateway !== "boolean") throw boundaryError("SUB2API_GATEWAY_POLICY_INVALID");
  const secretNames = new Set(iterableValues(allowedSecretEnvNames).map((value) => {
    const name = typeof value === "string" ? value.trim() : "";
    if (!SECRET_ENV_NAME.test(name) || ["__proto__", "prototype", "constructor"].includes(name.toLowerCase())) {
      throw boundaryError("SUB2API_GATEWAY_POLICY_INVALID");
    }
    return name;
  }));
  const baseUrls = new Set(iterableValues(allowedGatewayBaseUrls)
    .map((value) => normalizeSub2ApiGatewayBaseUrl(value, { allowLocalGateway })));
  const origins = new Set(iterableValues(allowedGatewayOrigins).map((value) => {
    const normalized = normalizeSub2ApiGatewayBaseUrl(value, { allowLocalGateway });
    const parsed = new URL(normalized);
    if (parsed.pathname !== "/") throw boundaryError("SUB2API_GATEWAY_POLICY_INVALID");
    return parsed.origin;
  }));
  return Object.freeze({
    allowedSecretEnvNames: Object.freeze([...secretNames].sort()),
    allowedGatewayBaseUrls: Object.freeze([...baseUrls].sort()),
    allowedGatewayOrigins: Object.freeze([...origins].sort()),
    allowLocalGateway,
  });
}

export function requireSub2ApiGatewayPolicy(profile, policy) {
  if (!policy || !Array.isArray(policy.allowedSecretEnvNames)
    || !Array.isArray(policy.allowedGatewayBaseUrls) || !Array.isArray(policy.allowedGatewayOrigins)) {
    throw boundaryError("SUB2API_GATEWAY_POLICY_DENIED");
  }
  const baseUrl = normalizeSub2ApiGatewayBaseUrl(profile?.baseUrl ?? profile?.base_url, {
    allowLocalGateway: policy.allowLocalGateway === true,
  });
  const apiKeyEnvName = typeof (profile?.apiKeyEnvName ?? profile?.api_key_env_name) === "string"
    ? (profile.apiKeyEnvName ?? profile.api_key_env_name).trim() : "";
  const baseAllowed = policy.allowedGatewayBaseUrls.includes(baseUrl)
    || policy.allowedGatewayOrigins.includes(new URL(baseUrl).origin);
  if (!policy.allowedSecretEnvNames.includes(apiKeyEnvName) || !baseAllowed) {
    throw boundaryError("SUB2API_GATEWAY_POLICY_DENIED");
  }
  return { baseUrl, apiKeyEnvName };
}

export async function verifySub2ApiGatewayDnsBoundary({
  hostname,
  allowLocalGateway = false,
  signal,
  resolveHostname = (host) => dns.lookup(host, { all: true, verbatim: true }),
} = {}) {
  if (typeof allowLocalGateway !== "boolean" || typeof resolveHostname !== "function") {
    throw boundaryError("SUB2API_GATEWAY_BOUNDARY_INVALID");
  }
  const host = hostText(hostname);
  if (!host) throw boundaryError("SUB2API_GATEWAY_BOUNDARY_INVALID");
  let answers;
  let removeAbort = () => {};
  try {
    if (signal?.aborted) throw signal.reason || new DOMException("aborted", "AbortError");
    const aborted = new Promise((_, reject) => {
      if (!signal?.addEventListener) return;
      const onAbort = () => reject(signal.reason || new DOMException("aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbort = () => signal.removeEventListener?.("abort", onAbort);
    });
    answers = await Promise.race([Promise.resolve().then(() => resolveHostname(host)), aborted]);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw boundaryError("SUB2API_GATEWAY_DNS_FAILED", true);
  } finally {
    removeAbort();
  }
  if (!Array.isArray(answers) || answers.length < 1) throw boundaryError("SUB2API_GATEWAY_BOUNDARY_INVALID");
  const localHost = explicitLoopbackHost(host);
  for (const answer of answers) {
    const address = typeof answer === "string" ? answer : answer?.address;
    if (net.isIP(hostText(address)) === 0) throw boundaryError("SUB2API_GATEWAY_BOUNDARY_INVALID");
    if (isPrivateOrLocalIp(address) && !(allowLocalGateway && localHost && isLoopbackIp(address))) {
      throw boundaryError("SUB2API_GATEWAY_BOUNDARY_INVALID");
    }
  }
  return Object.freeze({ hostname: host, addressCount: answers.length });
}
