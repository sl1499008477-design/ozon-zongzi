export function createLatestRequestGate() {
  let latestGeneration = 0;
  return Object.freeze({
    async run({ request, apply } = {}) {
      if (typeof request !== "function" || typeof apply !== "function") {
        throw new TypeError("LATEST_REQUEST_GATE_DEPENDENCIES_REQUIRED");
      }
      const generation = latestGeneration + 1;
      latestGeneration = generation;
      const value = await request();
      if (generation !== latestGeneration) return { applied: false, value };
      await apply(value);
      return { applied: true, value };
    },
  });
}

export function createLatestLocalStateRefresh({ readState, applyState } = {}) {
  if (typeof readState !== "function" || typeof applyState !== "function") {
    throw new TypeError("LOCAL_STATE_REFRESH_DEPENDENCIES_REQUIRED");
  }
  const gate = createLatestRequestGate();
  return async function refreshLocalState(options = {}) {
    const source = String(options?.source || "manual-refresh");
    const result = await gate.run({
      request: () => readState({ ...options, source }),
      apply: applyState,
    });
    return {
      status: result.applied ? "applied" : "stale",
      source,
      state: result.value,
    };
  };
}
