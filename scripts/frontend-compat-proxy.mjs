import http from "node:http";
import net from "node:net";

const host = "127.0.0.1";
const configuredPort = Number(process.env.SONLI_FRONTEND_PROXY_PORT ?? 3000);
if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65_535) {
  throw new Error("SONLI_FRONTEND_PROXY_PORT must be an integer between 0 and 65535");
}
const port = configuredPort;
const targetUrl = new URL(process.env.SONLI_FRONTEND_TARGET || "http://127.0.0.1:5173");
if (targetUrl.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(targetUrl.hostname)) {
  throw new Error("SONLI_FRONTEND_TARGET must be a local HTTP URL");
}
const target = targetUrl.toString();

const server = http.createServer((request, response) => {
  const targetUrl = new URL(request.url ?? "/", target);
  const upstream = http.request(
    targetUrl,
    {
      method: request.method,
      headers: { ...request.headers, host: targetUrl.host },
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );

  upstream.on("error", () => {
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    }
    response.end("Frontend development server is unavailable.");
  });

  request.pipe(upstream);
});

server.on("upgrade", (request, socket, head) => {
  const targetUrl = new URL(target);
  const upstream = net.connect(Number(targetUrl.port || 80), targetUrl.hostname, () => {
    upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`);
    let hasHostHeader = false;
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index];
      const value = request.rawHeaders[index + 1];
      if (name.toLowerCase() === "host") {
        upstream.write(`Host: ${targetUrl.host}\r\n`);
        hasHostHeader = true;
      } else {
        upstream.write(`${name}: ${value}\r\n`);
      }
    }
    if (!hasHostHeader) upstream.write(`Host: ${targetUrl.host}\r\n`);
    upstream.write("\r\n");
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });

  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(port, host, () => {
  const address = server.address();
  console.log(`Frontend compatibility proxy listening on http://${host}:${address.port}`);
});

function shutdown() {
  server.close();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
