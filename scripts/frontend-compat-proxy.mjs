import http from "node:http";

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

server.listen(port, host, () => {
  console.log(`Frontend compatibility proxy listening on http://${host}:${port}`);
});

function shutdown() {
  server.close();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
