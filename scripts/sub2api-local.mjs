import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SUB2API_IMAGE = "ghcr.io/wei-shaw/sub2api:0.1.173";

const PROJECT_NAME = "sonli-sub2api-local";
const DASHBOARD_URL = "http://127.0.0.1:8080/";
const STACK_ENV_RELATIVE_PATH = "server-data/sub2api-local/.env";
const MASTER_KEY_RELATIVE_PATH = "server-data/sub2api-local/credential-master.key";
const APPLICATION_ENV_SETTINGS = Object.freeze({
  AUTO_LISTING_ENABLED: "true",
  AUTO_LISTING_AI_ENABLED: "true",
  AUTO_LISTING_AI_ALLOW_LOCAL_GATEWAY: "true",
  AUTO_LISTING_AI_ALLOWED_GATEWAY_BASE_URLS: "http://127.0.0.1:8080/v1",
  AUTO_LISTING_AI_ALLOWED_GATEWAY_ORIGINS: "http://127.0.0.1:8080",
  AUTO_LISTING_CREDENTIAL_MASTER_KEY_FILE: MASTER_KEY_RELATIVE_PATH,
  AUTO_LISTING_CREDENTIAL_KEY_VERSION: "local-v1",
});

function localDataDirectory(rootDir) {
  return path.join(rootDir, "server-data/sub2api-local");
}

function envLineValues(source, key) {
  const matcher = new RegExp(`^(?:export\\s+)?${key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}=(.*)$`, "gmu");
  return Array.from(source.matchAll(matcher), (match) => match[1]);
}

function envLineValue(source, key) {
  return envLineValues(source, key).at(-1);
}

function unsafeFileError(filePath) {
  const error = new Error(`Refusing unsafe local secret or env path: ${filePath}`);
  error.code = "SUB2API_LOCAL_UNSAFE_FILE";
  error.path = filePath;
  return error;
}

function unsafeDirectoryError(directoryPath) {
  const error = new Error(`Refusing unsafe local secret directory: ${directoryPath}`);
  error.code = "SUB2API_LOCAL_UNSAFE_DIRECTORY";
  error.path = directoryPath;
  return error;
}

async function ensureDirectoryNoFollow(directoryPath, { privateMode = false } = {}) {
  try {
    await mkdir(directoryPath, { mode: privateMode ? 0o700 : 0o755 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  let status;
  try {
    status = await lstat(directoryPath);
  } catch (error) {
    if (["ELOOP", "EMLINK"].includes(error?.code)) throw unsafeDirectoryError(directoryPath);
    throw error;
  }
  if (status.isSymbolicLink() || !status.isDirectory()) throw unsafeDirectoryError(directoryPath);

  let handle;
  try {
    handle = await open(directoryPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const openedStatus = await handle.stat();
    if (!openedStatus.isDirectory()) throw unsafeDirectoryError(directoryPath);
    if (privateMode) await handle.chmod(0o700);
  } catch (error) {
    if (["ELOOP", "EMLINK"].includes(error?.code)) throw unsafeDirectoryError(directoryPath);
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function regularFileStatus(filePath) {
  try {
    const status = await lstat(filePath);
    if (status.isSymbolicLink() || !status.isFile()) throw unsafeFileError(filePath);
    return status;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function openRegularFileNoFollow(filePath, flags = constants.O_RDONLY) {
  await regularFileStatus(filePath);
  let handle;
  try {
    handle = await open(filePath, flags | constants.O_NOFOLLOW);
    const status = await handle.stat();
    if (!status.isFile()) throw unsafeFileError(filePath);
    return handle;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (["ELOOP", "EMLINK"].includes(error?.code)) throw unsafeFileError(filePath);
    throw error;
  }
}

async function readTextIfPresent(filePath) {
  const status = await regularFileStatus(filePath);
  if (!status) return { exists: false, content: "" };
  const handle = await openRegularFileNoFollow(filePath);
  try {
    return { exists: true, content: await handle.readFile("utf8") };
  } finally {
    await handle.close();
  }
}

async function chmodPrivateRegularFile(filePath) {
  const handle = await openRegularFileNoFollow(filePath);
  try {
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

function applicationEnvUpdate(current) {
  const additions = [];
  for (const [key, expected] of Object.entries(APPLICATION_ENV_SETTINGS)) {
    const actualValues = envLineValues(current, key);
    if (actualValues.length === 0) {
      additions.push(`${key}=${expected}`);
    } else if (actualValues.some((actual) => actual !== expected)) {
      const error = new Error(`Refusing to replace conflicting local setting ${key} in .env.`);
      error.code = "SUB2API_LOCAL_ENV_CONFLICT";
      throw error;
    }
  }
  if (additions.length === 0) return { changed: false, content: current };
  const newline = current.includes("\r\n") ? "\r\n" : "\n";
  const prefix = current.length === 0 || current.endsWith("\n") ? current : `${current}${newline}`;
  return { changed: true, content: `${prefix}${additions.join(newline)}${newline}` };
}

function stackEnvironmentUpdate(current) {
  const values = envLineValues(current, "SUB2API_TOTP_ENCRYPTION_KEY");
  if (values.length !== 1 || /^[0-9a-f]{64}$/u.test(values[0])) {
    return { changed: false, content: current };
  }
  if (!/^[A-Za-z0-9_-]{43}$/u.test(values[0])) {
    return { changed: false, content: current };
  }
  const decoded = Buffer.from(values[0], "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== values[0]) {
    return { changed: false, content: current };
  }
  return {
    changed: true,
    content: current.replace(
      /^(?:export\s+)?SUB2API_TOTP_ENCRYPTION_KEY=.*$/mu,
      `SUB2API_TOTP_ENCRYPTION_KEY=${decoded.toString("hex")}`,
    ),
  };
}

async function createTimestampedBackup(filePath, content) {
  const directory = path.dirname(filePath);
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const backupPath = path.join(directory, `.env.sub2api-local-${timestamp}-${randomUUID()}.bak`);
    let handle;
    try {
      handle = await open(
        backupPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(content, "utf8");
      await handle.chmod(0o600);
      return backupPath;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    } finally {
      await handle?.close();
    }
  }
  throw new Error("Unable to create an .env backup without replacing an existing file.");
}

async function atomicWritePrivateFile(filePath, content) {
  const temporaryPath = path.join(path.dirname(filePath), `.env.sub2api-local-${randomUUID()}.tmp`);
  let handle;
  let renamed = false;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(content, "utf8");
    await handle.chmod(0o600);
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
    renamed = true;
  } finally {
    await handle?.close().catch(() => {});
    if (!renamed) await unlink(temporaryPath).catch(() => {});
  }
}

function secret() {
  return randomBytes(32).toString("base64url");
}

function hexSecret() {
  return randomBytes(32).toString("hex");
}

function newStackEnvironment() {
  return [
    "SUB2API_PORT=8080",
    "SUB2API_POSTGRES_USER=sub2api",
    "SUB2API_POSTGRES_DB=sub2api",
    "SUB2API_ADMIN_EMAIL=admin@sub2api.local",
    `SUB2API_POSTGRES_PASSWORD=${secret()}`,
    `SUB2API_REDIS_PASSWORD=${secret()}`,
    `SUB2API_ADMIN_PASSWORD=${secret()}`,
    `SUB2API_JWT_SECRET=${secret()}`,
    `SUB2API_TOTP_ENCRYPTION_KEY=${hexSecret()}`,
    "",
  ].join("\n");
}

async function createPrivateFileIfMissing(filePath, contents) {
  let handle;
  try {
    handle = await open(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(contents, "utf8");
    await handle.chmod(0o600);
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existingHandle = await openRegularFileNoFollow(filePath);
    try {
      await existingHandle.chmod(0o600);
    } finally {
      await existingHandle.close();
    }
    return false;
  } finally {
    await handle?.close();
  }
}

export function composeInvocation(action, rootDir) {
  const file = path.join(rootDir, "deploy/sub2api-local/docker-compose.yml");
  const envFile = path.join(rootDir, STACK_ENV_RELATIVE_PATH);
  return ["compose", "--project-name", PROJECT_NAME, "--env-file", envFile, "-f", file, ...action];
}

export function commandInvocations(command, rootDir) {
  const lifecycleActions = {
    up: [["up", "-d", "--pull", "never"]],
    down: [["down"]],
    status: [["ps"]],
    logs: [["ps", "--format", "json"]],
    "raw-logs": [["logs", "-f", "sub2api"]],
    upgrade: [["pull"], ["up", "-d", "--pull", "never"]],
  };
  const actions = lifecycleActions[command];
  if (!actions) throw new Error(`Unsupported local sub2api command: ${command}`);
  return actions.map((action) => composeInvocation(action, rootDir));
}

const SAFE_SERVICE_NAMES = new Set(["sub2api", "postgres", "redis"]);
const SAFE_SERVICE_STATES = new Set(["created", "running", "restarting", "exited", "paused", "dead", "removing"]);
const SAFE_SERVICE_HEALTH = new Set(["healthy", "unhealthy", "starting", "none"]);

function composeRows(stdout) {
  const source = String(stdout || "").trim();
  if (!source) return [];
  try {
    const value = JSON.parse(source);
    return Array.isArray(value) ? value : [value];
  } catch {
    return source.split(/\r?\n/gu).flatMap((line) => {
      try {
        const value = JSON.parse(line);
        return Array.isArray(value) ? value : [value];
      } catch {
        return [];
      }
    });
  }
}

function writeSafeDiagnosticSummary(stdout, write) {
  const rows = composeRows(stdout).filter((row) => SAFE_SERVICE_NAMES.has(row?.Service));
  write("Local sub2API safe diagnostic summary (vendor log text is not included):\n");
  if (rows.length === 0) {
    write("No recognized local sub2API services were reported. Run sub2api:status for container state.\n");
  } else {
    for (const row of rows) {
      const state = SAFE_SERVICE_STATES.has(row.State) ? row.State : "unknown";
      const health = SAFE_SERVICE_HEALTH.has(row.Health) ? row.Health : "unknown";
      write(`${row.Service}: state=${state}, health=${health}\n`);
    }
  }
  write("Raw vendor logs require the explicit high-risk command: pnpm sub2api:logs:raw\n");
}

export async function bootstrapLocalSub2Api({ rootDir }) {
  const applicationEnvPath = path.join(rootDir, ".env");
  const existingApplicationEnv = await readTextIfPresent(applicationEnvPath);
  const applicationUpdate = applicationEnvUpdate(existingApplicationEnv.content);
  const serverDataDirectory = path.join(rootDir, "server-data");
  const dataDirectory = localDataDirectory(rootDir);
  const stackEnvPath = path.join(rootDir, STACK_ENV_RELATIVE_PATH);
  const masterKeyPath = path.join(rootDir, MASTER_KEY_RELATIVE_PATH);

  await ensureDirectoryNoFollow(serverDataDirectory);
  await ensureDirectoryNoFollow(dataDirectory, { privateMode: true });
  const stackEnvCreated = await createPrivateFileIfMissing(stackEnvPath, newStackEnvironment());
  await createPrivateFileIfMissing(masterKeyPath, `${secret()}\n`);

  let stackEnvBackupPath;
  if (!stackEnvCreated) {
    const existingStackEnv = await readTextIfPresent(stackEnvPath);
    const stackUpdate = stackEnvironmentUpdate(existingStackEnv.content);
    if (stackUpdate.changed) {
      stackEnvBackupPath = await createTimestampedBackup(stackEnvPath, existingStackEnv.content);
      await atomicWritePrivateFile(stackEnvPath, stackUpdate.content);
    }
  }

  let applicationEnvBackupPath;
  if (applicationUpdate.changed) {
    if (existingApplicationEnv.exists) {
      applicationEnvBackupPath = await createTimestampedBackup(applicationEnvPath, existingApplicationEnv.content);
    }
    await atomicWritePrivateFile(applicationEnvPath, applicationUpdate.content);
  } else if (existingApplicationEnv.exists) {
    await chmodPrivateRegularFile(applicationEnvPath);
  }

  return {
    dashboardUrl: DASHBOARD_URL,
    stackEnvPath,
    stackEnvBackupPath,
    masterKeyPath,
    applicationEnvBackupPath,
  };
}

export async function localCredentials(rootDir) {
  const { content } = await readTextIfPresent(path.join(rootDir, STACK_ENV_RELATIVE_PATH));
  const email = envLineValue(content, "SUB2API_ADMIN_EMAIL");
  const password = envLineValue(content, "SUB2API_ADMIN_PASSWORD");
  if (!email || !password) throw new Error("Local sub2API credentials are unavailable; run pnpm sub2api:bootstrap first.");
  return { email, password };
}

export async function runSub2ApiLocalCommand(command, {
  rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  write = (message) => process.stdout.write(message),
  spawn = spawnSync,
} = {}) {
  if (command === "bootstrap") {
    const result = await bootstrapLocalSub2Api({ rootDir });
    write(`Local sub2API data: ${path.dirname(result.stackEnvPath)}\n`);
    if (result.applicationEnvBackupPath) write(`Application .env backup: ${result.applicationEnvBackupPath}\n`);
    if (result.stackEnvBackupPath) write(`Local sub2API env backup: ${result.stackEnvBackupPath}\n`);
    write(`Dashboard: ${result.dashboardUrl}\n`);
    return result;
  }
  if (command === "credentials") {
    const credentials = await localCredentials(rootDir);
    write(`Local sub2API admin email: ${credentials.email}\n`);
    write(`Local sub2API admin password: ${credentials.password}\n`);
    return credentials;
  }
  if (command === "raw-logs") {
    write("高风险：以下为第三方原始日志，可能包含密钥、提示词或上游响应；不要截屏、复制或重定向到文件。\n");
  }
  const invocations = commandInvocations(command, rootDir);
  for (const invocation of invocations) {
    const result = command === "logs"
      ? spawn("docker", invocation, { cwd: rootDir, encoding: "utf8", maxBuffer: 1024 * 1024 })
      : spawn("docker", invocation, { cwd: rootDir, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const error = new Error("Local sub2API Docker command failed.");
      error.code = "SUB2API_LOCAL_DOCKER_FAILED";
      error.exitCode = result.status ?? 1;
      throw error;
    }
    if (command === "logs") writeSafeDiagnosticSummary(result.stdout, write);
  }
  return invocations;
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  runSub2ApiLocalCommand(process.argv[2]).catch((error) => {
    process.exitCode = Number.isInteger(error.exitCode) ? error.exitCode : 1;
    process.stderr.write(`${error.message}\n`);
  });
}
