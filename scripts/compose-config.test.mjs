import assert from "node:assert/strict";
import childProcess, { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";

for (const source of ["server-data/sub2api-local/credential-master.key", "/tmp/synthetic-existing-key", ""]) {
  test(`compose binds the credential as a read-only file: ${source || "disabled"}`, () => {
    const result = spawnSync("docker", ["compose", "--env-file", "/dev/null", "--profile", "application", "config", "--format", "json"], {
      encoding: "utf8", timeout: 15_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME,
        POSTGRES_PASSWORD: "synthetic", POSTGRES_PORT: "5432", MINIO_ACCESS_KEY: "synthetic",
        MINIO_SECRET_KEY: "synthetic", MINIO_PORT: "9000", MINIO_CONSOLE_PORT: "9001",
        APP_ENCRYPTION_KEY: "synthetic", SONLI_ADMIN_PASSWORD: "synthetic-test-password", WEB_PORT: "3000",
        AUTO_LISTING_CREDENTIAL_MASTER_KEY_FILE: source },
    });
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(result.stdout);
    for (const name of ["api", "worker", "auto-listing-ai-worker"]) {
      const mount = config.services[name].volumes[0];
      assert.equal(mount.type, "bind");
      assert.equal(mount.source, path.resolve(source || "/dev/null"));
      assert.equal(mount.read_only, true);
      assert.equal(mount.bind.create_host_path, false, "missing keys must not be silently created as directories");
    }
  });
}

for (const [name, args, shouldReject] of [
  ["status", ["ps"], false],
  ["storage bootstrap", ["up", "-d", "postgres", "minio", "minio-init"], false],
  ["application startup", ["--profile", "application", "up", "-d"], true],
  ["explicit API startup", ["up", "api"], true],
]) {
  test(`a missing application key is checked only where needed: ${name}`, async (t) => {
    const originalArgv = process.argv;
    const originalEnv = { ...process.env };
    const originalExitCode = process.exitCode;
    const runs = [];
    process.env.AUTO_LISTING_CREDENTIAL_MASTER_KEY_FILE = "/nonexistent-synthetic-directory/master.key";
    process.env.QH_LOCAL_NO_DOTENV = "1";
    process.argv = [process.execPath, "scripts/compose.mjs", ...args];
    t.mock.method(childProcess, "spawnSync", (...input) => { runs.push(input); return { status: 0 }; });
    syncBuiltinESMExports();
    try {
      const load = import(`./compose.mjs?scope=${encodeURIComponent(name)}`);
      if (shouldReject) await assert.rejects(load, /凭据主密钥文件不存在或不可读/);
      else await load;
      assert.equal(runs.length, shouldReject ? 0 : 1);
    } finally {
      process.argv = originalArgv;
      process.env = originalEnv;
      process.exitCode = originalExitCode;
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
}
