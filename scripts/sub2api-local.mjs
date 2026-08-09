import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SUB2API_IMAGE = "ghcr.io/wei-shaw/sub2api:0.1.132";

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

async function readTextIfPresent(filePath) {
  try {
    return { exists: true, content: await readFile(filePath, "utf8") };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, content: "" };
    throw error;
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
    try {
      await writeFile(backupPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      return backupPath;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("Unable to create an .env backup without replacing an existing file.");
}

async function atomicWritePrivateFile(filePath, content) {
  const temporaryPath = path.join(path.dirname(filePath), `.env.sub2api-local-${randomUUID()}.tmp`);
  let renamed = false;
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, filePath);
    renamed = true;
    await chmod(filePath, 0o600);
  } finally {
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
  try {
    await writeFile(filePath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    await chmod(filePath, 0o600);
    return false;
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
    logs: [["logs", "-f", "sub2api"]],
    upgrade: [["pull"], ["up", "-d", "--pull", "never"]],
  };
  const actions = lifecycleActions[command];
  if (!actions) throw new Error(`Unsupported local sub2api command: ${command}`);
  return actions.map((action) => composeInvocation(action, rootDir));
}

export async function bootstrapLocalSub2Api({ rootDir }) {
  const applicationEnvPath = path.join(rootDir, ".env");
  const existingApplicationEnv = await readTextIfPresent(applicationEnvPath);
  const applicationUpdate = applicationEnvUpdate(existingApplicationEnv.content);
  const dataDirectory = localDataDirectory(rootDir);
  const stackEnvPath = path.join(rootDir, STACK_ENV_RELATIVE_PATH);
  const masterKeyPath = path.join(rootDir, MASTER_KEY_RELATIVE_PATH);

  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await chmod(dataDirectory, 0o700);
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
    await chmod(applicationEnvPath, 0o600);
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
  const invocations = commandInvocations(command, rootDir);
  for (const invocation of invocations) {
    const result = spawn("docker", invocation, { cwd: rootDir, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const error = new Error("Local sub2API Docker command failed.");
      error.code = "SUB2API_LOCAL_DOCKER_FAILED";
      error.exitCode = result.status ?? 1;
      throw error;
    }
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
