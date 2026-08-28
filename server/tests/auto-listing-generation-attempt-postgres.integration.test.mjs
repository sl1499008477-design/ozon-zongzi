import assert from "node:assert/strict";
import test from "node:test";

const connectionString = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
const enabled = process.env.AUTO_LISTING_POSTGRES_TESTS === "1" && Boolean(connectionString);

if (!enabled) {
  test("generation repository PostgreSQL fixture requires explicit disposable-database opt-in", {
    skip: "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  }, () => {});
} else {
  test("generation attempts are idempotent, active-plan fenced, and ABA-safe in PostgreSQL", async () => {
    const { runGenerationAttemptPostgresFixture } = await import("./auto-listing-generation-attempt-postgres-fixture.mjs");
    assert.deepEqual(await runGenerationAttemptPostgresFixture({ connectionString }), {
      acceptedReplay: true,
      abaFenced: true,
      staleBeforeAttempt: true,
      channelReclaimed: true,
      storedImageReusable: true,
      memoryPostgresChannelParity: true,
      storedEvidenceCompensated: true,
    });
  });
}
