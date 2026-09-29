import "./support/dedicated-postgres-test-environment.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { isolatedTestEnvironment } from "../../scripts/test-environment.mjs";

// Explicit opt-in: this suite kills/restarts ONLY the disposable container it creates.
// It never accepts a DATABASE_URL or a pre-existing container as its target.
test("PostgreSQL disconnects return failures without killing the process, then reads recover", {
  skip: process.env.SONLI_PG_DISCONNECT_TESTS !== "1",
}, async (t) => {
  const name = `ozon-pg-disconnect-${randomUUID()}`;
  const env = isolatedTestEnvironment(process.env, `/tmp/${name}`);
  const docker = (...args) => execFileSync("docker", args, {
    env, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  // Pin a fresh loopback port: Docker's automatic port mapping changes on start.
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const hostPort = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  docker("run", "-d", "--pull=never", "--name", name,
    "--memory", "256m", "--memory-swap", "256m", "--restart=no",
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-p", `127.0.0.1:${hostPort}:5432`,
    "postgres:16-alpine", "-c", "shared_buffers=32MB");
  t.after(() => docker("rm", "-f", "-v", name));
  t.diagnostic(`Owned disposable container: ${name}`);

  for (const scenario of [
    "idle-pool", "active-pool-query", "active-held-query",
    "held-between-queries", "state-transaction", "ordinary-sql-error",
  ]) {
    await t.test(scenario, async () => {
      docker("start", name);
      let ready = false;
      for (let attempt = 0; attempt < 150; attempt += 1) {
        try {
          docker("exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres");
          ready = true;
          break;
        } catch { await delay(100); }
      }
      assert(ready, "disposable PostgreSQL did not start");
      const port = JSON.parse(docker("inspect", name))[0].NetworkSettings.Ports["5432/tcp"][0].HostPort;
      const result = spawnSync(process.execPath, [
        "server/tests/support/postgres-disconnect-probe.mjs", name, port, scenario,
      ], { env, encoding: "utf8", timeout: 45_000 });
      assert.equal(result.status, 0, `${result.error?.message || ""}\n${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /recovery verified/);
      assert.doesNotMatch(result.stderr, /Unhandled|unhandled|uncaught|MaxListenersExceededWarning/);
      t.diagnostic(`${scenario}: ${result.stdout.trim()}`);
    });
  }
});
