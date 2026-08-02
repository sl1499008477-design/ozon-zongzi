import assert from "node:assert/strict";
import test from "node:test";
import { createCollectorOzonEnrichmentService } from "../collector-ozon-enrichment-service.mjs";
import { createJsonCollectorOzonEnrichmentRepository } from "../collector-ozon-enrichment-repository.mjs";

const START = Date.parse("2026-07-31T00:00:00.000Z");
const CONTRACT_VERSION = "collector.ozon.enrichment.v1";

function session(collectorSessionId, accountId = "account-a") {
  return { collectorSessionId, accountId };
}

function variantData(descriptionCategoryId = 123) {
  return {
    description_category_id: descriptionCategoryId,
    type_id: 456,
    attributes: [
      { key: "4497", value: "500" },
      { key: "9454", value: "300" },
      { key: "9455", value: "200" },
      { key: "9456", value: "100" },
    ],
  };
}

function sellerVariantData(descriptionCategoryId = 123) {
  return {
    description_category_id: descriptionCategoryId,
    type_id: 456,
    weight: 500,
    depth: 300,
    width: 200,
    height: 100,
    attributes: [],
  };
}

function captureContext(overrides = {}) {
  return {
    sellerCompanyId: "2681910",
    revision: 4,
    observedAt: new Date(START).toISOString(),
    ...overrides,
  };
}

function completeResult(sku, descriptionCategoryId = 123) {
  return {
    status: "COMPLETE",
    contractVersion: CONTRACT_VERSION,
    sku,
    descriptionCategoryId,
    typeId: 456,
    logistics: { weightG: 500, lengthMm: 300, widthMm: 200, heightMm: 100 },
    variantData: variantData(descriptionCategoryId),
    source: "BACKEND_FLEET",
    capturedAt: new Date(START).toISOString(),
    cache: {
      hit: false,
      expiresAt: new Date(START + 6 * 60 * 60 * 1000).toISOString(),
    },
  };
}

const clone = (value) => value === undefined ? undefined : structuredClone(value);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

class FakeRepository {
  constructor({ clock, sessions = [] } = {}) {
    this.clock = clock;
    this.sessions = new Map(sessions.map((value) => [
      `${value.accountId}:${value.collectorSessionId}`,
      value,
    ]));
    this.cache = new Map();
    this.jobs = [];
    this.createdJobCount = 0;
    this.maximumProcessing = 0;
    this.atomicCompleteCount = 0;
    this.atomicFailCount = 0;
    this.deferCount = 0;
    this.lastSellerContextAdvance = null;
    this.lastCompleteInput = null;
    this.leaseAttempts = [];
    this.availableJobInput = null;
    this.availableJobResult = true;
    this.availableJobError = null;
  }

  cacheKey(key) {
    return `${key.accountId}:${key.source}:${key.sku}:${key.contractVersion}`;
  }

  requireSession(accountId, collectorSessionId) {
    if (!this.sessions.has(`${accountId}:${collectorSessionId}`)) {
      throw Object.assign(new Error("session scope rejected"), {
        status: 403,
        code: "OZON_ENRICHMENT_SESSION_SCOPE",
      });
    }
  }

  setCache(key, value) {
    this.cache.set(this.cacheKey(key), clone(value));
  }

  async readCache({ key, now, includeExpired = false }) {
    const value = this.cache.get(this.cacheKey(key));
    if (!value?.status) return null;
    if (!includeExpired && new Date(value.expiresAt).getTime() <= now.getTime()) return null;
    return clone(value);
  }

  async tryAcquireCacheLease({ key, leaseOwner, leaseExpiresAt, now, maxActiveLeases = Infinity }) {
    this.leaseAttempts.push({ key: clone(key), leaseOwner, now: now.toISOString() });
    const cacheKey = this.cacheKey(key);
    const existing = this.cache.get(cacheKey) || { ...key };
    if (
      existing.leaseOwner
      && existing.leaseOwner !== leaseOwner
      && new Date(existing.leaseExpiresAt).getTime() > now.getTime()
    ) return null;
    const activeOwners = new Set(
      [...this.cache.values()]
        .filter((entry) => entry.accountId === key.accountId
          && entry.leaseOwner
          && new Date(entry.leaseExpiresAt).getTime() > now.getTime())
        .map((entry) => entry.leaseOwner),
    );
    if (!activeOwners.has(leaseOwner) && activeOwners.size >= maxActiveLeases) {
      throw Object.assign(new Error("repository lease capacity detail"), {
        status: 429,
        code: "OZON_ENRICH_BUSY",
      });
    }
    Object.assign(existing, {
      leaseOwner,
      leaseExpiresAt: leaseExpiresAt.toISOString(),
      updatedAt: now.toISOString(),
    });
    this.cache.set(cacheKey, existing);
    return clone(existing);
  }

  async releaseCacheLease({ key, leaseOwner }) {
    const existing = this.cache.get(this.cacheKey(key));
    if (!existing || existing.leaseOwner !== leaseOwner) return false;
    existing.leaseOwner = null;
    existing.leaseExpiresAt = null;
    return true;
  }

  async writeCompleteCache(input) {
    this.requireSession(input.key.accountId, input.executorSessionId);
    this.setCache(input.key, {
      ...input.key,
      status: "COMPLETE",
      result: clone(input.result),
      error: null,
      responseHash: input.responseHash,
      executorSessionId: input.executorSessionId,
      capturedAt: input.capturedAt.toISOString(),
      expiresAt: input.expiresAt.toISOString(),
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    return this.readCache({ key: input.key, now: input.capturedAt, includeExpired: true });
  }

  async writeNegativeCache(input) {
    this.setCache(input.key, {
      ...input.key,
      status: "ERROR",
      result: null,
      error: clone(input.error),
      responseHash: input.responseHash,
      executorSessionId: null,
      capturedAt: input.capturedAt.toISOString(),
      expiresAt: input.expiresAt.toISOString(),
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    return this.readCache({ key: input.key, now: input.capturedAt, includeExpired: true });
  }

  async createOrGetJob(input) {
    const existing = this.jobs.find((job) =>
      job.accountId === input.accountId
      && job.requestId === input.requestId
      && job.sku === input.sku);
    if (existing) return clone(existing);
    const job = {
      ...clone(input),
      status: "PENDING",
      claimedSessionId: null,
      claimExpiresAt: null,
      result: null,
      error: null,
      attemptCount: 0,
      nextAttemptAt: input.createdAt.toISOString(),
      lastError: null,
      createdAt: input.createdAt.toISOString(),
      deadlineAt: input.deadlineAt.toISOString(),
    };
    this.jobs.push(job);
    this.createdJobCount += 1;
    return clone(job);
  }

  async claimNextJob({
    accountId,
    collectorSessionId,
    now,
    claimExpiresAt,
    claimFence,
    captureContext: claimedContext = null,
  }) {
    this.requireSession(accountId, collectorSessionId);
    const active = this.jobs.filter((job) =>
      job.accountId === accountId
      && job.status === "PROCESSING"
      && new Date(job.claimExpiresAt).getTime() > now.getTime()).length;
    if (active >= 4) return null;
    const candidate = this.jobs
      .filter((job) =>
        job.accountId === accountId
        && new Date(job.deadlineAt).getTime() > now.getTime()
        && (
          job.status === "PENDING"
          || (job.status === "PROCESSING" && new Date(job.claimExpiresAt).getTime() <= now.getTime())
        )
        && (
          !job.preferredSessionId
          || job.preferredSessionId === collectorSessionId
          || new Date(job.createdAt).getTime() + 1000 <= now.getTime()
        ))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
    if (!candidate) return null;
    Object.assign(candidate, {
      status: "PROCESSING",
      claimedSessionId: collectorSessionId,
      claimExpiresAt: claimExpiresAt.toISOString(),
      claimFence,
      captureContext: clone(claimedContext),
    });
    const processing = this.jobs.filter((job) =>
      job.accountId === accountId
      && job.status === "PROCESSING"
      && new Date(job.claimExpiresAt).getTime() > now.getTime()).length;
    this.maximumProcessing = Math.max(this.maximumProcessing, processing);
    return clone(candidate);
  }

  async advanceSellerContext(input) {
    this.requireSession(input.accountId, input.collectorSessionId);
    this.lastSellerContextAdvance = clone(input);
    return clone(input.captureContext);
  }

  async hasClaimableJob(input) {
    this.availableJobInput = clone(input);
    if (this.availableJobError) throw this.availableJobError;
    return this.availableJobResult;
  }

  async finish({ accountId, collectorSessionId, jobId, now, result, error, status }) {
    this.requireSession(accountId, collectorSessionId);
    const job = this.jobs.find((value) => value.accountId === accountId && value.id === jobId);
    if (
      !job
      || job.status !== "PROCESSING"
      || job.claimedSessionId !== collectorSessionId
      || new Date(job.claimExpiresAt).getTime() <= now.getTime()
    ) {
      throw Object.assign(new Error("claim ownership rejected"), {
        status: 409,
        code: "OZON_ENRICHMENT_JOB_OWNERSHIP",
      });
    }
    const completionInput = arguments[0];
    if (
      completionInput.claimFence !== undefined
      && (
        job.claimFence !== completionInput.claimFence
        || JSON.stringify(job.captureContext ?? null)
          !== JSON.stringify(completionInput.captureContext ?? null)
      )
    ) {
      throw Object.assign(new Error("Seller context changed"), {
        status: 409,
        code: "SELLER_CONTEXT_CHANGED",
      });
    }
    Object.assign(job, { status, result: clone(result ?? null), error: clone(error ?? null) });
    return clone(job);
  }

  async completeJobAndCache(input) {
    const job = await this.finish({ ...input, status: "SUCCESS", error: null });
    this.setCache(input.key, {
      ...input.key,
      status: "COMPLETE",
      result: clone(input.result),
      error: null,
      responseHash: input.responseHash,
      executorSessionId: input.collectorSessionId,
      capturedAt: input.capturedAt.toISOString(),
      expiresAt: input.expiresAt.toISOString(),
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    this.atomicCompleteCount += 1;
    this.lastCompleteInput = clone(input);
    return job;
  }

  async failJobAndCache(input) {
    const job = await this.finish({ ...input, status: "FAILED", result: null });
    job.attemptCount = Number(job.attemptCount || 0) + 1;
    const persisted = this.jobs.find((value) => value.id === job.id && value.accountId === job.accountId);
    persisted.attemptCount = job.attemptCount;
    this.setCache(input.key, {
      ...input.key,
      status: "ERROR",
      result: null,
      error: clone(input.error),
      responseHash: input.responseHash,
      executorSessionId: null,
      capturedAt: input.capturedAt.toISOString(),
      expiresAt: input.expiresAt.toISOString(),
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    this.atomicFailCount += 1;
    return job;
  }

  async deferClaim(input) {
    this.requireSession(input.accountId, input.collectorSessionId);
    const job = this.jobs.find((value) =>
      value.accountId === input.accountId && value.id === input.jobId);
    if (
      !job
      || job.status !== "PROCESSING"
      || job.claimedSessionId !== input.collectorSessionId
    ) {
      throw Object.assign(new Error("claim ownership rejected"), {
        status: 409,
        code: "OZON_ENRICHMENT_JOB_OWNERSHIP",
      });
    }
    job.status = "PENDING";
    job.attemptCount = Number(job.attemptCount || 0) + 1;
    job.nextAttemptAt = new Date(input.now.getTime() + 30_000).toISOString();
    job.lastError = clone(input.error);
    job.claimedSessionId = null;
    job.claimExpiresAt = null;
    this.deferCount += 1;
    return clone(job);
  }

  async readJob({ accountId, jobId }) {
    return clone(this.jobs.find((job) => job.accountId === accountId && job.id === jobId) || null);
  }
}

function harness({ repository, start = START, collectItems, assertListingReady } = {}) {
  const clock = { value: start };
  const sessions = [
    session("collector-request"),
    session("collector-preferred"),
    session("collector-fallback"),
    session("collector-other-account", "account-b"),
  ];
  const fake = repository || new FakeRepository({ clock, sessions });
  let sequence = 0;
  const audits = [];
  const service = createCollectorOzonEnrichmentService({
    repository: fake,
    now: () => new Date(clock.value),
    randomUUID: () => `job-${++sequence}`,
    sleep: async (milliseconds) => {
      clock.value += milliseconds;
      await new Promise((resolve) => setImmediate(resolve));
    },
    audit: async (event) => audits.push(event),
    ...(collectItems ? { collectItems } : {}),
    ...(assertListingReady ? { assertListingReady } : {}),
  });
  return { audits, clock, repository: fake, service };
}

async function waitFor(check, message = "condition") {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${message}`);
}

function key(accountId, sku) {
  return { accountId, source: "ozon", sku, contractVersion: CONTRACT_VERSION };
}

test("observing Seller context advances only the authenticated account and Collector session watermark", async () => {
  const h = harness();
  const context = captureContext();

  const output = await h.service.observeSellerContext({
    session: session("collector-request"),
    captureContext: context,
  });

  assert.equal(output, undefined);
  assert.deepEqual(h.repository.lastSellerContextAdvance, {
    accountId: "account-a",
    collectorSessionId: "collector-request",
    captureContext: context,
    now: new Date(START),
  });
});

test("available job forwards the session scope and returns a strict boolean", async () => {
  const h = harness();
  h.repository.availableJobResult = 1;

  const available = await h.service.hasAvailableJob({
    session: session("collector-request"),
  });

  assert.equal(available, true);
  assert.deepEqual(h.repository.availableJobInput, {
    accountId: "account-a",
    collectorSessionId: "collector-request",
    now: new Date(START),
  });
});

test("available job sanitizes repository failures", async () => {
  const h = harness();
  h.repository.availableJobError = Object.assign(
    new Error("disk path /private/secret cst_secret-secret-secret"),
    { code: "INTERNAL_DISK_FAILURE" },
  );

  await assert.rejects(
    h.service.hasAvailableJob({ session: session("collector-request") }),
    (error) => error?.status === 502
      && error?.code === "OZON_ENRICH_UPSTREAM_FAILED"
      && error?.message === "Ozon 商品资料暂时无法读取",
  );
});

test("returns a live six-hour cache hit without creating a job", async () => {
  const h = harness();
  h.repository.setCache(key("account-a", "sku-hit"), {
    status: "COMPLETE",
    result: completeResult("sku-hit"),
    executorSessionId: "collector-preferred",
    capturedAt: new Date(START).toISOString(),
    expiresAt: new Date(START + 6 * 60 * 60 * 1000).toISOString(),
  });

  const result = await h.service.enrichOne({
    session: session("collector-request"),
    requestId: "request-hit",
    sku: "sku-hit",
  });

  assert.equal(result.cache.hit, true);
  assert.equal(result.cache.expiresAt, new Date(START + 6 * 60 * 60 * 1000).toISOString());
  assert.equal(h.repository.createdJobCount, 0);
});

test("concurrent cold callers share one cache lease and fixed job", async () => {
  const h = harness();
  const input = { session: session("collector-request"), requestId: "request-cold", sku: "sku-cold" };
  const first = h.service.enrichOne(input);
  const second = h.service.enrichOne(input);
  await waitFor(() => h.repository.jobs[0], "cold job");

  const claimed = await h.service.claimNext({ session: session("collector-fallback") });
  assert.deepEqual({ ...claimed, claimFence: "<fence>" }, {
    id: h.repository.jobs[0].id,
    requestId: "request-cold",
    sku: "sku-cold",
    refreshBundle: true,
    claimFence: "<fence>",
  });
  assert.match(claimed.claimFence, /^job-\d+$/);
  await h.service.completeClaim({
    session: session("collector-fallback"),
    jobId: claimed.id,
    variantData: variantData(701),
  });

  const results = await Promise.all([first, second]);
  assert.equal(results[0].descriptionCategoryId, 701);
  assert.deepEqual(results[1], results[0]);
  assert.equal(h.repository.createdJobCount, 1);
});

test("prefers the last successful executor for one second then permits same-account fallback", async () => {
  const h = harness();
  h.repository.setCache(key("account-a", "sku-preferred"), {
    status: "COMPLETE",
    result: completeResult("sku-preferred", 100),
    executorSessionId: "collector-preferred",
    capturedAt: new Date(START - 7 * 60 * 60 * 1000).toISOString(),
    expiresAt: new Date(START).toISOString(),
  });
  const pending = h.service.enrichOne({
    session: session("collector-request"),
    requestId: "request-preferred",
    sku: "sku-preferred",
  });
  const job = await waitFor(() => h.repository.jobs[0], "preferred job");

  h.clock.value = new Date(job.createdAt).getTime() + 999;
  assert.equal(await h.service.claimNext({ session: session("collector-fallback") }), null);
  h.clock.value = new Date(job.createdAt).getTime() + 1000;
  const fallbackClaim = await h.service.claimNext({ session: session("collector-fallback") });
  assert.equal(fallbackClaim.id, job.id);
  await h.service.completeClaim({
    session: session("collector-fallback"),
    jobId: job.id,
    variantData: variantData(702),
  });
  assert.equal((await pending).descriptionCategoryId, 702);
});

test("normalizes a claimed variant before persisting success for exactly six hours", async () => {
  const h = harness();
  const pending = h.service.enrichOne({
    session: session("collector-request"),
    requestId: "request-normalize",
    sku: "sku-normalize",
  });
  await waitFor(() => h.repository.jobs[0], "normalization job");
  const claim = await h.service.claimNext({ session: session("collector-fallback") });
  const completedAt = h.clock.value;
  await h.service.completeClaim({
    session: session("collector-fallback"),
    jobId: claim.id,
    variantData: variantData(703),
  });

  const result = await pending;
  assert.equal(result.descriptionCategoryId, 703);
  assert.deepEqual(result.logistics, { weightG: 500, lengthMm: 300, widthMm: 200, heightMm: 100 });
  assert.equal(result.source, "EXTENSION_SELLER_CAPTURE");
  assert.equal(result.cache.hit, false);
  assert.equal(new Date(result.cache.expiresAt).getTime(), completedAt + 6 * 60 * 60 * 1000);
  assert.equal(h.repository.jobs[0].status, "SUCCESS");
  assert.equal(h.repository.atomicCompleteCount, 1);
});

test("server rejects a result when the claim fence changes during send and applies nothing", async () => {
  const h = harness();
  const pending = h.service.enrichOne({
    session: session("collector-request"),
    requestId: "request-fenced-send",
    sku: "sku-fenced-send",
  });
  await waitFor(() => h.repository.jobs[0], "fenced job");
  const claimedContext = captureContext();
  const claim = await h.service.claimNext({
    session: session("collector-fallback"),
    captureContext: claimedContext,
  });
  h.repository.jobs[0].claimFence = "server-rotated-fence";

  await assert.rejects(h.service.completeClaim({
    session: session("collector-fallback"),
    jobId: claim.id,
    claimFence: claim.claimFence,
    variantData: variantData(704),
    captureContext: claimedContext,
  }), (error) => error?.status === 409 && error?.code === "SELLER_CONTEXT_CHANGED");

  assert.equal(h.repository.jobs[0].status, "PROCESSING");
  assert.equal(h.repository.atomicCompleteCount, 0);
  h.clock.value += 20_000;
  await assert.rejects(pending, /Ozon 商品资料/);
});

test("fails a cold request at the shared twenty-second deadline without real sleeps", async () => {
  const h = harness();
  await assert.rejects(
    h.service.enrichOne({
      session: session("collector-request"),
      requestId: "request-timeout",
      sku: "sku-timeout",
    }),
    (error) => error?.status === 504
      && error?.code === "OZON_ENRICH_UPSTREAM_FAILED"
      && error?.retryable === true,
  );
  assert.equal(h.clock.value, START + 20_000);
});

test("same request id recovers its expired nonterminal job after a twenty-second timeout", async () => {
  let clock = START;
  let sequence = 0;
  const state = {
    collectorSessions: [{
      id: "collector-retry",
      accountId: "account-a",
      expiresAt: new Date(START + 60 * 60 * 1000).toISOString(),
      revokedAt: null,
    }],
  };
  const repository = createJsonCollectorOzonEnrichmentRepository({ state });
  const service = createCollectorOzonEnrichmentService({
    repository,
    now: () => new Date(clock),
    randomUUID: () => `job-retry-${++sequence}`,
    sleep: async (milliseconds) => {
      clock += milliseconds;
      await new Promise((resolve) => setImmediate(resolve));
    },
  });
  const input = {
    session: session("collector-retry"),
    requestId: "request-retry-stable",
    sku: "sku-retry-stable",
  };
  await assert.rejects(service.enrichOne(input), (error) => error?.status === 504);
  assert.equal(state.collectorOzonEnrichmentJobs.length, 1);
  const originalJobId = state.collectorOzonEnrichmentJobs[0].id;
  assert.equal(state.collectorOzonEnrichmentJobs[0].deadlineAt, new Date(clock).toISOString());

  const retried = service.enrichOne(input);
  await waitFor(
    () => state.collectorOzonEnrichmentJobs[0].createdAt === new Date(START + 20_000).toISOString(),
    "requeued stable job",
  );
  const claim = await service.claimNext({ session: session("collector-retry") });
  assert.equal(claim.id, originalJobId);
  await service.completeClaim({
    session: session("collector-retry"),
    jobId: claim.id,
    variantData: variantData(799),
  });
  assert.equal((await retried).descriptionCategoryId, 799);
  assert.equal(state.collectorOzonEnrichmentJobs.length, 1);
});

test("late lease acquisition requeues an expired stable job from acquiredAt within the original deadline", async () => {
  let clock = START;
  const state = {
    collectorSessions: [
      {
        id: "collector-late-request",
        accountId: "account-a",
        expiresAt: new Date(START + 60_000).toISOString(),
        revokedAt: null,
      },
      {
        id: "collector-late-executor",
        accountId: "account-a",
        expiresAt: new Date(START + 60_000).toISOString(),
        revokedAt: null,
      },
    ],
    collectorOzonEnrichmentCache: [{
      ...key("account-a", "sku-late-requeue"),
      leaseOwner: "old-lease-owner",
      leaseExpiresAt: new Date(START + 1_500).toISOString(),
    }],
  };
  const repository = createJsonCollectorOzonEnrichmentRepository({ state });
  await repository.createOrGetJob({
    id: "job-late-stable",
    accountId: "account-a",
    requestId: "request-late-stable",
    sku: "sku-late-requeue",
    preferredSessionId: null,
    refreshBundle: true,
    deadlineAt: new Date(START + 1_000),
    createdAt: new Date(START - 1_000),
  });
  const originalCreate = repository.createOrGetJob.bind(repository);
  const created = deferred();
  const releaseCreate = deferred();
  let createInput;
  const serviceRepository = {
    ...repository,
    async createOrGetJob(input) {
      createInput = input;
      const job = await originalCreate(input);
      created.resolve(job);
      await releaseCreate.promise;
      return job;
    },
  };
  const service = createCollectorOzonEnrichmentService({
    repository: serviceRepository,
    now: () => new Date(clock),
    randomUUID: () => "new-late-owner",
    sleep: async (milliseconds) => {
      clock += milliseconds;
      await new Promise((resolve) => setImmediate(resolve));
    },
  });
  const pending = service.enrichOne({
    session: session("collector-late-request"),
    requestId: "request-late-stable",
    sku: "sku-late-requeue",
  });
  const requeued = await created.promise;
  try {
    assert.equal(createInput.createdAt.toISOString(), new Date(START + 1_500).toISOString());
    assert.equal(createInput.deadlineAt.toISOString(), new Date(START + 20_000).toISOString());
    assert.equal(requeued.id, "job-late-stable");
    assert.equal(state.collectorOzonEnrichmentJobs.length, 1);
    assert.equal(requeued.createdAt, new Date(START + 1_500).toISOString());
    const claim = await service.claimNext({ session: session("collector-late-executor") });
    assert.equal(claim.id, "job-late-stable");
    await service.completeClaim({
      session: session("collector-late-executor"),
      jobId: claim.id,
      variantData: variantData(798),
    });
  } finally {
    releaseCreate.resolve();
  }
  assert.equal((await pending).descriptionCategoryId, 798);
});

test("a different request starts its preferred-executor second at late acquiredAt", async () => {
  let clock = START;
  const state = {
    collectorSessions: [
      {
        id: "collector-preference-request",
        accountId: "account-a",
        expiresAt: new Date(START + 60_000).toISOString(),
        revokedAt: null,
      },
      {
        id: "collector-preference-owner",
        accountId: "account-a",
        expiresAt: new Date(START + 60_000).toISOString(),
        revokedAt: null,
      },
      {
        id: "collector-preference-fallback",
        accountId: "account-a",
        expiresAt: new Date(START + 60_000).toISOString(),
        revokedAt: null,
      },
    ],
    collectorOzonEnrichmentCache: [{
      ...key("account-a", "sku-late-preference"),
      status: "COMPLETE",
      result: completeResult("sku-late-preference", 100),
      executorSessionId: "collector-preference-owner",
      capturedAt: new Date(START - 6 * 60 * 60 * 1000).toISOString(),
      expiresAt: new Date(START).toISOString(),
      leaseOwner: "old-preference-lease",
      leaseExpiresAt: new Date(START + 1_500).toISOString(),
    }],
  };
  const repository = createJsonCollectorOzonEnrichmentRepository({ state });
  const originalCreate = repository.createOrGetJob.bind(repository);
  const created = deferred();
  const releaseCreate = deferred();
  const serviceRepository = {
    ...repository,
    async createOrGetJob(input) {
      const job = await originalCreate(input);
      created.resolve(job);
      await releaseCreate.promise;
      return job;
    },
  };
  const service = createCollectorOzonEnrichmentService({
    repository: serviceRepository,
    now: () => new Date(clock),
    randomUUID: () => "job-late-preference",
    sleep: async (milliseconds) => {
      clock += milliseconds;
      await new Promise((resolve) => setImmediate(resolve));
    },
  });
  const pending = service.enrichOne({
    session: session("collector-preference-request"),
    requestId: "request-late-preference",
    sku: "sku-late-preference",
  });
  const job = await created.promise;
  let earlyClaim;
  try {
    assert.equal(job.createdAt, new Date(START + 1_500).toISOString());
    clock = START + 2_499;
    earlyClaim = await service.claimNext({ session: session("collector-preference-fallback") });
    if (!earlyClaim) {
      clock = START + 2_500;
      const fallback = await service.claimNext({ session: session("collector-preference-fallback") });
      await service.completeClaim({
        session: session("collector-preference-fallback"),
        jobId: fallback.id,
        variantData: variantData(797),
      });
    } else {
      await service.completeClaim({
        session: session("collector-preference-fallback"),
        jobId: earlyClaim.id,
        variantData: variantData(797),
      });
    }
  } finally {
    releaseCreate.resolve();
  }
  await pending;
  assert.equal(earlyClaim, null);
});

test("recovers an expired processing claim with another valid same-account session", async () => {
  const h = harness();
  const pending = h.service.enrichOne({
    session: session("collector-request"),
    requestId: "request-recover",
    sku: "sku-recover",
  });
  await waitFor(() => h.repository.jobs[0], "recovery job");
  const first = await h.service.claimNext({ session: session("collector-preferred") });
  const claimExpiry = new Date(h.repository.jobs[0].claimExpiresAt).getTime();
  assert.equal(claimExpiry - h.clock.value, 15_000);
  h.clock.value = claimExpiry;
  const recovered = await h.service.claimNext({ session: session("collector-fallback") });
  assert.equal(recovered.id, first.id);
  await h.service.completeClaim({
    session: session("collector-fallback"),
    jobId: recovered.id,
    variantData: variantData(704),
  });
  assert.equal((await pending).descriptionCategoryId, 704);
});

test("failClaim uses the server-fixed sixty-second negative TTL", async () => {
  const h = harness();
  const pending = h.service.enrichOne({
    session: session("collector-request"),
    requestId: "request-negative",
    sku: "sku-negative",
  });
  await waitFor(() => h.repository.jobs[0], "negative job");
  const claim = await h.service.claimNext({ session: session("collector-fallback") });
  const failedAt = h.clock.value;
  await h.service.failClaim({
    session: session("collector-fallback"),
    jobId: claim.id,
    code: "OZON_ENRICH_NOT_FOUND",
    message: "not found cst_should-never-leak",
  });

  await assert.rejects(pending, (error) =>
    error?.status === 404
      && error?.code === "OZON_ENRICH_NOT_FOUND"
      && !String(error?.message).includes("cst_should-never-leak"));
  const cached = h.repository.cache.get(h.repository.cacheKey(key("account-a", "sku-negative")));
  assert.equal(new Date(cached.expiresAt).getTime() - failedAt, 60_000);
  assert.equal(h.repository.atomicFailCount, 1);
  assert.deepEqual(h.repository.jobs[0].error, {
    status: 404,
    code: "OZON_ENRICH_NOT_FOUND",
  });
  const jobsBefore = h.repository.createdJobCount;
  await assert.rejects(h.service.enrichOne({
    session: session("collector-request"),
    requestId: "request-negative-retry",
    sku: "sku-negative",
  }), (error) => error?.code === "OZON_ENRICH_NOT_FOUND");
  assert.equal(h.repository.createdJobCount, jobsBefore);
});

test("retryable failure on a non-linked held job terminates inside its twenty-second deadline", async () => {
  const h = harness();
  h.repository.jobs.push({
    id: "job-held-transient",
    accountId: "account-a",
    collectItemId: null,
    requestId: "request-held-transient",
    sku: "sku-held-transient",
    status: "PROCESSING",
    claimedSessionId: "collector-fallback",
    claimExpiresAt: new Date(START + 15_000).toISOString(),
    deadlineAt: new Date(START + 20_000).toISOString(),
    attemptCount: 0,
    createdAt: new Date(START).toISOString(),
  });

  const failed = await h.service.failClaim({
    session: session("collector-fallback"),
    jobId: "job-held-transient",
    code: "NETWORK_ERROR",
  });

  assert.deepEqual(failed, { id: "job-held-transient", status: "FAILED" });
  assert.equal(h.repository.deferCount, 0);
  assert.equal(h.repository.atomicFailCount, 1);
  assert.equal(h.repository.jobs[0].status, "FAILED");
  assert.deepEqual(h.repository.jobs[0].error, {
    status: 502,
    code: "OZON_ENRICH_UPSTREAM_FAILED",
  });
});

test("never returns a six-hour-expired result and creates a server-owned refresh job", async () => {
  const h = harness();
  h.repository.setCache(key("account-a", "sku-stale"), {
    status: "COMPLETE",
    result: completeResult("sku-stale", 111),
    executorSessionId: "collector-preferred",
    capturedAt: new Date(START - 6 * 60 * 60 * 1000).toISOString(),
    expiresAt: new Date(START).toISOString(),
  });
  const pending = h.service.enrichOne({
    session: session("collector-request"),
    requestId: "request-stale",
    sku: "sku-stale",
    refreshBundle: false,
  });
  const job = await waitFor(() => h.repository.jobs[0], "stale refresh job");
  assert.equal(job.refreshBundle, true);
  assert.equal(job.preferredSessionId, "collector-preferred");
  assert.equal(job.descriptionCategoryId, undefined);
  const claim = await h.service.claimNext({ session: session("collector-preferred") });
  await h.service.completeClaim({
    session: session("collector-preferred"),
    jobId: claim.id,
    variantData: variantData(705),
  });
  assert.equal((await pending).descriptionCategoryId, 705);
});

test("rejects malformed and wrong-account claim completion sessions", async () => {
  const h = harness();
  await assert.rejects(
    h.service.enrichOne({ session: {}, requestId: "request", sku: "sku" }),
    (error) => error?.status === 401 && error?.code === "COLLECTOR_AUTH_REQUIRED",
  );
  const pending = h.service.enrichOne({
    session: session("collector-request"),
    requestId: "request-scope",
    sku: "sku-scope",
  });
  await waitFor(() => h.repository.jobs[0], "scoped job");
  const claim = await h.service.claimNext({ session: session("collector-preferred") });
  await assert.rejects(h.service.completeClaim({
    session: session("collector-other-account", "account-b"),
    jobId: claim.id,
    variantData: variantData(),
  }), (error) => error?.code === "OZON_ENRICHMENT_JOB_OWNERSHIP");
  await assert.rejects(h.service.completeClaim({
    session: session("collector-fallback"),
    jobId: claim.id,
    variantData: variantData(),
  }), (error) => error?.code === "OZON_ENRICHMENT_JOB_OWNERSHIP");
  await h.service.completeClaim({
    session: session("collector-preferred"),
    jobId: claim.id,
    variantData: variantData(706),
  });
  await pending;
});

test("batch preserves order and isolates a failed item from successful siblings", async () => {
  const h = harness();
  for (const sku of ["sku-a", "sku-c"]) {
    h.repository.setCache(key("account-a", sku), {
      status: "COMPLETE",
      result: completeResult(sku),
      executorSessionId: "collector-preferred",
      capturedAt: new Date(START).toISOString(),
      expiresAt: new Date(START + 6 * 60 * 60 * 1000).toISOString(),
    });
  }
  h.repository.setCache(key("account-a", "sku-b"), {
    status: "ERROR",
    error: {
      status: 422,
      code: "OZON_ENRICH_INCOMPLETE",
      message: "商品资料不完整",
      missingFields: ["weightG"],
      retryable: true,
    },
    capturedAt: new Date(START).toISOString(),
    expiresAt: new Date(START + 60_000).toISOString(),
  });

  const batch = await h.service.enrichBatch({
    session: session("collector-request"),
    requestId: "request-batch",
    skus: ["sku-a", "sku-b", "sku-c"],
  });

  assert.deepEqual(batch.map((item) => [item.sku, item.status]), [
    ["sku-a", "COMPLETE"],
    ["sku-b", "ERROR"],
    ["sku-c", "COMPLETE"],
  ]);
  assert.deepEqual(batch[1].error, {
    code: "OZON_ENRICH_INCOMPLETE",
    message: "Ozon 商品资料不完整",
    missingFields: ["weightG"],
    retryable: false,
  });
});

test("batch schedules at most four repository reads concurrently", async () => {
  let active = 0;
  let maximum = 0;
  const h = harness();
  h.repository.readCache = async ({ key }) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return {
      status: "COMPLETE",
      result: completeResult(key.sku),
      expiresAt: new Date(START + 6 * 60 * 60 * 1000).toISOString(),
    };
  };
  const items = await h.service.enrichBatch({
    session: session("collector-request"),
    requestId: "request-capacity",
    skus: Array.from({ length: 9 }, (_, index) => `sku-${index + 1}`),
  });
  assert.equal(items.length, 9);
  assert.equal(maximum, 4);
});

test("batch maps an unexpected repository exception to the fixed public upstream error", async () => {
  const h = harness();
  h.repository.readCache = async () => {
    throw Object.assign(new Error("disk path /private/secret cst_secret-secret-secret"), {
      code: "INTERNAL_DISK_FAILURE",
    });
  };
  const items = await h.service.enrichBatch({
    session: session("collector-request"),
    requestId: "request-batch-private-error",
    skus: ["sku-private-error"],
  });
  assert.deepEqual(items, [{
    sku: "sku-private-error",
    status: "ERROR",
    error: {
      code: "OZON_ENRICH_UPSTREAM_FAILED",
      message: "Ozon 商品资料暂时无法读取",
      missingFields: [],
      retryable: true,
    },
  }]);
  assert.equal(JSON.stringify(items).includes("/private/secret"), false);
});

test("expired terminal idempotency replay releases its lease and returns stable 409", async () => {
  const h = harness();
  const staleKey = key("account-a", "sku-terminal-expired");
  h.repository.setCache(staleKey, {
    status: "COMPLETE",
    result: completeResult("sku-terminal-expired", 222),
    executorSessionId: "collector-preferred",
    capturedAt: new Date(START - 7 * 60 * 60 * 1000).toISOString(),
    expiresAt: new Date(START).toISOString(),
  });
  h.repository.jobs.push({
    id: "job-terminal-expired",
    accountId: "account-a",
    requestId: "request-terminal-expired",
    sku: "sku-terminal-expired",
    status: "SUCCESS",
    preferredSessionId: "collector-preferred",
    claimedSessionId: "collector-preferred",
    claimExpiresAt: new Date(START - 1).toISOString(),
    refreshBundle: true,
    deadlineAt: new Date(START - 1).toISOString(),
    result: completeResult("sku-terminal-expired", 222),
    error: null,
    createdAt: new Date(START - 20_001).toISOString(),
  });

  await assert.rejects(h.service.enrichOne({
    session: session("collector-request"),
    requestId: "request-terminal-expired",
    sku: "sku-terminal-expired",
  }), (error) => error?.status === 409
    && error?.code === "OZON_ENRICH_REQUEST_EXPIRED"
    && error?.retryable === false);
  const cache = h.repository.cache.get(h.repository.cacheKey(staleKey));
  assert.equal(cache.leaseOwner, null);
  assert.equal(cache.result.descriptionCategoryId, 222);
});

test("a terminal replay follower reacquires the released lease instead of waiting to timeout", async () => {
  const h = harness();
  h.repository.jobs.push({
    id: "job-terminal-followers",
    accountId: "account-a",
    requestId: "request-terminal-followers",
    sku: "sku-terminal-followers",
    status: "SUCCESS",
    preferredSessionId: null,
    claimedSessionId: "collector-preferred",
    claimExpiresAt: new Date(START - 1).toISOString(),
    refreshBundle: true,
    deadlineAt: new Date(START - 1).toISOString(),
    result: completeResult("sku-terminal-followers"),
    error: null,
    createdAt: new Date(START - 20_001).toISOString(),
  });
  const originalCreate = h.repository.createOrGetJob.bind(h.repository);
  let enterFirst;
  let releaseFirst;
  const firstEntered = new Promise((resolve) => { enterFirst = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let createCalls = 0;
  h.repository.createOrGetJob = async (input) => {
    createCalls += 1;
    if (createCalls === 1) {
      enterFirst();
      await firstGate;
    }
    return originalCreate(input);
  };
  const input = {
    session: session("collector-request"),
    requestId: "request-terminal-followers",
    sku: "sku-terminal-followers",
  };
  const owner = h.service.enrichOne(input);
  await firstEntered;
  const follower = h.service.enrichOne(input);
  await waitFor(() => h.repository.leaseAttempts.length >= 2, "contended follower lease");
  releaseFirst();

  const outcomes = await Promise.allSettled([owner, follower]);
  assert.deepEqual(outcomes.map((outcome) => outcome.reason?.code), [
    "OZON_ENRICH_REQUEST_EXPIRED",
    "OZON_ENRICH_REQUEST_EXPIRED",
  ]);
  assert.equal(createCalls, 2);
  assert.ok(h.clock.value < START + 20_000);
});

test("a follower recovers after the first lease owner fails before creating a job", async () => {
  const h = harness();
  const originalCreate = h.repository.createOrGetJob.bind(h.repository);
  let enterFirst;
  let releaseFirst;
  const firstEntered = new Promise((resolve) => { enterFirst = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let createCalls = 0;
  h.repository.createOrGetJob = async (input) => {
    createCalls += 1;
    if (createCalls === 1) {
      enterFirst();
      await firstGate;
      throw Object.assign(new Error("database path and credentials"), {
        code: "OZON_ENRICHMENT_PERSISTENCE_FAILED",
        status: 500,
      });
    }
    return originalCreate(input);
  };
  const input = {
    session: session("collector-request"),
    requestId: "request-create-follower",
    sku: "sku-create-follower",
  };
  const owner = h.service.enrichOne(input);
  await firstEntered;
  const follower = h.service.enrichOne(input);
  await waitFor(() => h.repository.leaseAttempts.length >= 2, "create follower contention");
  releaseFirst();
  await assert.rejects(owner, (error) => error?.code === "OZON_ENRICH_UPSTREAM_FAILED"
    && error?.message === "Ozon 商品资料暂时无法读取");
  const job = await waitFor(() => h.repository.jobs[0], "follower-created job");
  const claim = await h.service.claimNext({ session: session("collector-fallback") });
  await h.service.completeClaim({
    session: session("collector-fallback"),
    jobId: claim.id,
    variantData: variantData(902),
  });
  assert.equal((await follower).descriptionCategoryId, 902);
  assert.equal(job.id, h.repository.jobs[0].id);
  assert.equal(createCalls, 2);
});

test("claim expiry is capped at the job deadline and completion at the boundary cannot write cache", async () => {
  let clock = START;
  const state = {
    collectorSessions: [{
      id: "collector-deadline",
      accountId: "account-a",
      expiresAt: new Date(START + 60_000).toISOString(),
      revokedAt: null,
    }],
  };
  const repository = createJsonCollectorOzonEnrichmentRepository({ state });
  await repository.createOrGetJob({
    id: "job-deadline-cap",
    accountId: "account-a",
    requestId: "request-deadline-cap",
    sku: "sku-deadline-cap",
    preferredSessionId: null,
    refreshBundle: true,
    deadlineAt: new Date(START + 1000),
    createdAt: new Date(START),
  });
  const service = createCollectorOzonEnrichmentService({
    repository,
    now: () => new Date(clock),
  });
  clock = START + 800;
  const claim = await service.claimNext({ session: session("collector-deadline") });
  assert.equal(claim.id, "job-deadline-cap");
  assert.equal(state.collectorOzonEnrichmentJobs[0].claimExpiresAt, new Date(START + 1000).toISOString());
  clock = START + 1000;
  await assert.rejects(service.completeClaim({
    session: session("collector-deadline"),
    jobId: claim.id,
    variantData: variantData(901),
  }), (error) => error?.code === "OZON_ENRICHMENT_JOB_OWNERSHIP"
    && error?.message === "Collector 会话不拥有该 Ozon 商品补全任务");
  assert.equal(state.collectorOzonEnrichmentCache, undefined);
});

test("complete persistence failures use a stable public error and audit the rejected attempt", async () => {
  const h = harness();
  const pending = h.service.enrichOne({
    session: session("collector-request"),
    requestId: "request-complete-persistence",
    sku: "sku-complete-persistence",
  });
  await waitFor(() => h.repository.jobs[0], "persistence job");
  const claim = await h.service.claimNext({ session: session("collector-fallback") });
  h.repository.completeJobAndCache = async () => {
    throw Object.assign(new Error("PostgreSQL relation and filesystem detail"), {
      code: "OZON_ENRICHMENT_PERSISTENCE_FAILED",
      status: 500,
    });
  };

  await assert.rejects(h.service.completeClaim({
    session: session("collector-fallback"),
    jobId: claim.id,
    variantData: variantData(903),
  }), (error) => error?.code === "OZON_ENRICH_UPSTREAM_FAILED"
    && error?.message === "Ozon 商品资料暂时无法读取");
  const audit = h.audits.at(-1);
  assert.equal(audit.action, "collector.ozon.enrichment.complete");
  assert.equal(audit.status, "FAILED");
  assert.equal(audit.code, "OZON_ENRICH_UPSTREAM_FAILED");
  assert.equal(JSON.stringify(audit).includes("filesystem detail"), false);
  await assert.rejects(pending);
});

test("a rejected fail attempt is audited with stable ownership semantics", async () => {
  const h = harness();
  const pending = h.service.enrichOne({
    session: session("collector-request"),
    requestId: "request-fail-audit",
    sku: "sku-fail-audit",
  });
  await waitFor(() => h.repository.jobs[0], "failure audit job");
  const claim = await h.service.claimNext({ session: session("collector-preferred") });
  await assert.rejects(h.service.failClaim({
    session: session("collector-fallback"),
    jobId: claim.id,
    code: "OZON_ENRICH_NOT_FOUND",
  }), (error) => error?.code === "OZON_ENRICHMENT_JOB_OWNERSHIP"
    && error?.message === "Collector 会话不拥有该 Ozon 商品补全任务");
  assert.equal(h.audits.at(-1).action, "collector.ozon.enrichment.fail");
  assert.equal(h.audits.at(-1).status, "FAILED");
  assert.equal(h.audits.at(-1).code, "OZON_ENRICHMENT_JOB_OWNERSHIP");

  await h.service.completeClaim({
    session: session("collector-preferred"),
    jobId: claim.id,
    variantData: variantData(904),
  });
  await pending;
});

test("canonical response hashes ignore object key order while preserving JSON semantics", async () => {
  async function completeAndHash(inputVariantData) {
    const h = harness();
    const pending = h.service.enrichOne({
      session: session("collector-request"),
      requestId: "request-canonical-hash",
      sku: "sku-canonical-hash",
    });
    await waitFor(() => h.repository.jobs[0], "canonical hash job");
    const claim = await h.service.claimNext({ session: session("collector-fallback") });
    await h.service.completeClaim({
      session: session("collector-fallback"),
      jobId: claim.id,
      variantData: inputVariantData,
    });
    await pending;
    return h.audits.find((event) => event.action === "collector.ozon.enrichment.complete")
      ?.responseHash;
  }

  const left = await completeAndHash({
    description_category_id: 123,
    type_id: 456,
    presentation: { zeta: { right: 2, left: 1 }, alpha: true },
    attributes: [
      { key: "4497", value: "500" },
      { key: "9454", value: "300" },
      { key: "9455", value: "200" },
      { key: "9456", value: "100" },
    ],
  });
  const right = await completeAndHash(JSON.parse(`{
    "attributes":[
      {"value":"500","key":"4497"},
      {"value":"300","key":"9454"},
      {"value":"200","key":"9455"},
      {"value":"100","key":"9456"}
    ],
    "presentation":{"alpha":true,"zeta":{"left":1,"right":2}},
    "type_id":456,
    "description_category_id":123
  }`));
  const reorderedArray = await completeAndHash({
    description_category_id: 123,
    type_id: 456,
    presentation: { alpha: true, zeta: { left: 1, right: 2 } },
    attributes: [
      { key: "9456", value: "100" },
      { key: "9455", value: "200" },
      { key: "9454", value: "300" },
      { key: "4497", value: "500" },
    ],
  });

  assert.match(left, /^[a-f0-9]{64}$/);
  assert.equal(right, left);
  assert.notEqual(reorderedArray, left);
});

test("audit sink failure emits a safe operational signal without failing a cache hit", async () => {
  const signals = [];
  const clock = { value: START };
  const repository = new FakeRepository({ clock, sessions: [session("collector-request")] });
  repository.setCache(key("account-a", "sku-audit-signal"), {
    status: "COMPLETE",
    result: completeResult("sku-audit-signal"),
    executorSessionId: "collector-request",
    capturedAt: new Date(START).toISOString(),
    expiresAt: new Date(START + 6 * 60 * 60 * 1000).toISOString(),
  });
  const service = createCollectorOzonEnrichmentService({
    repository,
    now: () => new Date(START),
    audit: async () => { throw new Error("audit database secret"); },
    onAuditError: (event) => signals.push(event),
  });
  const enriched = await service.enrichOne({
    session: session("collector-request"),
    requestId: "request-audit-signal",
    sku: "sku-audit-signal",
  });
  assert.equal(enriched.cache.hit, true);
  assert.deepEqual(signals, [{
    action: "collector.ozon.enrich",
    accountId: "account-a",
    requestId: "request-audit-signal",
    jobId: "",
  }]);
  assert.equal(JSON.stringify(signals).includes("audit database secret"), false);
});

test("rejects a fifth simultaneous cold request for one account with stable busy error", async () => {
  const h = harness();
  const pending = Array.from({ length: 4 }, (_, index) => h.service.enrichOne({
    session: session("collector-request"),
    requestId: `request-busy-${index + 1}`,
    sku: `sku-busy-${index + 1}`,
  }));
  await waitFor(() => h.repository.jobs.length === 4, "four account jobs");

  await assert.rejects(h.service.enrichOne({
    session: session("collector-request"),
    requestId: "request-busy-5",
    sku: "sku-busy-5",
  }), (error) => error?.status === 429
    && error?.code === "OZON_ENRICH_BUSY"
    && error?.retryable === true);
  assert.equal(h.repository.jobs.length, 4);

  for (let index = 0; index < 4; index += 1) {
    const claim = await h.service.claimNext({ session: session("collector-fallback") });
    await h.service.completeClaim({
      session: session("collector-fallback"),
      jobId: claim.id,
      variantData: variantData(800 + index),
    });
  }
  await Promise.all(pending);
});

test("same-key followers share one admission slot so an unrelated SKU can still start", async () => {
  const h = harness();
  const sharedInput = {
    session: session("collector-request"),
    requestId: "request-shared-capacity",
    sku: "sku-shared-capacity",
  };
  const followers = Array.from({ length: 4 }, () => h.service.enrichOne(sharedInput));
  await waitFor(() => h.repository.jobs.length === 1, "shared capacity job");
  const unrelated = h.service.enrichOne({
    session: session("collector-request"),
    requestId: "request-unrelated-capacity",
    sku: "sku-unrelated-capacity",
  });
  await waitFor(() => h.repository.jobs.length === 2, "unrelated capacity job");

  for (let index = 0; index < 2; index += 1) {
    const claim = await h.service.claimNext({ session: session("collector-fallback") });
    await h.service.completeClaim({
      session: session("collector-fallback"),
      jobId: claim.id,
      variantData: variantData(910 + index),
    });
  }
  await Promise.all([...followers, unrelated]);
  assert.equal(h.repository.createdJobCount, 2);
});

test("batch preserves request-expired as a non-retryable public item error", async () => {
  const h = harness();
  h.repository.jobs.push({
    id: "job-batch-expired",
    accountId: "account-a",
    requestId: "request-batch-expired",
    sku: "sku-batch-expired",
    status: "FAILED",
    refreshBundle: true,
    deadlineAt: new Date(START - 1).toISOString(),
    createdAt: new Date(START - 20_001).toISOString(),
  });
  const output = await h.service.enrichBatch({
    session: session("collector-request"),
    requestId: "request-batch-expired",
    skus: ["sku-batch-expired"],
  });
  assert.deepEqual(output[0].error, {
    code: "OZON_ENRICH_REQUEST_EXPIRED",
    message: "该补全请求已过期，请使用新的 requestId 重试",
    missingFields: [],
    retryable: false,
  });
});

test("linked completion fills blank logistics without replacing target category", async () => {
  const savedItems = [];
  const collectItem = {
    id: "collect-linked-complete",
    accountId: "account-a",
    draftVersion: 7,
    listingDraft: {
      descriptionCategoryId: 700,
      logistics: { weightG: 777, lengthMm: "", widthMm: "", heightMm: "" },
    },
    enrichment: { status: "PENDING_ENRICHMENT" },
  };
  let terminalRepository = null;
  const collectItems = {
    async read(input) {
      assert.deepEqual(input, {
        accountId: "account-a",
        collectItemId: "collect-linked-complete",
      });
      return clone(collectItem);
    },
    async save(input) {
      savedItems.push(clone(input));
      assert.equal(input.expectedVersion, 7);
      Object.assign(collectItem, {
        draftVersion: 8,
        listingDraft: clone(input.listingDraft),
        status: input.status,
        enrichment: clone(input.enrichment),
      });
      return clone(collectItem);
    },
    async complete(input) {
      const saved = await this.save(input);
      await terminalRepository.completeJobAndCache({
        ...input.completion,
        now: new Date("2026-08-01T08:00:01.000Z"),
      });
      return saved;
    },
    async fail() { throw new Error("unused"); },
    async retry() { throw new Error("unused"); },
  };
  const h = harness({ collectItems, start: Date.parse("2026-08-01T08:00:01.000Z") });
  terminalRepository = h.repository;
  h.repository.jobs.push({
    id: "job-linked-complete",
    accountId: "account-a",
    collectItemId: "collect-linked-complete",
    requestId: "request-linked-complete",
    sku: "4862904234",
    status: "PROCESSING",
    claimedSessionId: "collector-fallback",
    claimExpiresAt: "2026-08-01T08:01:00.000Z",
    deadlineAt: "9999-12-31T23:59:59.999Z",
    attemptCount: 2,
    createdAt: "2026-08-01T08:00:00.000Z",
  });

  const result = await h.service.completeClaim({
    session: session("collector-fallback"),
    jobId: "job-linked-complete",
    variantData: sellerVariantData(17_000_001),
    captureContext: captureContext({ observedAt: "2026-08-01T08:00:00.000Z" }),
  });

  assert.equal(savedItems.length, 1);
  assert.equal(collectItem.listingDraft.logistics.weightG, 777);
  assert.equal(collectItem.listingDraft.logistics.lengthMm, 300);
  assert.equal(collectItem.listingDraft.descriptionCategoryId, 700);
  assert.equal(collectItem.listingDraft.sourceCategory.descriptionCategoryId, 17_000_001);
  assert.deepEqual(collectItem.enrichment, {
    status: "COMPLETE",
    missingFields: [],
    attemptCount: 2,
    nextAttemptAt: "",
    lastErrorCode: "",
    capturedAt: "2026-08-01T08:00:01.000Z",
  });
  assert.equal(result.source, "EXTENSION_SELLER_CAPTURE");
  assert.equal(h.repository.atomicCompleteCount, 1);
  assert.deepEqual(h.repository.lastCompleteInput.captureContext, {
    sellerCompanyId: "2681910",
    revision: 4,
    observedAt: "2026-08-01T08:00:00.000Z",
  });
  assert.deepEqual(h.audits.at(-1).captureContext, {
    sellerCompanyId: "2681910",
    revision: 4,
    observedAt: "2026-08-01T08:00:00.000Z",
  });
  assert.equal(JSON.stringify(h.audits.at(-1)).includes("cookie"), false);
});

test("linked completion validates the merged draft before any COMPLETE transition", async () => {
  let completeCalls = 0;
  let failCalls = 0;
  let terminalRepository = null;
  const collectItem = {
    id: "collect-linked-invalid-after-merge",
    accountId: "account-a",
    draftVersion: 3,
    listingDraft: {
      descriptionCategoryId: 700,
      logistics: { weightG: 500, lengthMm: 300, widthMm: 200, heightMm: 100 },
    },
    enrichment: { status: "PENDING_ENRICHMENT" },
  };
  const h = harness({
    start: Date.parse("2026-08-01T08:00:01.000Z"),
    assertListingReady() {
      throw Object.assign(new Error("merged source evidence is incomplete"), {
        status: 422,
        code: "COLLECT_ENRICHMENT_INCOMPLETE",
        missingFields: ["descriptionCategoryId"],
      });
    },
    collectItems: {
      async read() { return clone(collectItem); },
      async save() { throw new Error("invalid completion must not save COMPLETE state"); },
      async complete() { completeCalls += 1; throw new Error("must not complete"); },
      async fail(input) {
        failCalls += 1;
        const job = await terminalRepository.failJobAndCache(input.failure);
        return { item: { id: input.collectItemId, status: input.status }, job };
      },
      async retry() { throw new Error("unused"); },
    },
  });
  terminalRepository = h.repository;
  h.repository.jobs.push({
    id: "job-linked-invalid-after-merge",
    accountId: "account-a",
    collectItemId: collectItem.id,
    requestId: "request-linked-invalid-after-merge",
    sku: "4862904234",
    status: "PROCESSING",
    claimedSessionId: "collector-fallback",
    claimExpiresAt: "2026-08-01T08:01:00.000Z",
    deadlineAt: "9999-12-31T23:59:59.999Z",
    attemptCount: 0,
    createdAt: "2026-08-01T08:00:00.000Z",
  });

  await assert.rejects(h.service.completeClaim({
    session: session("collector-fallback"),
    jobId: "job-linked-invalid-after-merge",
    variantData: sellerVariantData(17_000_001),
    captureContext: captureContext({ observedAt: "2026-08-01T08:00:00.000Z" }),
  }), (error) => error?.code === "OZON_ENRICH_INCOMPLETE"
    && error?.status === 422
    && assert.deepEqual(error.missingFields, ["descriptionCategoryId"]) === undefined);
  assert.equal(completeCalls, 0);
  assert.equal(failCalls, 1);
  assert.equal(h.repository.atomicCompleteCount, 0);
  assert.equal(h.repository.atomicFailCount, 1);
  assert.equal(h.repository.jobs[0].status, "FAILED");
});

test("retryable failures defer linked jobs and expose the correct recoverable item state", async () => {
  for (const [code, expectedStatus] of [
    ["SELLER_CONTEXT_REQUIRED", "WAITING_FOR_SELLER"],
    ["SELLER_CONTEXT_CHANGED", "WAITING_FOR_SELLER"],
    ["OZON_ENRICH_BUSY", "RETRYING"],
    ["NETWORK_ERROR", "RETRYING"],
    ["TIMEOUT", "RETRYING"],
    ["HTTP_503", "RETRYING"],
  ]) {
    const saved = [];
    let terminalRepository = null;
    const h = harness({
      collectItems: {
        async read() { throw new Error("failure status must not rewrite the draft"); },
        async save(input) { saved.push(clone(input)); return { id: input.collectItemId }; },
        async complete() { throw new Error("failure status must not complete the draft"); },
        async fail() { throw new Error("unused"); },
        async defer(input) {
          const job = await terminalRepository.deferClaim(input.deferClaim);
          const savedInput = {
            accountId: input.accountId,
            collectItemId: input.collectItemId,
            status: input.status,
            enrichment: {
              status: input.status,
              missingFields: input.error.missingFields,
              attemptCount: job.attemptCount,
              nextAttemptAt: job.nextAttemptAt,
              lastErrorCode: input.error.code,
            },
          };
          saved.push(savedInput);
          return { item: { id: input.collectItemId }, job };
        },
        async retry() { throw new Error("unused"); },
      },
      start: Date.parse("2026-08-01T08:00:01.000Z"),
    });
    terminalRepository = h.repository;
    h.repository.jobs.push({
      id: `job-${code}`,
      accountId: "account-a",
      collectItemId: `collect-${code}`,
      requestId: `request-${code}`,
      sku: `sku-${code}`,
      status: "PROCESSING",
      claimedSessionId: "collector-fallback",
      claimExpiresAt: "2026-08-01T08:01:00.000Z",
      deadlineAt: "9999-12-31T23:59:59.999Z",
      attemptCount: 0,
      createdAt: "2026-08-01T08:00:00.000Z",
    });

    const deferredJob = await h.service.failClaim({
      session: session("collector-fallback"),
      jobId: `job-${code}`,
      code,
      message: "cookie=must-not-be-stored",
    });

    assert.equal(deferredJob.status, "PENDING", code);
    assert.equal(h.repository.deferCount, 1, code);
    assert.equal(h.repository.atomicFailCount, 0, code);
    assert.equal(saved[0].status, expectedStatus, code);
    assert.deepEqual(saved[0].enrichment, {
      status: expectedStatus,
      missingFields: [],
      attemptCount: 1,
      nextAttemptAt: "2026-08-01T08:00:31.000Z",
      lastErrorCode: code === "HTTP_503" || code === "NETWORK_ERROR" || code === "TIMEOUT"
        ? "OZON_ENRICH_UPSTREAM_FAILED"
        : code,
    }, code);
    assert.equal(JSON.stringify(h.repository.jobs[0]).includes("must-not-be-stored"), false, code);
  }
});

test("retryable linked failure uses one atomic port so a completed recollect cannot be overwritten", async () => {
  let deferCalls = 0;
  let h;
  const collectItem = {
    id: "collect-recollect-won",
    accountId: "account-a",
    status: "COMPLETE",
    enrichment: { status: "COMPLETE", missingFields: [] },
  };
  h = harness({
    start: Date.parse("2026-08-01T08:00:01.000Z"),
    collectItems: {
      async read() { return clone(collectItem); },
      async save() { throw new Error("atomic defer must not perform a later item save"); },
      async complete() { throw new Error("unused"); },
      async fail() { throw new Error("unused"); },
      async retry() { throw new Error("unused"); },
      async defer(input) {
        deferCalls += 1;
        assert.equal(input.status, "RETRYING");
        assert.equal(input.error.code, "OZON_ENRICH_UPSTREAM_FAILED");
        const job = h.repository.jobs[0];
        job.status = "SUCCESS";
        job.claimedSessionId = null;
        job.claimExpiresAt = null;
        job.result = { status: "COMPLETE", source: "COLLECTED_PUBLIC_EVIDENCE" };
        return { item: clone(collectItem), job: clone(job) };
      },
    },
  });
  h.repository.jobs.push({
    id: "job-recollect-won",
    accountId: "account-a",
    collectItemId: collectItem.id,
    requestId: "request-recollect-won",
    sku: "sku-recollect-won",
    status: "PROCESSING",
    claimedSessionId: "collector-fallback",
    claimExpiresAt: "2026-08-01T08:01:00.000Z",
    deadlineAt: "9999-12-31T23:59:59.999Z",
    attemptCount: 1,
    createdAt: "2026-08-01T08:00:00.000Z",
  });

  const result = await h.service.failClaim({
    session: session("collector-fallback"),
    jobId: "job-recollect-won",
    code: "NETWORK_ERROR",
  });

  assert.equal(deferCalls, 1);
  assert.equal(h.repository.deferCount, 0);
  assert.equal(result.status, "SUCCESS");
  assert.equal(collectItem.status, "COMPLETE");
  assert.equal(collectItem.enrichment.status, "COMPLETE");
});

test("not found permanently needs attention without deleting the linked item", async () => {
  const saved = [];
  let terminalRepository = null;
  const h = harness({
    collectItems: {
      async read() { throw new Error("permanent failure must not rewrite the draft"); },
      async save(input) { saved.push(clone(input)); return { id: input.collectItemId }; },
      async complete() { throw new Error("permanent failure must not complete the draft"); },
      async fail(input) {
        const job = await terminalRepository.failJobAndCache(input.failure);
        const savedInput = {
          accountId: input.accountId,
          collectItemId: input.collectItemId,
          status: input.status,
          enrichment: {
            ...clone(input.enrichment),
            attemptCount: job.attemptCount,
          },
        };
        saved.push(savedInput);
        return { item: { id: input.collectItemId, enrichment: savedInput.enrichment }, job };
      },
      async retry() { throw new Error("unused"); },
    },
    start: Date.parse("2026-08-01T08:00:01.000Z"),
  });
  terminalRepository = h.repository;
  h.repository.jobs.push({
    id: "job-not-found-linked",
    accountId: "account-a",
    collectItemId: "collect-not-found-linked",
    requestId: "request-not-found-linked",
    sku: "sku-not-found-linked",
    status: "PROCESSING",
    claimedSessionId: "collector-fallback",
    claimExpiresAt: "2026-08-01T08:01:00.000Z",
    deadlineAt: "9999-12-31T23:59:59.999Z",
    attemptCount: 3,
    createdAt: "2026-08-01T08:00:00.000Z",
  });

  const failed = await h.service.failClaim({
    session: session("collector-fallback"),
    jobId: "job-not-found-linked",
    code: "OZON_ENRICH_NOT_FOUND",
  });

  assert.equal(failed.status, "FAILED");
  assert.equal(h.repository.atomicFailCount, 1);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].status, "NEEDS_ATTENTION");
  assert.equal(saved[0].deleted, undefined);
  assert.deepEqual(saved[0].enrichment, {
    status: "NEEDS_ATTENTION",
    missingFields: [],
    attemptCount: 4,
    nextAttemptAt: "",
    lastErrorCode: "OZON_ENRICH_NOT_FOUND",
  });
});

test("manual retry is account scoped and preserves the linked job identity on replay", async () => {
  const stable = {
    id: "job-manual-stable",
    accountId: "account-a",
    collectItemId: "collect-manual-stable",
    requestId: "request-manual-stable",
    sku: "sku-manual-stable",
    status: "PENDING",
    nextAttemptAt: "2026-08-01T08:00:01.000Z",
    lastError: null,
    captureContext: {
      sellerCompanyId: "2681910",
      revision: 3,
      observedAt: "2026-08-01T08:00:00.000Z",
    },
  };
  const calls = [];
  const h = harness({
    start: Date.parse("2026-08-01T08:00:01.000Z"),
    collectItems: {
      async read() { throw new Error("unused"); },
      async save() { throw new Error("unused"); },
      async complete() { throw new Error("unused"); },
      async fail() { throw new Error("unused"); },
      async retry(input) {
        calls.push(clone(input));
        if (input.accountId !== "account-a") return null;
        return {
          item: { id: input.collectItemId, accountId: input.accountId, enrichment: { status: "RETRYING" } },
          job: clone(stable),
        };
      },
    },
  });

  const first = await h.service.retryCollectItem({
    accountId: "account-a",
    collectItemId: "collect-manual-stable",
  });
  const second = await h.service.retryCollectItem({
    accountId: "account-a",
    collectItemId: "collect-manual-stable",
  });
  assert.deepEqual(first, {
    collectItemId: "collect-manual-stable",
    enrichment: { status: "RETRYING" },
    job: {
      id: "job-manual-stable",
      requestId: "request-manual-stable",
      sku: "sku-manual-stable",
      status: "PENDING",
      attemptCount: 0,
      nextAttemptAt: "2026-08-01T08:00:01.000Z",
    },
  });
  assert.deepEqual(second, first);
  assert.equal(Object.hasOwn(first, "accountId"), false);
  assert.equal(Object.hasOwn(first.job, "captureContext"), false);
  assert.deepEqual(h.audits.map((event) => [event.action, event.status]), [
    ["collector.ozon.enrichment.manual_retry", "SUCCESS"],
    ["collector.ozon.enrichment.manual_retry", "SUCCESS"],
  ]);
  assert.equal(JSON.stringify(h.audits).includes("captureContext"), false);
  assert.deepEqual(calls.map((call) => call.accountId), ["account-a", "account-a"]);
  await assert.rejects(h.service.retryCollectItem({
    accountId: "account-b",
    collectItemId: "collect-manual-stable",
  }), (error) => error?.status === 404 && error?.code === "COLLECT_ITEM_NOT_FOUND");
});
