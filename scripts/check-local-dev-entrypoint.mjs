import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

const host = "127.0.0.1";
const upstreamPort = 5173;
const proxyPort = 3000;
let upgradeReceived = false;
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
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Connection: Upgrade\r\n" +
      "Upgrade: websocket\r\n" +
      "\r\n",
  );
  socket.on("data", (chunk) => {
    if (chunk.toString() === "ping") socket.write("pong");
  });
});

await new Promise((resolve) => upstream.listen(upstreamPort, host, resolve));

const proxy = spawn(process.execPath, [fileURLToPath(new URL("./frontend-compat-proxy.mjs", import.meta.url))], {
  stdio: ["ignore", "pipe", "pipe"],
});

try {
  await waitForProxy(proxy);

  const httpBody = await requestBody(`http://${host}:${proxyPort}/health`);
  assert.equal(httpBody, "upstream /health", "the proxy must forward ordinary HTTP requests");

  const websocketBody = await websocketHandshake(host, proxyPort);
  assert.match(websocketBody, /^HTTP\/1\.1 101 Switching Protocols/m, "the proxy must forward WebSocket upgrades");
  assert.match(websocketBody, /pong$/, "the upgraded connection must relay upstream data back to the client");
  assert.equal(upgradeReceived, true, "the upstream must receive the WebSocket upgrade request");
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
      if (chunk.toString().includes("listening on")) {
        clearTimeout(timeout);
        resolve();
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
    let response = "";
    let finished = false;
    let pingSent = false;
    let totalTimeout;
    const finish = (callback, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(totalTimeout);
      callback(value);
    };
    socket.setEncoding("utf8");
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
          "Sec-WebSocket-Key: smoke-test\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          "\r\n",
      );
    });
    socket.on("data", (chunk) => {
      response += chunk;
      if (!pingSent && response.includes("\r\n\r\n")) {
        pingSent = true;
        socket.write("ping");
      }
      if (response.endsWith("pong")) {
        socket.end();
        finish(resolve, response);
      }
    });
    socket.on("close", () => {
      if (!finished) finish(reject, new Error("WebSocket upgrade connection closed before bidirectional relay"));
    });
    socket.on("error", (error) => finish(reject, error));
  });
}
