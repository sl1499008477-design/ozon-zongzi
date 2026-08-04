import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { readObjectStreamBounded } from "../object-storage.mjs";

test("bounded object reads return exact bytes and destroy an overflowing stream", async () => {
  const bytes = await readObjectStreamBounded(Readable.from([Buffer.from("abc"), Buffer.from("def")]), { maxBytes: 6 });
  assert.equal(bytes.toString(), "abcdef");

  const stream = Readable.from([Buffer.alloc(4), Buffer.alloc(3)]);
  let destroyed = false;
  const destroy = stream.destroy.bind(stream);
  stream.destroy = (...args) => { destroyed = true; return destroy(...args); };
  await assert.rejects(readObjectStreamBounded(stream, { maxBytes: 6 }), /对象超过读取限制/);
  assert.equal(destroyed, true);
});

test("bounded object reads reject invalid limits before consuming bytes", async () => {
  let reads = 0;
  const stream = new Readable({ read() { reads += 1; this.push(null); } });
  await assert.rejects(readObjectStreamBounded(stream, { maxBytes: 0 }), /对象读取大小限制无效/);
  assert.equal(reads, 0);
});
