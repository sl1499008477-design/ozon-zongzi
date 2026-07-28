import http from "node:http";
import net from "node:net";

const host = "127.0.0.1";
const port = 3000;
const target = "http://127.0.0.1:5173";

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
  console.log(`Frontend compatibility proxy listening on http://${host}:${port}`);
});

function shutdown() {
  server.close();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
