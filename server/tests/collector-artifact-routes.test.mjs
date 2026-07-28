import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { handleCollectorArtifactRoute } from "../collector-artifact-routes.mjs";

function response() {
  return {
    status: 0,
    headers: {},
    chunks: [],
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    write(chunk) { this.chunks.push(Buffer.from(chunk)); },
    end(chunk) { if (chunk) this.chunks.push(Buffer.from(chunk)); },
  };
}

const sent = [];
const errors = [];
const common = {
  authenticate: async () => ({ id: "acct-route" }),
  readBody: async () => ({ itemIds: ["item-a"] }),
  sendJson: (_res, status, body) => sent.push({ status, body }),
  sendError: (_res, status, message, code) => errors.push({ status, message, code }),
};

assert.equal(await handleCollectorArtifactRoute(
  { method: "POST", url: "/collector/runs/run-a/collect-box" },
  response(),
  new URL("http://localhost/collector/runs/run-a/collect-box"),
  {
    ...common,
    addSelected: async (input) => {
      assert.equal(input.accountId, "acct-route");
      assert.equal(input.runId, "run-a");
      return { ok: true, added: 1 };
    },
  },
), true);
assert.equal(sent.at(-1).status, 200);

assert.equal(await handleCollectorArtifactRoute(
  { method: "POST", url: "/collector/runs/run-a/exports/" },
  response(),
  new URL("http://localhost/collector/runs/run-a/exports/"),
  {
    ...common,
    generateExport: async (input) => {
      assert.equal(input.accountId, "acct-route");
      assert.equal(input.runId, "run-a");
      return { export: { id: "export-a", status: "READY" } };
    },
  },
), true);
assert.equal(sent.at(-1).status, 201);

const download = response();
await handleCollectorArtifactRoute(
  { method: "GET", url: "/collector/exports/export-a/download" },
  download,
  new URL("http://localhost/collector/exports/export-a/download"),
  {
    ...common,
    getExport: async (accountId, exportId) => ({
      id: exportId,
      accountId,
      runId: "run-a",
      status: "READY",
      objectKey: "collector/acct-route/run-a/export-a.xlsx",
      fileName: "采集结果.xlsx",
      contentType: "application/x-test",
      size: 4,
    }),
    getStream: async () => Readable.from([Buffer.from("xlsx")]),
  },
);
assert.equal(download.status, 200);
assert.equal(Buffer.concat(download.chunks).toString(), "xlsx");
assert.match(download.headers["Content-Disposition"], /%E9%87%87%E9%9B%86/);

assert.equal(await handleCollectorArtifactRoute(
  { method: "GET", url: "/unrelated" },
  response(),
  new URL("http://localhost/unrelated"),
  common,
), false);
assert.equal(errors.length, 0);

console.log("collector artifact route tests passed");
