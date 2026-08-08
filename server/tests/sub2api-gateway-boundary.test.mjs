import assert from "node:assert/strict";
import test from "node:test";

import {
  createSub2ApiGatewayPolicy,
  normalizeSub2ApiGatewayBaseUrl,
  requireSub2ApiGatewayPolicy,
  verifySub2ApiGatewayDnsBoundary,
} from "../sub2api-gateway-boundary.mjs";

test("deployment gateway policy is exact and defaults closed", () => {
  const profile = { baseUrl: "https://gateway.example/v1", apiKeyEnvName: "SUB2API_PRIMARY_KEY" };
  for (const policy of [
    createSub2ApiGatewayPolicy(),
    createSub2ApiGatewayPolicy({ allowedSecretEnvNames: ["SUB2API_OTHER_KEY"],
      allowedGatewayBaseUrls: ["https://gateway.example/v1"] }),
    createSub2ApiGatewayPolicy({ allowedSecretEnvNames: ["SUB2API_PRIMARY_KEY"],
      allowedGatewayBaseUrls: ["https://gateway.example/v2"] }),
  ]) {
    assert.throws(() => requireSub2ApiGatewayPolicy(profile, policy), {
      code: "SUB2API_GATEWAY_POLICY_DENIED",
    });
  }
  const policy = createSub2ApiGatewayPolicy({
    allowedSecretEnvNames: ["SUB2API_PRIMARY_KEY"],
    allowedGatewayBaseUrls: ["https://gateway.example/v1"],
  });
  assert.deepEqual(requireSub2ApiGatewayPolicy(profile, policy), profile);
});

test("production gateway URLs require credential-free HTTPS and reject every literal local or private network", () => {
  assert.equal(normalizeSub2ApiGatewayBaseUrl("https://gateway.example/v1"), "https://gateway.example/v1");
  for (const value of [
    "http://gateway.example/v1",
    "http://localhost:8080/v1",
    "https://localhost/v1",
    "https://127.0.0.1/v1",
    "https://10.0.0.1/v1",
    "https://172.16.0.1/v1",
    "https://192.168.1.1/v1",
    "https://169.254.1.1/v1",
    "https://[::1]/v1",
    "https://[::ffff:127.0.0.1]/v1",
    "https://[::ffff:10.0.0.1]/v1",
    "https://[::ffff:8.8.8.8]/v1",
    "https://[::ffff:808:808]/v1",
    "https://[::808:808]/v1",
    "https://[64:ff9b::7f00:1]/v1",
    "https://[64:ff9b:1::7f00:1]/v1",
    "https://[2002:7f00:1::]/v1",
    "https://[2001::1]/v1",
    "https://[fc00::1]/v1",
    "https://[fd12::1]/v1",
    "https://[fe80::1]/v1",
    "https://[fec0::1]/v1",
    "https://user:password@gateway.example/v1",
    "https://gateway.example/v1?redirect=https://evil.example",
    "https://gateway.example/v1#secret",
  ]) {
    assert.throws(() => normalizeSub2ApiGatewayBaseUrl(value), {
      code: "SUB2API_GATEWAY_BOUNDARY_INVALID",
    });
  }
});

test("an explicit local-development switch permits only loopback HTTP and never a private LAN gateway", () => {
  for (const value of [
    "http://localhost:8080/v1",
    "http://127.0.0.1:8080/v1",
    "http://[::1]:8080/v1",
  ]) {
    assert.equal(normalizeSub2ApiGatewayBaseUrl(value, { allowLocalGateway: true }), value);
  }
  for (const value of [
    "http://10.0.0.2:8080/v1",
    "http://192.168.1.2:8080/v1",
    "http://[fc00::2]:8080/v1",
  ]) {
    assert.throws(() => normalizeSub2ApiGatewayBaseUrl(value, { allowLocalGateway: true }), {
      code: "SUB2API_GATEWAY_BOUNDARY_INVALID",
    });
  }
});

test("DNS validation rejects empty, mixed, IPv4-private, IPv6-loopback, link-local and unique-local answers", async () => {
  const publicAnswers = [{ address: "203.0.113.10", family: 4 }, { address: "2001:db8::10", family: 6 }];
  await assert.doesNotReject(verifySub2ApiGatewayDnsBoundary({
    hostname: "gateway.example",
    resolveHostname: async () => publicAnswers,
  }));
  for (const answers of [
    [],
    [{ address: "10.0.0.4", family: 4 }],
    [{ address: "203.0.113.10", family: 4 }, { address: "127.0.0.1", family: 4 }],
    [{ address: "::1", family: 6 }],
    [{ address: "::ffff:7f00:1", family: 6 }],
    [{ address: "::ffff:a00:1", family: 6 }],
    [{ address: "::ffff:8.8.8.8", family: 6 }],
    [{ address: "::ffff:808:808", family: 6 }],
    [{ address: "::808:808", family: 6 }],
    [{ address: "fe80::4", family: 6 }],
    [{ address: "fec0::4", family: 6 }],
    [{ address: "fd00::4", family: 6 }],
  ]) {
    await assert.rejects(verifySub2ApiGatewayDnsBoundary({
      hostname: "gateway.example",
      resolveHostname: async () => answers,
    }), { code: "SUB2API_GATEWAY_BOUNDARY_INVALID" });
  }
});

test("DNS lookup failures use one safe retryable code without leaking the resolver error", async () => {
  const raw = new Error("resolver secret internal.example 10.0.0.1");
  await assert.rejects(verifySub2ApiGatewayDnsBoundary({
    hostname: "gateway.example",
    resolveHostname: async () => { throw raw; },
  }), (error) => error?.code === "SUB2API_GATEWAY_DNS_FAILED"
    && error?.retryable === true
    && !/secret|internal|10\.0\.0\.1/iu.test(error.message));
});

test("DNS verification obeys the caller abort fence even when resolution never settles", async () => {
  const controller = new AbortController();
  const pending = verifySub2ApiGatewayDnsBoundary({
    hostname: "gateway.example",
    signal: controller.signal,
    resolveHostname: () => new Promise(() => {}),
  });
  controller.abort(new DOMException("timeout", "TimeoutError"));
  await assert.rejects(pending, (error) => error?.name === "TimeoutError");
});
