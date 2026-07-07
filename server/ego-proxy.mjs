// ego-browser proxy: runs as a separate process outside the sandbox,
// listens on port 3002 for scrape requests, and uses ego-browser to fetch ozon.ru data
import http from "node:http";
import { spawn } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EGO_BROWSER_BIN = "/Users/songliang/.local/bin/ego-browser";
const PORT = Number(process.env.EGO_PROXY_PORT || 3002);

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

async function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { resolve({}); }
    });
  });
}

function spawnAsync(cmd, args, input, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    let stdout = "";
    let stderr = "";
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        reject(new Error(`spawn timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    }
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    if (input) {
      child.stdin.write(input);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function runEgoScript(script, timeoutMs = 120000) {
  const tmpFile = path.join("/tmp", `qh-ego-scrape-${Date.now()}-${Math.random().toString(16).slice(2)}.js`);
  await writeFile(tmpFile, script, "utf8");
  try {
    return await spawnAsync(
      "/bin/zsh",
      ["-lc", `${shellQuote(EGO_BROWSER_BIN)} nodejs < ${shellQuote(tmpFile)}`],
      "",
      timeoutMs,
    );
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
}

async function scrapeProduct(sku) {
  const scriptPath = path.join(__dirname, "scrape-script.js");
  let scriptTemplate;
  try {
    scriptTemplate = await readFile(scriptPath, "utf8");
  } catch (e) {
    return null;
  }
  const script = scriptTemplate.replace(/SKU_PLACEHOLDER/g, JSON.stringify(sku));

  try {
    const result = await runEgoScript(script, 120000);
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    const lines = output.trim().split("\n").filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (line === "SCRAPE_FAILED") break;
      try {
        const parsed = JSON.parse(line);
        if (parsed && (parsed.title || parsed.priceText)) {
          return parsed;
        }
      } catch {}
    }
    console.error("[ego-proxy] no parsed scrape result", {
      code: result.code,
      stdoutTail: result.stdout.slice(-800),
      stderrTail: result.stderr.slice(-800),
    });
  } catch (e) {
    console.error("[ego-proxy] scrape failed:", e.message);
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true, service: "ego-proxy" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/scrape") {
    const body = await readBody(req);
    const sku = String(body.sku || "").trim();
    if (!sku) {
      sendJson(res, 400, { error: "SKU required" });
      return;
    }
    console.log(`[ego-proxy] scraping SKU: ${sku}`);
    const result = await scrapeProduct(sku);
    if (result) {
      sendJson(res, 200, { ok: true, data: result });
    } else {
      sendJson(res, 200, { ok: false, error: "scrape_failed" });
    }
    return;
  }

  sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`ego-browser proxy listening on http://127.0.0.1:${PORT}`);
});
