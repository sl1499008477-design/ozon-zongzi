import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startDevelopmentServices } from "./dev.mjs";

class FakeChild extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
  }

  kill(signal) {
    this.killed = true;
    this.signal = signal;
  }
}

for (const [envFile, expectedFile] of [["/existing/shared.env", "/existing/shared.env"], ["./shared.env", "/unrelated/directory/shared.env"]]) {
test(`every child uses the supervisor workspace and the caller's explicit config (${envFile})`, () => {
  const launches = [];
  const env = { AUTO_LISTING_ENABLED: "false", AUTO_LISTING_AI_ENABLED: "false", LISTING_PIPELINE_V3: "0", SONLI_ENV_FILE: envFile };
  const processRef = Object.assign(new EventEmitter(), { env, cwd: () => "/unrelated/directory", stdout: { write() {} }, stderr: { write() {} } });
  const supervisor = startDevelopmentServices({
    processRef, logger: { log() {}, error() {} },
    spawnProcess(command, args, options) {
      launches.push({ command, args, options });
      return new FakeChild(args.join(" "));
    },
  });
  try {
    assert.ok(launches.length > 0);
    for (const { options } of launches) {
      assert.equal(options.cwd, fileURLToPath(new URL("../", import.meta.url)));
      assert.equal(options.env.SONLI_ENV_FILE, expectedFile);
    }
    assert.equal(env.SONLI_ENV_FILE, envFile, "the caller environment must not be mutated");
    const frontend = launches.at(-1);
    assert.equal(frontend.command, "node");
    assert.deepEqual(frontend.args, [
      "app/node_modules/vite/bin/vite.js", "app", "--host", "127.0.0.1", "--port", "5173", "--strictPort",
    ], "starting existing services must not invoke a package manager's automatic dependency reinstall");
  } finally { supervisor.shutdown(); }
});
}

function fixture(env = { AUTO_LISTING_ENABLED: "true", AUTO_LISTING_AI_ENABLED: "true", LISTING_PIPELINE_V3: "1" }) {
  const spawned = [];
  const processRef = Object.assign(new EventEmitter(), { env, stdout: { write() {} }, stderr: { write() {} } });
  const supervisor = startDevelopmentServices({ processRef, logger: { log() {}, error() {} },
    spawnProcess(_command, args) {
      const child = new FakeChild(args.join(" "));
      spawned.push(child);
      return child;
    },
  });
  return { spawned, processRef, supervisor };
}

test("spawn failure stops the partial application with a failing exit status", () => {
  const { spawned, processRef, supervisor } = fixture();
  spawned.at(-1).emit("error", Object.assign(new Error("missing"), { code: "ENOENT" }));
  assert.equal(supervisor.isClosing(), true);
  assert.equal(processRef.exitCode, 1);
  assert.ok(spawned.every((child) => child.killed));
});

for (const [code, signal] of [[0, null], [null, "SIGKILL"]]) {
  test(`unexpected API exit ${signal ?? code} cannot leave a partial application running`, () => {
    const { spawned, processRef, supervisor } = fixture();
    spawned[0].emit("exit", code, signal);
    assert.equal(supervisor.isClosing(), true);
    assert.equal(processRef.exitCode, 1);
    assert.ok(spawned.slice(1).every((child) => child.killed));
  });
}

test("disabled workers are not spawned or endlessly restarted", () => {
  const { spawned, supervisor } = fixture({ AUTO_LISTING_ENABLED: "false", AUTO_LISTING_AI_ENABLED: "false", LISTING_PIPELINE_V3: "0" });
  try {
    assert.equal(spawned.filter((child) => /worker.mjs/.test(child.name)).length, 0);
    assert.ok(spawned.some((child) => child.name === "server/index.mjs"));
  } finally { supervisor.shutdown(); }
});

for (const legacyFlag of ["true", "false", " 1 "]) {
  test(`legacy AI flags do not add a retired worker (${legacyFlag})`, () => {
    const { spawned, supervisor } = fixture({ AUTO_LISTING_ENABLED: legacyFlag, AUTO_LISTING_AI_ENABLED: legacyFlag, LISTING_PIPELINE_V3: "1" });
    try {
      assert.deepEqual(spawned.map(child => child.name), [
        "server/index.mjs",
        "server/listing-worker.mjs",
        "server/ai-listing-worker.mjs",
        "server/ego-proxy.mjs",
        "scripts/frontend-compat-proxy.mjs",
        "app/node_modules/vite/bin/vite.js app --host 127.0.0.1 --port 5173 --strictPort",
      ]);
    } finally { supervisor.shutdown(); }
  });
}

test("late child errors after a requested shutdown do not turn it into a failed startup", () => {
  const { spawned, processRef, supervisor } = fixture();
  supervisor.shutdown();
  spawned[0].emit("error", Object.assign(new Error("already closing"), { code: "ESRCH" }));
  assert.equal(processRef.exitCode, undefined);
});

test("unexpected listing worker exit stops sibling services without scheduling a restart", async () => {
  const { spawned, processRef, supervisor } = fixture();
  try {
    const worker = spawned.find(child => child.name === "server/listing-worker.mjs");
    worker.emit("exit", 1, null);
    assert.equal(supervisor.isClosing(), true);
    assert.equal(processRef.exitCode, 1);
    assert.ok(spawned.filter(child => child !== worker).every(child => child.killed));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(spawned.length, 6);
  } finally { supervisor.shutdown(); }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`parent ${signal} stops all services and ignores later child exits`, () => {
    const { spawned, processRef, supervisor } = fixture();
    processRef.emit(signal);
    spawned[0].emit("exit", 0, null);
    assert.equal(supervisor.isClosing(), true);
    assert.ok(spawned.every(child => child.signal === "SIGTERM"));
    assert.equal(processRef.exitCode, undefined);
  });
}

 test("unexpected AI worker exit stops sibling services", () => {
  const { spawned, processRef, supervisor } = fixture();
  const worker = spawned.find(child => child.name === "server/ai-listing-worker.mjs");
  assert.ok(worker, "AI worker is supervised with the API");
  worker.emit("exit", 1, null);
  assert.equal(supervisor.isClosing(), true);
  assert.equal(processRef.exitCode, 1);
  assert.ok(spawned.filter(child => child !== worker).every(child => child.killed));
});
