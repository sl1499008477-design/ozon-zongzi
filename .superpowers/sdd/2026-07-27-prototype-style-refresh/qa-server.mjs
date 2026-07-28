process.env.QH_LOCAL_NO_LISTEN = "1";

const http = await import("node:http");
const fs = await import("node:fs/promises");
const { handle } = await import(
  "/Users/songliang/Documents/sonli ozon3.0/server/index.mjs"
);

const statePath =
  "/Users/songliang/Documents/sonli ozon3.0/server-data/local-state.json";

const server = http.createServer((request, response) => {
  if (
    request.method === "GET" &&
    request.url === "/local/state" &&
    !request.headers.authorization
  ) {
    fs.readFile(statePath, "utf8")
      .then((raw) => {
        const state = JSON.parse(raw);
        const token = state.token || Object.keys(state.sessions || {})[0] || "";
        if (token) request.headers.authorization = `Bearer ${token}`;
        return handle(request, response);
      })
      .catch((error) => {
        response.statusCode = 500;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.end(
          JSON.stringify({ error: error?.message || "local QA state error" }),
        );
      });
    return;
  }

  handle(request, response).catch((error) => {
    response.statusCode = Number(error?.status || 500);
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(
      JSON.stringify({ error: error?.message || "local QA server error" }),
    );
  });
});

server.listen(3001, "127.0.0.1", () => {
  console.log("Sonli QA API listening on http://127.0.0.1:3001");
});
