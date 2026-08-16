import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import vm from "node:vm";

const unpackedDir = path.resolve(process.argv[2] || "");
assert.ok(process.argv[2], "unpacked extension directory is required");
const workerPath = path.join(unpackedDir, "background", "service-worker.js");
const workerSource = readFileSync(workerPath, "utf8");
const startupBoundary = workerSource.indexOf("  /**\n   * Execute fetch in a seller.ozon.ru tab");
assert.ok(startupBoundary > 0, "collector startup boundary missing from packaged service worker");
const controlledWorkerSource = `${workerSource.slice(0, startupBoundary)}
  globalThis.__packagedCollectorStarted = Boolean(collectorSessionManager);
})();`;

const storage = () => ({
  get: async (key) => (key == null ? {} : { [key]: undefined }),
  set: async () => {},
  remove: async () => {},
});
const event = { addListener() {}, removeListener() {} };
const chrome = {
  alarms: {
    async clear() { return true; },
    create() {},
    onAlarm: event,
  },
  contextMenus: { removeAll(callback) { callback?.(); }, create() {}, onClicked: event },
  cookies: { getAll: async () => [] },
  notifications: { create() {}, clear() {}, onClicked: event },
  runtime: { getURL: (value) => `chrome-extension://packaged/${value}` },
  storage: { local: storage(), session: storage(), sync: storage() },
  tabs: { query: async () => [], reload() {} },
};
const context = vm.createContext({
  AbortController,
  AbortSignal,
  URL,
  chrome,
  clearTimeout,
  console,
  crypto: webcrypto,
  fetch: async () => ({ ok: true, status: 200, text: async () => "{}" }),
  globalThis: null,
  navigator: {
    hardwareConcurrency: 8,
    language: "en-US",
    platform: "test",
    userAgent: "packaged-smoke",
  },
  setTimeout,
});
context.globalThis = context;
context.self = context;
context.importScripts = (...entries) => {
  for (const entry of entries) {
    const file = path.resolve(path.dirname(workerPath), entry);
    vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
  }
};

vm.runInContext(controlledWorkerSource, context, { filename: workerPath });
assert.equal(context.__packagedCollectorStarted, true);
assert.equal(typeof context.JzCollectorSession?.createCollectorSessionManager, "function");
console.log(`packaged collector service-worker startup passed: ${unpackedDir}`);
