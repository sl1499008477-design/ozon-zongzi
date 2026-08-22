const assert = require("assert");
const fs = require("fs");
const path = require("path");

const extensionRoot = path.resolve(__dirname, "..");
const { toggleSidebarSection } = require("../lib/sidebar-section-toggle.js");

function classList(initial = []) {
  const set = new Set(initial);
  return {
    contains: (name) => set.has(name),
    add: (name) => set.add(name),
    remove: (name) => set.delete(name),
    toggle: (name, force) => {
      const next = force === undefined ? !set.has(name) : !!force;
      if (next) set.add(name);
      else set.delete(name);
      return next;
    },
  };
}

function createSection() {
  const body = { classList: classList() };
  const hint = {
    removed: false,
    remove() {
      this.removed = true;
    },
  };
  const section = {
    dataset: { section: "info" },
    classList: classList(["ozon-helper-sidebar-section"]),
    querySelector(selector) {
      if (selector === ".ozon-helper-sidebar-section-body") return body;
      if (selector === ".ozon-helper-sidebar-empty-hint") return hint;
      return null;
    },
  };
  const header = { closest: () => section };
  return { section, body, header, hint };
}

const storage = new Map();
const storageApi = {
  setItem: (key, value) => storage.set(key, value),
};

const first = createSection();
assert.strictEqual(toggleSidebarSection(first.header, storageApi), true);
assert.strictEqual(first.section.classList.contains("is-collapsed"), true);
assert.strictEqual(first.body.classList.contains("is-collapsed"), true);
assert.strictEqual(storage.get("oh-sidebar-collapsed-info"), "1");

assert.strictEqual(toggleSidebarSection(first.header, storageApi), false);
assert.strictEqual(first.section.classList.contains("is-collapsed"), false);
assert.strictEqual(first.body.classList.contains("is-collapsed"), false);
assert.strictEqual(storage.get("oh-sidebar-collapsed-info"), "0");
assert.strictEqual(first.hint.removed, true);

const searchJs = fs.readFileSync(path.join(extensionRoot, "content/ozon-search.js"), "utf8");
const dataPanelJs = fs.readFileSync(path.join(extensionRoot, "content/ozon-data-panel.js"), "utf8");
assert(searchJs.includes("JZSidebarSectionToggle?.toggleSidebarSection"));
assert(dataPanelJs.includes("JZSidebarSectionToggle?.toggleSidebarSection"));

const searchCss = fs.readFileSync(path.join(extensionRoot, "content/ozon-search.css"), "utf8");
const compactBodyRule = ".ozon-helper-data-panel .ozon-helper-sidebar-section-body {";
const compactCollapsedRule = ".ozon-helper-data-panel .ozon-helper-sidebar-section-body.is-collapsed {";
const compactBodyIndex = searchCss.indexOf(compactBodyRule);
const compactCollapsedIndex = searchCss.indexOf(compactCollapsedRule);
assert(compactBodyIndex >= 0, "search data cards should define compact section body spacing");
assert(compactCollapsedIndex > compactBodyIndex, "collapsed spacing override should come after compact body spacing");
const compactCollapsedBody = searchCss.slice(
  compactCollapsedIndex,
  searchCss.indexOf("}", compactCollapsedIndex),
);
assert(compactCollapsedBody.includes("max-height: 0"));
assert(compactCollapsedBody.includes("padding: 0 10px"));

const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, "manifest.json"), "utf8"));
const scriptGroups = manifest.content_scripts.map((entry) => entry.js || []);
const searchGroup = scriptGroups.find((scripts) => scripts.includes("content/ozon-search.js"));
const dataPanelGroup = scriptGroups.find((scripts) => scripts.includes("content/ozon-data-panel.js"));

for (const group of [searchGroup, dataPanelGroup]) {
  assert(group, "expected manifest content script group");
  assert(group.includes("lib/sidebar-section-toggle.js"));
  const helperIndex = group.indexOf("lib/sidebar-section-toggle.js");
  const callerIndex = Math.max(
    group.indexOf("content/ozon-search.js"),
    group.indexOf("content/ozon-data-panel.js"),
  );
  assert(helperIndex < callerIndex, "helper should load before the data-card caller");
}

console.log("sidebar section toggle test passed");
