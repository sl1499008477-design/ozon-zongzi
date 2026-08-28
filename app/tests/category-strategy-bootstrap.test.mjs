import assert from "node:assert/strict";
import test from "node:test";

import {
  findResumableCategoryStrategyDraftId,
  loadCategoryStrategyBootstrap,
  startCategoryStrategySampling,
} from "../src/category-strategy-bootstrap.js";

const RESUME = Object.freeze({
  required: Object.freeze({ canManage: true, sourceCollectItemId: "collect-a", scope: Object.freeze({
    accountId: "account-a",
    taxonomyScope: "OZON:DEFAULT",
    descriptionCategoryId: 88_265_327,
    typeId: 95_402,
  }) }),
  sourceVersions: Object.freeze([Object.freeze({
    collectItemId: "collect-a",
    expectedSourceVersion: "draft:3",
  })]),
});

const DRAFT = Object.freeze({ draftId: "draft-new", draftVersion: 1, status: "COLLECTING" });
const SESSION = Object.freeze({
  sessionId: "session-new",
  expiresAt: "2026-08-15T18:00:00.000Z",
  browserUrl: "https://www.ozon.ru/category/88265327/?zongziCategoryStrategySession=session-new",
});

function intentStore(calls = []) {
  return {
    async identity(kind) {
      return { idempotencyKey: `${kind}-key`, correlationId: `${kind}-correlation` };
    },
    async settle(kind) { if (kind === "category-sampling") calls.push("intent-settle"); },
  };
}

function extensionBridge(calls = []) {
  return {
    async ready() { calls.push("extension-ready"); return { ready: true, version: "0.13.46.3" }; },
    async open(browserUrl) {
      calls.push("extension-open");
      assert.equal(browserUrl, SESSION.browserUrl);
      return { opened: true };
    },
  };
}

test("automatic-listing handoff creates a draft and starts its Ozon sampling session", async () => {
  const calls = [];
  const client = {
    async createDraft(input) {
      if (input.scope.descriptionCategoryId !== 88_265_327
        || input.sourceCollectItemId !== "collect-a"
        || input.expectedSourceVersion !== "draft:3"
        || input.idempotencyKey !== "category-draft-key") throw new Error("wrong create input");
      return DRAFT;
    },
    async getDraft(draftId) {
      if (draftId !== "draft-new") throw new Error("wrong draft id");
      return { draft: DRAFT, session: null };
    },
    async startSession(draftId, input) {
      calls.push("start-session");
      if (draftId !== "draft-new" || input.expectedDraftVersion !== 1
        || input.idempotencyKey !== "category-sampling-key") throw new Error("wrong session input");
      return SESSION;
    },
  };

  const result = await loadCategoryStrategyBootstrap({
    client,
    intents: intentStore(calls),
    extensionBridge: extensionBridge(calls),
    resume: RESUME,
    routeDraftId: "",
    autoStartSampling: true,
  });

  assert.equal(result.draftId, "draft-new");
  assert.equal(result.session, SESSION);
  assert.equal(result.browserUrl, SESSION.browserUrl);
  assert.deepEqual(calls, ["extension-ready", "start-session", "extension-open", "intent-settle"]);
});

test("automatic-listing handoff creates the draft from the source item named by the required scope", async () => {
  let createInput = null;
  const resume = {
    required: {
      ...RESUME.required,
      sourceCollectItemId: "collect-b",
    },
    sourceVersions: [
      { collectItemId: "collect-a", expectedSourceVersion: "draft:3" },
      { collectItemId: "collect-b", expectedSourceVersion: "draft:8" },
    ],
  };
  const client = {
    async createDraft(input) { createInput = input; return DRAFT; },
    async getDraft() { return { draft: DRAFT, session: null }; },
    async startSession() { throw new Error("sampling must stay inactive"); },
  };

  await loadCategoryStrategyBootstrap({
    client,
    intents: intentStore(),
    extensionBridge: extensionBridge(),
    resume,
    routeDraftId: "",
    autoStartSampling: false,
  });

  assert.equal(createInput.sourceCollectItemId, "collect-b");
  assert.equal(createInput.expectedSourceVersion, "draft:8");
});

test("normal strategy navigation creates or loads the draft without starting sampling", async () => {
  const client = {
    async createDraft() { return DRAFT; },
    async getDraft() { return { draft: DRAFT, session: null }; },
    async startSession() { throw new Error("normal navigation must not start sampling"); },
  };

  const result = await loadCategoryStrategyBootstrap({
    client,
    intents: intentStore(),
    extensionBridge: extensionBridge(),
    resume: RESUME,
    routeDraftId: "",
    autoStartSampling: false,
  });

  assert.equal(result.draftId, "draft-new");
  assert.equal(result.session, null);
  assert.equal(result.browserUrl, "");
});

test("automatic handoff reuses an active sampling session instead of creating a duplicate", async () => {
  const calls = [];
  const client = {
    async createDraft() { throw new Error("route draft must be reused"); },
    async getDraft(draftId) {
      if (draftId !== "draft-existing") throw new Error("wrong draft id");
      return { draft: { ...DRAFT, draftId }, session: SESSION };
    },
    async startSession() { throw new Error("active session must be reused"); },
  };

  const result = await loadCategoryStrategyBootstrap({
    client,
    intents: intentStore(),
    extensionBridge: extensionBridge(calls),
    resume: RESUME,
    routeDraftId: "draft-existing",
    autoStartSampling: true,
  });

  assert.equal(result.draftId, "draft-existing");
  assert.equal(result.session, SESSION);
  assert.equal(result.browserUrl, SESSION.browserUrl);
  assert.deepEqual(calls, ["extension-open"]);
});

test("strategy list navigation without a draft or resumable automatic-listing state stays read-only", async () => {
  const client = {
    async createDraft() { throw new Error("must not create"); },
    async getDraft() { throw new Error("must not read a draft"); },
    async startSession() { throw new Error("must not start sampling"); },
  };

  assert.equal(await loadCategoryStrategyBootstrap({
    client,
    intents: intentStore(),
    extensionBridge: extensionBridge(),
    resume: null,
    routeDraftId: "",
    autoStartSampling: false,
  }), null);
});

test("a created draft is exposed for recovery before automatic sampling startup can fail", async () => {
  const ready = [];
  let startCalls = 0;
  const client = {
    async createDraft() { return DRAFT; },
    async getDraft() { return { draft: DRAFT, session: null }; },
    async startSession() {
      startCalls += 1;
      throw new Error("must not create a session without extension readiness");
    },
  };

  await assert.rejects(loadCategoryStrategyBootstrap({
    client,
    intents: intentStore(),
    extensionBridge: {
      async ready() {
        throw Object.assign(new Error("extension unavailable"), {
          code: "AUTO_LISTING_CATEGORY_STRATEGY_SESSION_HANDOFF_NOT_READY",
        });
      },
      async open() { throw new Error("must not open"); },
    },
    resume: RESUME,
    routeDraftId: "",
    autoStartSampling: true,
    onDraftReady(value) { ready.push(value); },
  }), { code: "AUTO_LISTING_CATEGORY_STRATEGY_SESSION_HANDOFF_NOT_READY" });

  assert.equal(ready.length, 1);
  assert.equal(ready[0].draftId, "draft-new");
  assert.equal(ready[0].bundle.draft, DRAFT);
  assert.equal(startCalls, 0);
});

test("an extension open failure leaves the durable sampling intent unsettled", async () => {
  const calls = [];
  const error = Object.assign(new Error("open failed"), {
    code: "AUTO_LISTING_CATEGORY_STRATEGY_BROWSER_OPEN_FAILED",
  });
  await assert.rejects(startCategoryStrategySampling({
    client: {
      async startSession() { calls.push("start-session"); return SESSION; },
    },
    intents: intentStore(calls),
    extensionBridge: {
      async ready() { calls.push("extension-ready"); return { ready: true, version: "0.13.46.3" }; },
      async open() { calls.push("extension-open"); throw error; },
    },
    draft: DRAFT,
  }), { code: "AUTO_LISTING_CATEGORY_STRATEGY_BROWSER_OPEN_FAILED" });
  assert.deepEqual(calls, ["extension-ready", "start-session", "extension-open"]);
});

test("resume recovery selects only the existing draft with the exact required current scope", () => {
  const strategies = [
    { draftId: "draft-old-source", scope: { ...RESUME.required.scope, descriptionCategoryId: 43_434_952 } },
    { draftId: "draft-current", scope: RESUME.required.scope },
  ];

  assert.equal(findResumableCategoryStrategyDraftId({ strategies, resume: RESUME }), "draft-current");
  assert.equal(findResumableCategoryStrategyDraftId({ strategies: strategies.slice(0, 1), resume: RESUME }), "");
});
