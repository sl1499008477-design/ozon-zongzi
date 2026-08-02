const IDENTIFIER_START = /[$_\p{ID_Start}]/u;
const IDENTIFIER_CONTINUE = /[$\u200C\u200D\p{ID_Continue}]/u;

function skipTrivia(source, start) {
  let cursor = start;
  while (cursor < source.length) {
    if (/\s/u.test(source[cursor])) {
      cursor += 1;
      continue;
    }
    if (source.startsWith("//", cursor)) {
      const lineEnd = source.indexOf("\n", cursor + 2);
      cursor = lineEnd < 0 ? source.length : lineEnd + 1;
      continue;
    }
    if (source.startsWith("/*", cursor)) {
      const commentEnd = source.indexOf("*/", cursor + 2);
      cursor = commentEnd < 0 ? source.length : commentEnd + 2;
      continue;
    }
    break;
  }
  return cursor;
}

function readIdentifier(source, start) {
  let cursor = start + 1;
  while (cursor < source.length && IDENTIFIER_CONTINUE.test(source[cursor])) cursor += 1;
  return { value: source.slice(start, cursor), end: cursor };
}

function decodeEscape(source, slashIndex) {
  const escaped = source[slashIndex + 1];
  const simple = {
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
    0: "\0",
  };
  if (Object.hasOwn(simple, escaped)) {
    return { value: simple[escaped], end: slashIndex + 2 };
  }
  if (escaped === "\n") return { value: "", end: slashIndex + 2 };
  if (escaped === "\r") {
    return {
      value: "",
      end: source[slashIndex + 2] === "\n" ? slashIndex + 3 : slashIndex + 2,
    };
  }
  if (escaped === "x") {
    const digits = source.slice(slashIndex + 2, slashIndex + 4);
    if (/^[\da-f]{2}$/iu.test(digits)) {
      return { value: String.fromCodePoint(Number.parseInt(digits, 16)), end: slashIndex + 4 };
    }
  }
  if (escaped === "u") {
    if (source[slashIndex + 2] === "{") {
      const close = source.indexOf("}", slashIndex + 3);
      const digits = close < 0 ? "" : source.slice(slashIndex + 3, close);
      const codePoint = /^[\da-f]{1,6}$/iu.test(digits) ? Number.parseInt(digits, 16) : -1;
      if (codePoint >= 0 && codePoint <= 0x10ffff) {
        return { value: String.fromCodePoint(codePoint), end: close + 1 };
      }
    } else {
      const digits = source.slice(slashIndex + 2, slashIndex + 6);
      if (/^[\da-f]{4}$/iu.test(digits)) {
        return { value: String.fromCodePoint(Number.parseInt(digits, 16)), end: slashIndex + 6 };
      }
    }
  }
  return { value: escaped ?? "", end: Math.min(source.length, slashIndex + 2) };
}

function readStringLiteral(source, start) {
  const quote = source[start];
  let cursor = start + 1;
  let value = "";
  while (cursor < source.length) {
    if (source[cursor] === quote) return { value, end: cursor + 1 };
    if (source[cursor] !== "\\") {
      value += source[cursor];
      cursor += 1;
      continue;
    }
    const decoded = decodeEscape(source, cursor);
    value += decoded.value;
    cursor = decoded.end;
  }
  return { value, end: source.length };
}

function readImport(source, afterImport) {
  let cursor = skipTrivia(source, afterImport);
  if (source[cursor] === ".") return { end: cursor + 1 };
  if (source[cursor] === "(") {
    cursor = skipTrivia(source, cursor + 1);
    if (source[cursor] === '"' || source[cursor] === "'") {
      const literal = readStringLiteral(source, cursor);
      return { specifier: literal.value, end: literal.end };
    }
    return { end: cursor };
  }
  if (source[cursor] === '"' || source[cursor] === "'") {
    const literal = readStringLiteral(source, cursor);
    return { specifier: literal.value, end: literal.end };
  }
  while (cursor < source.length && source[cursor] !== ";") {
    cursor = skipTrivia(source, cursor);
    if (!IDENTIFIER_START.test(source[cursor] || "")) {
      cursor += 1;
      continue;
    }
    const identifier = readIdentifier(source, cursor);
    cursor = identifier.end;
    if (identifier.value !== "from") continue;
    const specifierStart = skipTrivia(source, cursor);
    if (source[specifierStart] !== '"' && source[specifierStart] !== "'") continue;
    const literal = readStringLiteral(source, specifierStart);
    return { specifier: literal.value, end: literal.end };
  }
  return { end: cursor };
}

function scanTemplate(source, start, specifiers) {
  let cursor = start + 1;
  while (cursor < source.length) {
    if (source[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (source[cursor] === "`") return cursor + 1;
    if (source.startsWith("${", cursor)) {
      cursor = scanCode(source, cursor + 2, specifiers, true);
      continue;
    }
    cursor += 1;
  }
  return source.length;
}

function scanCode(source, start, specifiers, stopAtTemplateBrace = false) {
  let cursor = start;
  let braceDepth = 0;
  let previousToken = null;
  while (cursor < source.length) {
    const next = skipTrivia(source, cursor);
    if (next !== cursor) {
      cursor = next;
      continue;
    }
    const character = source[cursor];
    if (character === '"' || character === "'") {
      cursor = readStringLiteral(source, cursor).end;
      previousToken = "literal";
      continue;
    }
    if (character === "`") {
      cursor = scanTemplate(source, cursor, specifiers);
      previousToken = "literal";
      continue;
    }
    if (character === "{") {
      braceDepth += 1;
      cursor += 1;
      previousToken = character;
      continue;
    }
    if (character === "}") {
      if (stopAtTemplateBrace && braceDepth === 0) return cursor + 1;
      braceDepth = Math.max(0, braceDepth - 1);
      cursor += 1;
      previousToken = character;
      continue;
    }
    if (!IDENTIFIER_START.test(character || "")) {
      cursor += 1;
      previousToken = character;
      continue;
    }
    const identifier = readIdentifier(source, cursor);
    cursor = identifier.end;
    if (identifier.value !== "import" || previousToken === ".") {
      previousToken = identifier.value;
      continue;
    }
    const imported = readImport(source, cursor);
    if (imported.specifier !== undefined) specifiers.push(imported.specifier);
    cursor = Math.max(cursor, imported.end);
    previousToken = identifier.value;
  }
  return cursor;
}

function importSpecifiers(source) {
  const specifiers = [];
  scanCode(source, 0, specifiers);
  return specifiers;
}

function forbiddenCategoryResolutionSpecifier(specifier) {
  return /(?:^|\/)collect-category-resolution-repository\.mjs$/i.test(specifier)
    || /(?:^|\/)db\/.+$/i.test(specifier);
}

export function assertCategoryResolutionPortBoundary(source, { label = "module" } = {}) {
  for (const specifier of importSpecifiers(String(source ?? ""))) {
    if (!forbiddenCategoryResolutionSpecifier(specifier)) continue;
    throw Object.assign(new Error(`${label} must use the category resolution Port`), {
      code: "CATEGORY_RESOLUTION_MODULE_BOUNDARY",
      specifier,
    });
  }
}
