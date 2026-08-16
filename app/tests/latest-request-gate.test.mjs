import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  createLatestLocalStateRefresh,
  createLatestRequestGate,
} from "../src/latest-request-gate.js";
import {
  collectEnrichmentEffectiveSummary,
  collectEnrichmentNeedsPolling,
  runCollectEnrichmentRetry,
} from "../src/collect-enrichment-view.js";

test("the application does not poll the complete local state while idle", async () => {
  const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(appSource, /background-poll/);
  assert.doesNotMatch(appSource, /setInterval\(\(\) => refreshLocalState/);
});

test("a newer local-state refresh wins when responses resolve in reverse order", async () => {
  let resolveOlder;
  let resolveNewer;
  const olderResponse = new Promise((resolve) => { resolveOlder = resolve; });
  const newerResponse = new Promise((resolve) => { resolveNewer = resolve; });
  const applied = [];
  const gate = createLatestRequestGate();

  const olderRun = gate.run({
    request: () => olderResponse,
    apply: async (state) => { applied.push(state.status); },
  });
  const newerRun = gate.run({
    request: () => newerResponse,
    apply: async (state) => { applied.push(state.status); },
  });

  resolveNewer({ status: "RETRYING" });
  assert.deepEqual(await newerRun, {
    applied: true,
    value: { status: "RETRYING" },
  });
  resolveOlder({ status: "NEEDS_ATTENTION" });
  assert.deepEqual(await olderRun, {
    applied: false,
    value: { status: "NEEDS_ATTENTION" },
  });
  assert.deepEqual(applied, ["RETRYING"]);
});

test("starting a newer failed refresh still invalidates an older response", async () => {
  let resolveOlder;
  const olderResponse = new Promise((resolve) => { resolveOlder = resolve; });
  const applied = [];
  const gate = createLatestRequestGate();
  const olderRun = gate.run({
    request: () => olderResponse,
    apply: async (state) => { applied.push(state.status); },
  });

  await assert.rejects(gate.run({
    request: async () => { throw new Error("refresh unavailable"); },
    apply: async () => {},
  }), /refresh unavailable/);
  resolveOlder({ status: "NEEDS_ATTENTION" });
  assert.equal((await olderRun).applied, false);
  assert.deepEqual(applied, []);
});

test("one application refresh guard covers polling, both retry handlers, and manual refresh", async () => {
  const deferredBySource = new Map();
  const applied = [];
  const refresh = createLatestLocalStateRefresh({
    readState: ({ source }) => new Promise((resolve) => {
      deferredBySource.set(source, resolve);
    }),
    applyState: async (state) => { applied.push(state.marker); },
  });

  const listPoll = refresh({ source: "collect-list-poll" });
  const listRetry = refresh({ source: "collect-list-retry" });
  const editRetry = refresh({ source: "collect-edit-retry" });
  const manual = refresh({ source: "manual-refresh" });

  deferredBySource.get("manual-refresh")({ marker: "manual-newest" });
  assert.deepEqual(await manual, {
    status: "applied",
    source: "manual-refresh",
    state: { marker: "manual-newest" },
  });
  deferredBySource.get("collect-edit-retry")({ marker: "edit-older" });
  deferredBySource.get("collect-list-retry")({ marker: "list-older" });
  deferredBySource.get("collect-list-poll")({ marker: "poll-oldest" });

  for (const [pending, source] of [
    [editRetry, "collect-edit-retry"],
    [listRetry, "collect-list-retry"],
    [listPoll, "collect-list-poll"],
  ]) {
    assert.deepEqual(await pending, {
      status: "stale",
      source,
      state: { marker: source === "collect-edit-retry" ? "edit-older" : source === "collect-list-retry" ? "list-older" : "poll-oldest" },
    });
  }
  assert.deepEqual(applied, ["manual-newest"]);
});

test("stale pre-retry polling cannot clear overrides or stop list and edit polling", async () => {
  for (const surface of ["list", "edit"]) {
    const attentionItem = {
      id: `collect-${surface}`,
      enrichment: { status: "NEEDS_ATTENTION", missingFields: ["weightG"] },
    };
    const retryingItem = {
      id: attentionItem.id,
      enrichment: { status: "RETRYING", missingFields: ["weightG"] },
    };
    const deferredBySource = new Map();
    let announceRetryRefresh;
    const retryRefreshStarted = new Promise((resolve) => { announceRetryRefresh = resolve; });
    let currentItem = attentionItem;
    let override = null;
    const refresh = createLatestLocalStateRefresh({
      readState: ({ source }) => new Promise((resolve) => {
        deferredBySource.set(source, resolve);
        if (source === `collect-${surface}-retry`) announceRetryRefresh();
      }),
      applyState: async (state) => {
        currentItem = state.item;
        if (override?.baseItem !== currentItem) override = null;
      },
    });
    const refreshState = async (options) => {
      const result = await refresh(options);
      return result.status === "applied" ? result.state : null;
    };

    const stalePoll = refresh({ source: `collect-${surface}-poll` });
    const retry = runCollectEnrichmentRetry({
      item: attentionItem,
      request: () => ({ enrichment: retryingItem.enrichment }),
      applyOverride: (nextOverride) => { override = nextOverride; },
      refresh: refreshState,
      refreshSource: `collect-${surface}-retry`,
    });
    await retryRefreshStarted;
    assert.equal(collectEnrichmentNeedsPolling(
      collectEnrichmentEffectiveSummary(currentItem, override),
    ), true, `${surface} must poll immediately after its optimistic override`);

    deferredBySource.get(`collect-${surface}-retry`)({ item: retryingItem });
    assert.equal((await retry).notice.type, "success");
    deferredBySource.get(`collect-${surface}-poll`)({ item: attentionItem });
    assert.equal((await stalePoll).status, "stale");
    assert.equal(currentItem, retryingItem, `${surface} must retain the latest server item`);
    assert.equal(override, null, `${surface} may clear its override only after a newer state applied`);
    assert.equal(collectEnrichmentNeedsPolling(
      collectEnrichmentEffectiveSummary(currentItem, override),
    ), true, `${surface} must continue polling after the stale response resolves`);
  }
});
