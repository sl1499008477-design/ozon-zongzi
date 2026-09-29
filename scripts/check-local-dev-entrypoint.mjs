import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";

const devScript = await readFile(new URL("./dev.mjs", import.meta.url), "utf8");

assert.match(
  devScript,
  /\["frontend-compat-proxy",\s*"node",\s*\["scripts\/frontend-compat-proxy\.mjs"\]\]/,
  "pnpm dev must start the 3000 compatibility proxy",
);
assert.equal(
  (devScript.match(/server\/auto-listing-ai-worker\.mjs/g) || []).length,
  0,
  "pnpm dev must not restart the retired auto-listing AI worker",
);
assert.equal(
  (devScript.match(/server\/listing-worker\.mjs/g) || []).length,
  1,
  "pnpm dev must keep the independent listing worker",
);

const host = "127.0.0.1";
let upgradeReceived = false;
let clientFramePayload = null;
const upstreamSockets = new Set();
const upstream = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end(`upstream ${request.url}`);
});

upstream.on("connection", (socket) => {
  upstreamSockets.add(socket);
  socket.on("close", () => upstreamSockets.delete(socket));
});

upstream.on("upgrade", (request, socket) => {
  upgradeReceived = request.url === "/hmr";
  const key = request.headers["sec-websocket-key"];
  assert.equal(typeof key, "string", "the proxy must forward the WebSocket key");
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Connection: Upgrade\r\n" +
      "Upgrade: websocket\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      "\r\n",
  );
  let bufferedFrames = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    bufferedFrames = Buffer.concat([bufferedFrames, chunk]);
    const frame = parseWebSocketFrame(bufferedFrames, true);
    if (!frame) return;
    clientFramePayload = frame.payload.toString("utf8");
    socket.write(createServerTextFrame("pong"));
  });
});

await new Promise((resolve) => upstream.listen(0, host, resolve));
const upstreamPort = upstream.address().port;

const proxy = spawn(process.execPath, [fileURLToPath(new URL("./frontend-compat-proxy.mjs", import.meta.url))], {
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    SONLI_FRONTEND_PROXY_PORT: "0",
    SONLI_FRONTEND_TARGET: `http://${host}:${upstreamPort}`,
  },
});

try {
  const proxyPort = await waitForProxy(proxy);

  const httpBody = await requestBody(`http://${host}:${proxyPort}/health`);
  assert.equal(httpBody, "upstream /health", "the proxy must forward ordinary HTTP requests");

  const websocket = await websocketHandshake(host, proxyPort);
  assert.match(websocket.headers, /^HTTP\/1\.1 101 Switching Protocols/m, "the proxy must forward WebSocket upgrades");
  assert.match(websocket.headers, /\r\nUpgrade: websocket\r\n/i, "the proxy must preserve the WebSocket Upgrade response");
  assert.match(websocket.headers, /\r\nConnection: Upgrade\r\n/i, "the proxy must preserve the WebSocket Connection response");
  assert.match(
    websocket.headers,
    /\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=\r\n/i,
    "the browser handshake must receive the RFC6455 acceptance value",
  );
  assert.equal(websocket.payload, "pong", "the upgraded connection must relay a valid upstream WebSocket frame");
  assert.equal(upgradeReceived, true, "the upstream must receive the WebSocket upgrade request");
  assert.equal(clientFramePayload, "ping", "the upstream must receive a valid masked client WebSocket frame");
} finally {
  for (const socket of upstreamSockets) socket.destroy();
  await stopChild(proxy);
  await closeServer(upstream);
}

console.log("local development HTTP and WebSocket entrypoint contract passed");

function waitForProxy(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("compatibility proxy did not start")), 5_000);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`compatibility proxy exited with code ${code}`)));
    child.stdout.on("data", (chunk) => {
      const match = chunk.toString().match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  if (await settlesWithin(exited, 500)) return;
  const forceExited = once(child, "exit");
  child.kill("SIGKILL");
  await settlesWithin(forceExited, 500);
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await settlesWithin(new Promise((resolve) => server.close(resolve)), 500);
}

function settlesWithin(promise, milliseconds) {
  return Promise.race([
    promise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), milliseconds)),
  ]);
}

function requestBody(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve(body));
    }).on("error", reject);
  });
}

function websocketHandshake(hostname, port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: hostname, port });
    let response = Buffer.alloc(0);
    let finished = false;
    let pingSent = false;
    let totalTimeout;
    const finish = (callback, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(totalTimeout);
      callback(value);
    };
    totalTimeout = setTimeout(() => {
      socket.destroy();
      finish(reject, new Error("WebSocket handshake timed out"));
    }, 5_000);
    socket.on("connect", () => {
      socket.write(
        "GET /hmr HTTP/1.1\r\n" +
          `Host: ${hostname}:${port}\r\n` +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          "\r\n",
      );
    });
    socket.on("data", (chunk) => {
      response = Buffer.concat([response, chunk]);
      const headerEnd = response.indexOf("\r\n\r\n");
      if (!pingSent && headerEnd >= 0) {
        pingSent = true;
        socket.write(createMaskedTextFrame("ping"));
      }
      if (headerEnd < 0) return;
      const frame = parseWebSocketFrame(response.subarray(headerEnd + 4), false);
      if (frame?.payload.toString("utf8") === "pong") {
        socket.end();
        finish(resolve, { headers: response.subarray(0, headerEnd + 4).toString("ascii"), payload: frame.payload.toString("utf8") });
      }
    });
    socket.on("close", () => {
      if (!finished) finish(reject, new Error("WebSocket upgrade connection closed before bidirectional relay"));
    });
    socket.on("error", (error) => finish(reject, error));
  });
}

function createMaskedTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const frame = Buffer.alloc(2 + mask.length + payload.length);
  frame[0] = 0x81;
  frame[1] = 0x80 | payload.length;
  mask.copy(frame, 2);
  for (let index = 0; index < payload.length; index += 1) {
    frame[6 + index] = payload[index] ^ mask[index % mask.length];
  }
  return frame;
}

function createServerTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

function parseWebSocketFrame(buffer, expectMasked) {
  if (buffer.length < 2) return null;
  const payloadLength = buffer[1] & 0x7f;
  const masked = (buffer[1] & 0x80) !== 0;
  const maskLength = masked ? 4 : 0;
  const frameLength = 2 + maskLength + payloadLength;
  if (buffer.length < frameLength) return null;
  assert.equal(buffer[0], 0x81, "the smoke traffic must use a final text WebSocket frame");
  assert.equal(masked, expectMasked, expectMasked ? "client frames must be masked" : "server frames must be unmasked");
  const payload = Buffer.from(buffer.subarray(2 + maskLength, frameLength));
  if (masked) {
    const mask = buffer.subarray(2, 6);
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % mask.length];
  }
  return { payload };
}
