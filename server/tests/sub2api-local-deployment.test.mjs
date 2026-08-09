import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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
  assert.match(compose, /ghcr\.io\/wei-shaw\/sub2api:0\.1\.173/);
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
  assert.match(stackEnv, /^SUB2API_TOTP_ENCRYPTION_KEY=[0-9a-f]{64}$/m);
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

test("bootstrap migrates the legacy TOTP representation without rotating stack credentials", async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "sonli-sub2api-local-legacy-totp-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const dataDirectory = path.join(rootDir, "server-data/sub2api-local");
  const stackEnvPath = path.join(dataDirectory, ".env");
  const legacyKey = Buffer.alloc(32, 0xab).toString("base64url");
  const stackEnv = [
    "SUB2API_POSTGRES_PASSWORD=keep-postgres",
    "SUB2API_REDIS_PASSWORD=keep-redis",
    "SUB2API_ADMIN_PASSWORD=keep-admin",
    "SUB2API_JWT_SECRET=keep-jwt",
    `SUB2API_TOTP_ENCRYPTION_KEY=${legacyKey}`,
    "",
  ].join("\n");
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(stackEnvPath, stackEnv, { mode: 0o600 });

  const migrated = await bootstrapLocalSub2Api({ rootDir });
  const updated = await readFile(stackEnvPath, "utf8");
  assert.match(updated, /^SUB2API_POSTGRES_PASSWORD=keep-postgres$/m);
  assert.match(updated, /^SUB2API_REDIS_PASSWORD=keep-redis$/m);
  assert.match(updated, /^SUB2API_ADMIN_PASSWORD=keep-admin$/m);
  assert.match(updated, /^SUB2API_JWT_SECRET=keep-jwt$/m);
  assert.match(updated, new RegExp(`^SUB2API_TOTP_ENCRYPTION_KEY=${"ab".repeat(32)}$`, "m"));
  assert.equal(await readFile(migrated.stackEnvBackupPath, "utf8"), stackEnv);
  assert.equal((await stat(migrated.stackEnvBackupPath)).mode & 0o777, 0o600);

  const repeated = await bootstrapLocalSub2Api({ rootDir });
  assert.equal(repeated.stackEnvBackupPath, undefined);
  assert.equal(await readFile(stackEnvPath, "utf8"), updated);
});

test("bootstrap rejects symlinked secret and env targets without reading, replacing, or chmodding their victims", async (t) => {
  for (const relativePath of [
    ".env",
    "server-data/sub2api-local/.env",
    "server-data/sub2api-local/credential-master.key",
  ]) {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "sonli-sub2api-local-symlink-"));
    t.after(() => rm(rootDir, { recursive: true, force: true }));
    const victimPath = path.join(rootDir, "victim");
    const targetPath = path.join(rootDir, relativePath);
    await writeFile(victimPath, "victim-must-not-change\n", { mode: 0o640 });
    await mkdir(path.dirname(targetPath), { recursive: true });
    await symlink(victimPath, targetPath);

    await assert.rejects(
      bootstrapLocalSub2Api({ rootDir }),
      (error) => error?.code === "SUB2API_LOCAL_UNSAFE_FILE" && error?.path === targetPath,
      relativePath,
    );
    assert.equal(await readFile(victimPath, "utf8"), "victim-must-not-change\n", relativePath);
    assert.equal((await stat(victimPath)).mode & 0o777, 0o640, relativePath);
  }
});

test("bootstrap rejects non-regular secret and env targets", async (t) => {
  for (const relativePath of [
    ".env",
    "server-data/sub2api-local/.env",
    "server-data/sub2api-local/credential-master.key",
  ]) {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "sonli-sub2api-local-nonregular-"));
    t.after(() => rm(rootDir, { recursive: true, force: true }));
    const targetPath = path.join(rootDir, relativePath);
    await mkdir(targetPath, { recursive: true });

    await assert.rejects(
      bootstrapLocalSub2Api({ rootDir }),
      (error) => error?.code === "SUB2API_LOCAL_UNSAFE_FILE" && error?.path === targetPath,
      relativePath,
    );
  }
});

test("bootstrap rejects symlinked local secret directories instead of creating files through them", async (t) => {
  for (const relativeDirectory of ["server-data", "server-data/sub2api-local"]) {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "sonli-sub2api-local-directory-symlink-"));
    t.after(() => rm(rootDir, { recursive: true, force: true }));
    const victimDirectory = path.join(rootDir, "victim-directory");
    const targetDirectory = path.join(rootDir, relativeDirectory);
    await mkdir(victimDirectory);
    await mkdir(path.dirname(targetDirectory), { recursive: true });
    await symlink(victimDirectory, targetDirectory);

    await assert.rejects(
      bootstrapLocalSub2Api({ rootDir }),
      (error) => error?.code === "SUB2API_LOCAL_UNSAFE_DIRECTORY" && error?.path === targetDirectory,
      relativeDirectory,
    );
    await assert.rejects(readFile(path.join(victimDirectory, ".env")), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(victimDirectory, "credential-master.key")), { code: "ENOENT" });
  }
});

test("normal lifecycle commands do not pull, while upgrade alone pulls the pinned stack", () => {
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
    "/workspace/sonli/deploy/sub2api-local/docker-compose.yml", "pull",
  ], [
    "compose", "--project-name", "sonli-sub2api-local", "--env-file",
    "/workspace/sonli/server-data/sub2api-local/.env", "-f",
    "/workspace/sonli/deploy/sub2api-local/docker-compose.yml", "up", "-d", "--pull", "never",
  ]]);
  assert.equal(SUB2API_IMAGE, "ghcr.io/wei-shaw/sub2api:0.1.173");
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
  assert.deepEqual(spawnedActions.map((arguments_) => arguments_.at(-1)), ["pull"]);
});

test("ordinary logs command emits only a whitelisted service summary and never relays vendor log text", async () => {
  const writes = [];
  const calls = [];
  await runSub2ApiLocalCommand("logs", {
    rootDir: "/workspace/sonli",
    write: (message) => writes.push(message),
    spawn: (_command, arguments_, options) => {
      calls.push({ arguments_, options });
      return {
        status: 0,
        stdout: [
          JSON.stringify({ Service: "sub2api", State: "running", Health: "healthy", Labels: "Bearer vendor-secret" }),
          JSON.stringify({ Service: "postgres", State: "running", Health: "healthy", Error: "raw upstream response" }),
        ].join("\n"),
        stderr: "Authorization: vendor-secret",
      };
    },
  });

  const output = writes.join("");
  assert.deepEqual(calls[0].arguments_.slice(-3), ["ps", "--format", "json"]);
  assert.equal(calls[0].options.stdio, undefined);
  assert.match(output, /sub2api: state=running, health=healthy/u);
  assert.match(output, /postgres: state=running, health=healthy/u);
  assert.doesNotMatch(output, /vendor-secret|Authorization|Bearer|raw upstream response/u);
});

test("raw vendor logs require the explicit high-risk command and print a warning before terminal passthrough", async () => {
  const events = [];
  await runSub2ApiLocalCommand("raw-logs", {
    rootDir: "/workspace/sonli",
    write: (message) => events.push({ type: "write", message }),
    spawn: (_command, arguments_, options) => {
      events.push({ type: "spawn", arguments_, options });
      return { status: 0 };
    },
  });

  assert.equal(events[0].type, "write");
  assert.match(events[0].message, /高风险|原始|不要.*重定向/u);
  assert.deepEqual(events[1].arguments_.slice(-3), ["logs", "-f", "sub2api"]);
  assert.equal(events[1].options.stdio, "inherit");
});
