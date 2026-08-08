import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SUB2API_IMAGE,
  bootstrapLocalSub2Api,
  commandInvocations,
  composeInvocation,
  runSub2ApiLocalCommand,
} from "../../scripts/sub2api-local.mjs";

test("local sub2api compose is pinned, isolated, loopback-only, and persistent", async () => {
  const compose = await readFile(new URL("../../deploy/sub2api-local/docker-compose.yml", import.meta.url), "utf8");
  assert.match(compose, /ghcr\.io\/wei-shaw\/sub2api:0\.1\.132/);
  assert.doesNotMatch(compose, /:latest\b/);
  assert.match(compose, /127\.0\.0\.1:\$\{SUB2API_PORT:-8080\}:8080/);
  assert.match(compose, /sonli_sub2api_postgres_data/);
  assert.match(compose, /sonli_sub2api_redis_data/);
  assert.doesNotMatch(compose, /sonli_postgres_data|sonli_queue|MINIO_/);
  assert.doesNotMatch(compose, /docker\.sock/);
});

test("bootstrap creates private local secrets, preserves unrelated application settings, and records a backup", async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "sonli-sub2api-local-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await writeFile(path.join(rootDir, ".env"), "# keep this comment\nUNRELATED=value\n");

  const result = await bootstrapLocalSub2Api({ rootDir });
  const appEnv = await readFile(path.join(rootDir, ".env"), "utf8");
  const stackEnv = await readFile(path.join(rootDir, "server-data/sub2api-local/.env"), "utf8");
  const appEnvMode = (await stat(path.join(rootDir, ".env"))).mode & 0o777;
  const stackEnvMode = (await stat(path.join(rootDir, "server-data/sub2api-local/.env"))).mode & 0o777;
  const masterKeyMode = (await stat(path.join(rootDir, "server-data/sub2api-local/credential-master.key"))).mode & 0o777;

  assert.match(appEnv, /^# keep this comment$/m);
  assert.match(appEnv, /^UNRELATED=value$/m);
  assert.match(appEnv, /^AUTO_LISTING_ENABLED=true$/m);
  assert.match(appEnv, /^AUTO_LISTING_AI_ENABLED=true$/m);
  assert.match(appEnv, /^AUTO_LISTING_AI_ALLOW_LOCAL_GATEWAY=true$/m);
  assert.match(appEnv, /^AUTO_LISTING_AI_ALLOWED_GATEWAY_BASE_URLS=http:\/\/127\.0\.0\.1:8080\/v1$/m);
  assert.match(appEnv, /^AUTO_LISTING_AI_ALLOWED_GATEWAY_ORIGINS=http:\/\/127\.0\.0\.1:8080$/m);
  assert.match(appEnv, /^AUTO_LISTING_CREDENTIAL_MASTER_KEY_FILE=server-data\/sub2api-local\/credential-master\.key$/m);
  assert.match(appEnv, /^AUTO_LISTING_CREDENTIAL_KEY_VERSION=local-v1$/m);
  assert.match(stackEnv, /^SUB2API_ADMIN_EMAIL=admin@sub2api\.local$/m);
  assert.match(stackEnv, /^SUB2API_ADMIN_PASSWORD=.+$/m);
  assert.equal(appEnvMode, 0o600);
  assert.equal(stackEnvMode, 0o600);
  assert.equal(masterKeyMode, 0o600);
  assert.match(result.dashboardUrl, /^http:\/\/127\.0\.0\.1:8080\/$/);
  assert.match(result.applicationEnvBackupPath, /\.env\.sub2api-local-.*\.bak$/);
  assert.equal((await stat(result.applicationEnvBackupPath)).mode & 0o777, 0o600);
});

test("bootstrap refuses conflicting owned application settings without replacing them", async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "sonli-sub2api-local-conflict-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const appEnvPath = path.join(rootDir, ".env");
  await writeFile(appEnvPath, "AUTO_LISTING_ENABLED=false\n");

  await assert.rejects(
    bootstrapLocalSub2Api({ rootDir }),
    (error) => error?.code === "SUB2API_LOCAL_ENV_CONFLICT" && /AUTO_LISTING_ENABLED/u.test(error.message),
  );
  assert.equal(await readFile(appEnvPath, "utf8"), "AUTO_LISTING_ENABLED=false\n");
});

test("bootstrap rejects a conflicting duplicate owned application setting", async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "sonli-sub2api-local-duplicate-conflict-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const appEnvPath = path.join(rootDir, ".env");
  const original = "AUTO_LISTING_ENABLED=true\nAUTO_LISTING_ENABLED=false\n";
  await writeFile(appEnvPath, original);

  await assert.rejects(
    bootstrapLocalSub2Api({ rootDir }),
    (error) => error?.code === "SUB2API_LOCAL_ENV_CONFLICT" && /AUTO_LISTING_ENABLED/u.test(error.message),
  );
  assert.equal(await readFile(appEnvPath, "utf8"), original);
});

test("bootstrap preserves existing local stack secrets instead of regenerating them", async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "sonli-sub2api-local-existing-secrets-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const dataDirectory = path.join(rootDir, "server-data/sub2api-local");
  const stackEnvPath = path.join(dataDirectory, ".env");
  const masterKeyPath = path.join(dataDirectory, "credential-master.key");
  const stackEnv = "SUB2API_ADMIN_EMAIL=admin@sub2api.local\nSUB2API_ADMIN_PASSWORD=existing-password\n";
  const masterKey = "existing-master-key\n";
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(stackEnvPath, stackEnv, { mode: 0o600 });
  await writeFile(masterKeyPath, masterKey, { mode: 0o600 });

  await bootstrapLocalSub2Api({ rootDir });

  assert.equal(await readFile(stackEnvPath, "utf8"), stackEnv);
  assert.equal(await readFile(masterKeyPath, "utf8"), masterKey);
});

test("normal lifecycle commands do not pull, while upgrade alone pulls the pinned sub2api service", () => {
  const rootDir = "/workspace/sonli";
  assert.deepEqual(composeInvocation(["up", "-d", "--pull", "never"], rootDir), [
    "compose",
    "--project-name",
    "sonli-sub2api-local",
    "--env-file",
    "/workspace/sonli/server-data/sub2api-local/.env",
    "-f",
    "/workspace/sonli/deploy/sub2api-local/docker-compose.yml",
    "up",
    "-d",
    "--pull",
    "never",
  ]);
  assert.deepEqual(commandInvocations("up", rootDir), [composeInvocation(["up", "-d", "--pull", "never"], rootDir)]);
  for (const command of ["up", "down", "status", "logs"]) {
    assert.doesNotMatch(JSON.stringify(commandInvocations(command, rootDir)), /"pull"/u);
  }
  assert.deepEqual(commandInvocations("upgrade", rootDir), [[
    "compose", "--project-name", "sonli-sub2api-local", "--env-file",
    "/workspace/sonli/server-data/sub2api-local/.env", "-f",
    "/workspace/sonli/deploy/sub2api-local/docker-compose.yml", "pull", "sub2api",
  ], [
    "compose", "--project-name", "sonli-sub2api-local", "--env-file",
    "/workspace/sonli/server-data/sub2api-local/.env", "-f",
    "/workspace/sonli/deploy/sub2api-local/docker-compose.yml", "up", "-d", "--pull", "never",
  ]]);
  assert.equal(SUB2API_IMAGE, "ghcr.io/wei-shaw/sub2api:0.1.132");
});

test("upgrade stops after a failed pull instead of starting an unverified image", async () => {
  const spawnedActions = [];
  await assert.rejects(
    runSub2ApiLocalCommand("upgrade", {
      rootDir: "/workspace/sonli",
      spawn: (_command, arguments_) => {
        spawnedActions.push(arguments_);
        return { status: 17 };
      },
    }),
    (error) => error?.code === "SUB2API_LOCAL_DOCKER_FAILED" && error?.exitCode === 17,
  );
  assert.deepEqual(spawnedActions.map((arguments_) => arguments_.at(-2)), ["pull"]);
});
