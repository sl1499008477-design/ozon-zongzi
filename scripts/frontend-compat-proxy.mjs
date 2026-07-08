import http from "node:http";
import net from "node:net";

const listenHost = process.env.QH_COMPAT_PROXY_HOST || "127.0.0.1";
const listenPort = Number(process.env.QH_COMPAT_PROXY_PORT || 3000);
const targetHost = process.env.QH_COMPAT_TARGET_HOST || "127.0.0.1";
const targetPort = Number(process.env.QH_COMPAT_TARGET_PORT || 5173);

const proxyRequest = (req, res) => {
  const upstream = http.request(
    {
      hostname: targetHost,
      port: targetPort,
      method: req.method,
      path: req.url,
      headers: {
        ...req.headers,
        host: `${targetHost}:${targetPort}`,
      },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );

  upstream.on("error", (error) => {
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(`sonli frontend compatibility proxy failed: ${error.message}`);
  });

  req.pipe(upstream);
};

const server = http.createServer(proxyRequest);

server.on("upgrade", (req, socket, head) => {
  const upstream = net.connect(targetPort, targetHost, () => {
    upstream.write(
      [
        `${req.method} ${req.url} HTTP/${req.httpVersion}`,
        `Host: ${targetHost}:${targetPort}`,
        ...Object.entries(req.headers)
          .filter(([key]) => key.toLowerCase() !== "host")
          .map(([key, value]) => `${key}: ${value}`),
        "",
        "",
      ].join("\r\n"),
    );
    if (head?.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });

  upstream.on("error", () => socket.destroy());
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.warn(`[compat] ${listenHost}:${listenPort} already in use; source-compatible frontend proxy skipped`);
    process.exit(0);
  }
  throw error;
});

server.listen(listenPort, listenHost, () => {
  console.log(`[compat] http://${listenHost}:${listenPort} -> http://${targetHost}:${targetPort}`);
  console.log("[compat] source plugin aliases: http://localhost:3000 and http://store.localhost:3000");
});
