import assert from "node:assert/strict";
import test from "node:test";

const dedicatedDatabaseUrl = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
const enabled = process.env.AUTO_LISTING_POSTGRES_TESTS === "1" && Boolean(dedicatedDatabaseUrl);

if (!enabled) {
  test("rich-content PostgreSQL migration requires explicit opt-in and a dedicated database URL", {
    skip: "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  }, () => {});
} else {
  test("migration 031 PostgreSQL behavior is exercised only against the dedicated disposable database", async () => {
    const module = await import("./auto-listing-rich-content-postgres-fixture.mjs");
    const result = await module.runRichContentPostgresFixture({ connectionString: dedicatedDatabaseUrl });
    assert.deepEqual(result, {
      migrationAppliedTwice: true,
      legacyTerminalPreserved: true,
      nullAcceptedRejected: true,
      fullScopeLeaseCas: true,
      expiredLeaseReclaimed: true,
      acceptedReplayUnique: true,
    });
  });
}
