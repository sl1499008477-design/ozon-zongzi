const assert = require("assert");
const fs = require("fs");
const path = require("path");

const extensionRoot = path.resolve(__dirname, "../..");
const read = (relativePath) =>
  fs.readFileSync(path.join(extensionRoot, relativePath), "utf8");

const html = read("popup/popup.html");
const js = read("popup/popup.js");
const css = read("popup/popup.css");
const serviceWorker = read("background/service-worker.js");

for (const id of [
  "browser-agent-section",
  "browser-agent-title",
  "browser-agent-meta",
  "browser-agent-progress-bar",
  "browser-agent-stop-btn",
]) {
  assert(html.includes(`id="${id}"`), `popup.html should include #${id}`);
}

for (const token of [
  "browserAgentGetState",
  "browserAgentCancelCurrent",
  "startBrowserAgentPolling",
  "renderBrowserAgentState",
]) {
  assert(js.includes(token), `popup.js should wire ${token}`);
}

for (const selector of [
  ".browser-agent-card",
  ".browser-agent-progress-bar",
  ".browser-agent-stop-btn",
]) {
  assert(css.includes(selector), `popup.css should style ${selector}`);
}

assert(
  serviceWorker.includes("case 'browserAgentGetState'"),
  "service worker should expose browserAgentGetState",
);
assert(
  serviceWorker.includes("case 'browserAgentCancelCurrent'"),
  "service worker should expose browserAgentCancelCurrent",
);

console.log("browser agent popup smoke passed");
