import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");

test("incremental migrations remain ordered through 105", async () => {
  const files = (await readdir(migrationsDirectory)).filter((file) => /^\d{3}_.+\.sql$/u.test(file)).sort();
  const recent = files.filter((file) => Number(file.slice(0, 3)) >= 74);
  assert.deepEqual(recent.map((file) => Number(file.slice(0, 3))), Array.from({ length: 32 }, (_, index) => 74 + index));
  assert.equal(recent.at(-1), "105_auto_listing_source_image_derivatives.sql");
  for (const file of recent) assert.ok((await readFile(path.join(migrationsDirectory, file), "utf8")).trim().length > 0);
});
