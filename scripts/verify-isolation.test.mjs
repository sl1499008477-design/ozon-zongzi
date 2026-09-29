import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { activeTestFiles } from "./test-manifest.mjs";

test("verify never passes inherited business connections or credentials to its checks", async (t) => {
  const sentinels = {
    DATABASE_URL: "postgresql://never-connect.invalid/business",
    TEST_DATABASE_URL: "postgresql://never-connect.invalid/business",
    POSTGRES_HOST: "never-connect.invalid",
    PGHOST: "never-connect.invalid",
    SONLI_MIGRATION_TEST_DATABASE_URL: "postgresql://never-connect.invalid/test",
    AUTO_LISTING_AI_ENABLED: "true",
    AUTO_LISTING_UPLOAD_ENABLED: "true",
    SUB2API_API_KEY: "synthetic-not-a-real-key",
    APP_ENCRYPTION_KEY: "synthetic-not-a-real-key",
    ACCOUNT_CHANNEL_API_KEY: "synthetic-custom-secret",
    QH_LOCAL_DATA_DIR: "/never-write-business-data",
  };
  const original = { ...process.env };
  Object.assign(process.env, sentinels);
  process.env.COMPOSE_FILE = "/nonexistent-other-project-compose.yml";
  const runs = [];
  const messages = [];
  t.mock.method(console, "log", (message) => messages.push(String(message)));
  t.mock.method(childProcess, "spawnSync", (command, args, options) => {
    runs.push({ command, args, options });
    return { status: 0 };
  });
  syncBuiltinESMExports();
  try {
    await import(`./verify.mjs?isolation=${Date.now()}`);
  } finally {
    process.env = original;
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.ok(runs.some(({ args }) => args.includes("--test")), "the actual test command must be checked");
  assert.match(messages.join("\n"), /未验证.*原版扩展/);
  for (const script of ["scripts/check-extension-source-parity.mjs", "scripts/check-extension-ui-parity.mjs"]) {
    const run = runs.find(({ args }) => args.includes(script));
    assert.ok(run?.args.includes("--local-only"), `daily verification must use the local baseline: ${script}`);
  }
  assert.equal(runs.some(({ args }) => args.includes("scripts/check-extension-diff-contract.mjs")), false);
  for (const script of ["scripts/check-extension-zip.mjs", "scripts/check-extension-zip-smoke.mjs", "scripts/check-plugin-readiness-gate.mjs", "scripts/check-store-data-isolation.mjs"]) {
    assert.ok(runs.some(({ args }) => args.includes(script)), `necessary gate must remain active: ${script}`);
  }
  for (const { options } of runs) {
    for (const [key, value] of Object.entries(sentinels)) assert.notEqual(options.env[key], value, key);
    assert.equal(options.env.QH_LOCAL_NO_DOTENV, "1");
    assert.equal(options.env.QH_LOCAL_NO_LISTEN, "1");
  }
  const compose = runs.find(({ command }) => command === "docker");
  const config = childProcess.spawnSync(compose.command, compose.args, {
    ...compose.options, stdio: "pipe", encoding: "utf8", timeout: 15_000,
  });
  assert.equal(config.status, 0, config.stderr || config.error?.message);
  assert.deepEqual(compose.args.slice(0, 3), ["compose", "--env-file", "/dev/null"],
    "configuration-only checks must not read real .env credentials");
  assert.equal(compose.options.env.APP_ENCRYPTION_KEY, "synthetic-config-only");
});

for (const [name, selection, expectedFiles, expectedStatus] of [
  ["default", [], activeTestFiles, 0],
  ["reporter only", ["--test-reporter=spec"], activeTestFiles, 0],
  ["explicit file", ["--test-reporter=spec", "scripts/dev.test.mjs"], ["scripts/dev.test.mjs"], 0],
  ["ambiguous option value", ["--test-reporter", "spec"], [], 1],
]) {
  test(`isolated test runner preserves the active manifest: ${name}`, async (t) => {
    const originalArgv = process.argv;
    const originalExitCode = process.exitCode;
    const runs = [];
    const messages = [];
    t.mock.method(console, "log", (message) => messages.push(String(message)));
    t.mock.method(console, "error", () => {});
    t.mock.method(childProcess, "spawnSync", (command, args, options) => {
      runs.push({ args, options });
      return { status: 0 };
    });
    syncBuiltinESMExports();
    process.argv = [process.execPath, "scripts/test.mjs", ...selection];
    try {
      await import(`./test.mjs?runner=${encodeURIComponent(name)}`);
      assert.match(messages.join("\n"), /未验证.*原版扩展/);
      assert.equal(process.exitCode, expectedStatus);
      assert.equal(runs.length, expectedStatus === 0 ? 1 : 0);
      if (runs.length) {
        assert.deepEqual(runs[0].args.filter((arg) => !arg.startsWith("-")), expectedFiles);
        assert.equal(runs[0].options.env.QH_LOCAL_NO_DOTENV, "1");
        assert.equal(runs[0].options.env.AUTO_LISTING_UPLOAD_ENABLED, "false");
      }
    } finally {
      process.argv = originalArgv;
      process.exitCode = originalExitCode;
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
}
