import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

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

test("local development restarts only the AI worker after an unexpected exit and stops on parent shutdown", async () => {
  const spawned = [];
  const processRef = new EventEmitter();
  processRef.env = {};
  processRef.stdout = { write() {} };
  processRef.stderr = { write() {} };
  const spawnProcess = (_command, args) => {
    const name = args[0]?.includes("auto-listing-ai-worker") ? "auto-listing-ai-worker" : args.join(" ");
    const child = new FakeChild(name);
    spawned.push(child);
    return child;
  };
  const logger = { log() {}, error() {} };
  const supervisor = startDevelopmentServices({
    spawnProcess,
    processRef,
    logger,
    restartDelayMs: 1,
  });
  const firstWorker = spawned.find((child) => child.name === "auto-listing-ai-worker");
  assert.ok(firstWorker);

  firstWorker.emit("exit", 1, null);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(spawned.filter((child) => child.name === "auto-listing-ai-worker").length, 2);
  assert.equal(spawned.filter((child) => child.name !== "auto-listing-ai-worker").length, 4);
  assert.equal(spawned.slice(0, 5).some((child) => child.killed), false);

  processRef.emit("SIGTERM");
  assert.equal(supervisor.isClosing(), true);
  assert.equal(spawned.filter((child) => child !== firstWorker && !child.killed).length, 0);
  spawned.at(-1).emit("exit", 1, null);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(spawned.filter((child) => child.name === "auto-listing-ai-worker").length, 2);
});
