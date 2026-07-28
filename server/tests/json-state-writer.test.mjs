import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { writeJsonAtomically } from "../json-state-writer.mjs";

test("JSON state replacement never destroys the last complete file when rename fails", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sonli-json-state-"));
  const dataFile = path.join(directory, "local-state.json");
  await fs.writeFile(dataFile, '{"version":"old"}\n', "utf8");
  const failingFs = {
    ...fs,
    rename: async () => {
      throw new Error("rename failed");
    },
  };
  await assert.rejects(
    writeJsonAtomically({
      fsApi: failingFs,
      dataDir: directory,
      dataFile,
      value: { version: "new" },
    }),
    /rename failed/,
  );
  assert.deepEqual(JSON.parse(await fs.readFile(dataFile, "utf8")), { version: "old" });
  assert.deepEqual(
    (await fs.readdir(directory)).filter((name) => name.includes(".tmp-")),
    [],
  );
  await fs.rm(directory, { recursive: true });
});
