const assert = require("assert");
const path = require("path");

global.window = global;
global.location = {
  origin: "https://www.ozon.ru",
  href: "https://www.ozon.ru/search/?from_global=true&text=one",
};
global.window.location = global.location;

require(path.resolve(__dirname, "../content/collector/keyword-pilot.js"));

function createFakeDb() {
  const keywords = [
    { id: 1, text: "one", status: "pending" },
    { id: 2, text: "two", status: "pending" },
  ];
  let session = null;
  let salesCount = 0;

  return {
    keywords,
    get session() {
      return session;
    },
    async getSession() {
      return session;
    },
    async setSession(patch) {
      session = { ...(session || { key: "current" }), ...patch };
      return session;
    },
    async clearSession() {
      session = null;
    },
    async getKeywords() {
      return keywords;
    },
    async getNextPendingKeyword() {
      return keywords.find((kw) => kw.status === "pending") || null;
    },
    async updateKeyword(id, patch) {
      const kw = keywords.find((item) => item.id === id);
      Object.assign(kw, patch);
      return kw;
    },
    async countSales() {
      return salesCount;
    },
  };
}

(async () => {
  const db = createFakeDb();

  const starter = new window.JZKeywordPilot({ db });
  await starter.start({ maxCollectNumber: 1, collectorStartedByKeywordPilot: false });

  assert.strictEqual(
    db.session.collectorStartedByKeywordPilot,
    false,
    "first keyword session should preserve manual collector ownership",
  );
  assert.ok(
    /text=one/.test(global.location.href),
    "first start should navigate to the first keyword",
  );
  global.location.search = new URL(global.location.href).search;

  let restoredOwnership = null;
  const restored = new window.JZKeywordPilot({
    db,
    onStartCollecting: (_kw, session) => {
      restoredOwnership = session.collectorStartedByKeywordPilot;
    },
  });
  await restored.init();
  assert.strictEqual(restoredOwnership, false, "restored keyword should see manual ownership");

  await restored.notifyKeywordEmpty();

  assert.strictEqual(db.keywords[0].status, "done", "first keyword should complete");
  assert.strictEqual(db.keywords[1].status, "running", "second keyword should start");
  assert.strictEqual(
    db.session.collectorStartedByKeywordPilot,
    false,
    "auto-advanced keyword session should keep manual collector ownership",
  );
  assert.ok(
    /text=two/.test(global.location.href),
    "auto-advance should navigate to the second keyword",
  );

  console.log("keyword pilot ownership test passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
