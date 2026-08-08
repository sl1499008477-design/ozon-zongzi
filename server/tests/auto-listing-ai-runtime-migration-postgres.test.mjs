import assert from "node:assert/strict";
import test from "node:test";

const dedicatedDatabaseUrl = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
const enabled = process.env.AUTO_LISTING_POSTGRES_TESTS === "1" && Boolean(dedicatedDatabaseUrl);

if (!enabled) {
  test("AI runtime PostgreSQL checks require both explicit opt-in and a dedicated database URL", {
    skip: "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  }, () => {});
} else {
  test("migration 032 and the PostgreSQL outbox run only in the dedicated disposable database", async () => {
    const { runAutoListingAiRuntimePostgresFixture } = await import("./auto-listing-ai-runtime-postgres-fixture.mjs");
    const result = await runAutoListingAiRuntimePostgresFixture({ connectionString: dedicatedDatabaseUrl });
    assert.deepEqual(result, {
      migrationAppliedTwice: true,
      legacyOutboxPreserved: true,
      sqlNullRejected: true,
      utf8BoundaryRejected: true,
      unsafeIdentifierRejected: true,
      accountBoundaryRejected: true,
      oneLeaseOnly: true,
      expiredLeaseReclaimed: true,
      staleLeaseRejected: true,
      wrongItemRejected: true,
      deterministicReplay: true,
      terminalImmutable: true,
      runtimeTablesScoped: true,
      terminalAttemptsImmutable: true,
      derivedPlanActivated: true,
      cleanupRelationScoped: true,
      sourceRepositoryAcceptedReplay: true,
      sourceRepositoryStaleBeforeAttempt: true,
      sourceRepositoryAbaFence: true,
      sourceRepositoryOrphanCleanup: true,
      historicalJobProfilesPreserved: true,
      jobProfilePairConstraint: true,
      jobProfileAccountBoundary: true,
      jobProfileImmutable: true,
      jobReferencedProfileImmutable: true,
      jobReferencedProfileOperationalMutable: true,
    });
  });
}
