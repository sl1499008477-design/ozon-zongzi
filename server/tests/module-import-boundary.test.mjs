import assert from "node:assert/strict";
import test from "node:test";
import { assertCategoryResolutionPortBoundary } from "../module-import-boundary.mjs";

function assertRejected(source, expectedSpecifier) {
  assert.throws(
    () => assertCategoryResolutionPortBoundary(source, { label: "fixture" }),
    (error) => error?.code === "CATEGORY_RESOLUTION_MODULE_BOUNDARY"
      && error?.specifier === expectedSpecifier,
  );
}

test("rejects real static Repository and recursive database imports across syntax forms", () => {
  for (const [source, expectedSpecifier] of [
    ['import { createRepository } from "./collect-category-resolution-repository.mjs";', "./collect-category-resolution-repository.mjs"],
    ['import repository from "./collect-category-resolution-repository.mjs";', "./collect-category-resolution-repository.mjs"],
    ['import "./collect-category-resolution-repository.mjs";', "./collect-category-resolution-repository.mjs"],
    ['import database from "../db/migrate.mjs";', "../db/migrate.mjs"],
    ['import/* comment */"./db/connection.mjs";', "./db/connection.mjs"],
    ['import { pool } /* binding */ from /* specifier */ "../db/internal/pool.mjs";', "../db/internal/pool.mjs"],
    [String.raw`import "./d\u0062/connection.mjs";`, "./db/connection.mjs"],
  ]) {
    assertRejected(source, expectedSpecifier);
  }
});

test("rejects real literal dynamic imports with comments and escaped specifiers", () => {
  for (const [source, expectedSpecifier] of [
    ['await import("./collect-category-resolution-repository.mjs");', "./collect-category-resolution-repository.mjs"],
    ['await import(/* comment */ "../db/internal/pool.mjs");', "../db/internal/pool.mjs"],
    ['await import /* before call */ ("./db/connection.mjs");', "./db/connection.mjs"],
    [String.raw`await import("../d\x62/internal/pool.mjs");`, "../db/internal/pool.mjs"],
    ['const loaded = `${await import(/* expression */ "./db/connection.mjs")}`;', "./db/connection.mjs"],
  ]) {
    assertRejected(source, expectedSpecifier);
  }
});

test("ignores import text inside comments, quoted strings, and template text", () => {
  for (const source of [
    '// import "./db/connection.mjs";\nexport const safe = true;',
    '/* import "../db/internal/pool.mjs"; */\nexport const safe = true;',
    String.raw`const note = "escaped quote: \"; import './db/connection.mjs'";`,
    String.raw`const note = 'escaped quote: \'; import "./db/connection.mjs"';`,
    'const note = `import "./db/connection.mjs"`;',
    'const note = `escaped backtick: \\`; import "../db/internal/pool.mjs"`;',
    'const loader = { import() {} }; loader /* property */ . /* call */ import("./db/connection.mjs");',
  ]) {
    assert.doesNotThrow(() => assertCategoryResolutionPortBoundary(source, { label: "fixture" }));
  }
});
