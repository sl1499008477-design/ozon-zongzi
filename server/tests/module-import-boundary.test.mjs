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

test("new shared category Repository is limited to exact approved category importers", () => {
  const source = 'import { createJsonAccountSharedOzonCategoryRepository } from "./account-shared-ozon-category-repository.mjs";';
  for (const modulePath of [
    "server/collect-category-resolution-runtime.mjs",
    "server/collect-category-auto-resolution-composition.mjs",
    "server/collect-category-resolution-service.mjs",
    "server/collector-ozon-enrichment-service.mjs",
    "server/account-shared-ozon-category-service.mjs",
  ]) {
    assert.doesNotThrow(() => assertCategoryResolutionPortBoundary(source, {
      label: modulePath,
      modulePath,
    }));
  }
  for (const modulePath of [
    "server/index.mjs",
    "server/account-scoped-collection-routes.mjs",
    "server/collect-category-resolution-service-helper.mjs",
    "server/approved/account-shared-ozon-category-service.mjs",
  ]) {
    assert.throws(
      () => assertCategoryResolutionPortBoundary(source, { label: modulePath, modulePath }),
      (error) => error?.code === "CATEGORY_RESOLUTION_MODULE_BOUNDARY"
        && error?.specifier === "./account-shared-ozon-category-repository.mjs",
    );
  }
});

test("retired named Repository remains forbidden even from new approved importers", () => {
  assert.throws(
    () => assertCategoryResolutionPortBoundary(
      'import repository from "./collect-category-resolution-repository.mjs";',
      {
        label: "category runtime",
        modulePath: "server/collect-category-resolution-runtime.mjs",
      },
    ),
    (error) => error?.code === "CATEGORY_RESOLUTION_MODULE_BOUNDARY"
      && error?.specifier === "./collect-category-resolution-repository.mjs",
  );
});

test("rejects a static import after a string-named binding called from", () => {
  assertRejected(
    'import { "from" as value } from "./db/connection.mjs";',
    "./db/connection.mjs",
  );
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

test("rejects Repository imports with URL query and fragment suffixes", () => {
  for (const [source, expectedSpecifier] of [
    ['import repository from "./collect-category-resolution-repository.mjs?source=guard";', "./collect-category-resolution-repository.mjs?source=guard"],
    ['import "./collect-category-resolution-repository.mjs#fixture";', "./collect-category-resolution-repository.mjs#fixture"],
    ['await import("./collect-category-resolution-repository.mjs?source=guard");', "./collect-category-resolution-repository.mjs?source=guard"],
    ['await import("./collect-category-resolution-repository.mjs#fixture");', "./collect-category-resolution-repository.mjs#fixture"],
  ]) {
    assertRejected(source, expectedSpecifier);
  }
});

test("rejects recursive database imports with URL query and fragment suffixes", () => {
  for (const [source, expectedSpecifier] of [
    ['import database from "../db/internal/pool.mjs?source=guard";', "../db/internal/pool.mjs?source=guard"],
    ['import "./db/connection.mjs#fixture";', "./db/connection.mjs#fixture"],
    ['await import("../db/internal/pool.mjs?source=guard");', "../db/internal/pool.mjs?source=guard"],
    ['await import("./db/connection.mjs#fixture");', "./db/connection.mjs#fixture"],
  ]) {
    assertRejected(source, expectedSpecifier);
  }
});

test("keeps percent-encoded filename characters distinct from URL suffix delimiters", () => {
  for (const source of [
    'import "./collect-category-resolution-repository.mjs%3Fbypass";',
    'await import("./collect-category-resolution-repository.mjs%23bypass");',
    'import "./safe%3Fname.mjs";',
    'await import("./safe%23name.mjs");',
    'import "./safe.mjs?redirect=./db/connection.mjs";',
    'await import("./safe.mjs#./collect-category-resolution-repository.mjs");',
  ]) {
    assert.doesNotThrow(() => assertCategoryResolutionPortBoundary(source, { label: "fixture" }));
  }
});

test("leaves a computed dynamic import outside the literal-import contract", () => {
  assert.doesNotThrow(() => assertCategoryResolutionPortBoundary(
    'await import("./db/connection.mjs" + suffix);',
    { label: "fixture" },
  ));
});

test("ignores import text inside comments, quoted strings, and template text", () => {
  for (const source of [
    '// import "./db/connection.mjs";\nexport const safe = true;',
    '/* import "../db/internal/pool.mjs"; */\nexport const safe = true;',
    String.raw`const note = "escaped quote: \"; import './db/connection.mjs'";`,
    String.raw`const note = 'escaped quote: \'; import "./db/connection.mjs"';`,
    'const note = `import "./db/connection.mjs"`;',
    'const note = `escaped backtick: \\`; import "../db/internal/pool.mjs"`;',
    'const note = `outer ${`inner import("./db/connection.mjs")`} text`;',
    'const loader = { import() {} }; loader /* property */ . /* call */ import("./db/connection.mjs");',
  ]) {
    assert.doesNotThrow(() => assertCategoryResolutionPortBoundary(source, { label: "fixture" }));
  }
});

for (const [name, lineTerminator] of [
  ["LF", "\n"],
  ["CR", "\r"],
  ["LINE SEPARATOR", "\u2028"],
  ["PARAGRAPH SEPARATOR", "\u2029"],
]) {
  test(`ends a line comment at ${name} before a real forbidden import`, () => {
    assertRejected(
      `// import "./db/comment-only.mjs";${lineTerminator}import "./db/connection.mjs";`,
      "./db/connection.mjs",
    );
  });
}

test("ignores static and dynamic import-shaped text inside regex literals", () => {
  for (const source of [
    String.raw`const pattern = /import { value } from "\.\/db\/connection\.mjs"/;`,
    String.raw`const pattern = /import(".\/db\/connection.mjs")/;`,
    String.raw`if (enabled) /import(".\/db\/connection.mjs")/.test(source);`,
    String.raw`if (import(moduleName)) /import(".\/db\/connection.mjs")/.test(source);`,
  ]) {
    assert.doesNotThrow(() => assertCategoryResolutionPortBoundary(source, { label: "fixture" }));
  }
});

test("distinguishes division from a regex before a later forbidden import", () => {
  assertRejected(
    'const ratio = numerator / denominator; import("./db/connection.mjs");',
    "./db/connection.mjs",
  );
});

test("treats a variable named of as a division operand before a forbidden import", () => {
  assertRejected(
    'const of = 4, denominator = 2; const ratio = of / denominator; import("./db/connection.mjs");',
    "./db/connection.mjs",
  );
});

test("keeps an object literal closing brace in division context", () => {
  assertRejected(
    'const ratio = ({ value: 4 } / denominator); import("./db/connection.mjs");',
    "./db/connection.mjs",
  );
});

for (const [context, source] of [
  ["a control block", String.raw`if (enabled) {} /import(".\x2fdb\x2fconnection.mjs")/.test(source);`],
  ["export default", String.raw`export default /import(".\x2fdb\x2fconnection.mjs")/;`],
  ["a class declaration", String.raw`class Example {} /import(".\x2fdb\x2fconnection.mjs")/.test(source);`],
  ["a function declaration", String.raw`function example() {} /import(".\x2fdb\x2fconnection.mjs")/.test(source);`],
  ["an async function declaration", String.raw`async function example() {} /import(".\x2fdb\x2fconnection.mjs")/.test(source);`],
  ["an exported class declaration", String.raw`export default class Example {} /import(".\x2fdb\x2fconnection.mjs")/.test(source);`],
  ["an exported function declaration", String.raw`export default function example() {} /import(".\x2fdb\x2fconnection.mjs")/.test(source);`],
  ["an exported async function declaration", String.raw`export default async function example() {} /import(".\x2fdb\x2fconnection.mjs")/.test(source);`],
  ["a labeled block", String.raw`label: {} /import(".\x2fdb\x2fconnection.mjs")/.test(source);`],
  ["a switch case block", String.raw`switch (kind) { case "x": {} /import(".\x2fdb\x2fconnection.mjs")/.test(source); }`],
  ["a switch default block", String.raw`switch (kind) { default: {} /import(".\x2fdb\x2fconnection.mjs")/.test(source); }`],
]) {
  test(`ignores import-shaped regex text after ${context}`, () => {
    assert.doesNotThrow(() => assertCategoryResolutionPortBoundary(source, { label: "fixture" }));
  });
}

test("keeps class and function expressions in division context", () => {
  for (const source of [
    'const ratio = class Example {} / denominator; import("./db/connection.mjs");',
    'const ratio = class {} / denominator; import("./db/connection.mjs");',
    'const ratio = function example() {} / denominator; import("./db/connection.mjs");',
    'const ratio = async function example() {} / denominator; import("./db/connection.mjs");',
    'const ratio = (() => {}) / denominator; import("./db/connection.mjs");',
    'const ratio = (async () => {}) / denominator; import("./db/connection.mjs");',
  ]) {
    assertRejected(source, "./db/connection.mjs");
  }
});

test("keeps scanning a template expression after a regex containing a closing brace", () => {
  assertRejected(
    'const loaded = `${/}/.test(value) && import("./db/connection.mjs")}`;',
    "./db/connection.mjs",
  );
});
