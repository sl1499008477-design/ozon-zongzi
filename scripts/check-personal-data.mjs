import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const CHINESE_MOBILE_NUMBER = /(?<![0-9])1[3-9][0-9]{9}(?![0-9])/g;
const CREDENTIAL_LITERAL =
  /(api[-_ ]?key|apikey|client[-_ ]?id).{0,80}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9]{6,})/gi;

function isInsideLongHexDigest(text, index, length) {
  let start = index;
  let end = index + length;
  while (start > 0 && /[0-9a-f]/i.test(text[start - 1])) start -= 1;
  while (end < text.length && /[0-9a-f]/i.test(text[end])) end += 1;
  return end - start >= 16;
}

export function findChineseMobileNumberFindings(text) {
  const findings = [];
  for (const match of String(text).matchAll(CHINESE_MOBILE_NUMBER)) {
    if (isInsideLongHexDigest(text, match.index, match[0].length)) continue;
    findings.push({ index: match.index, kind: "chinese-mobile-number" });
  }
  return findings;
}

export function findCredentialLiteralFindings(text) {
  return [...String(text).matchAll(CREDENTIAL_LITERAL)].map((match) => ({
    index: match.index,
    kind: "credential-literal",
  }));
}

function gitTrackedFiles() {
  const result = spawnSync("git", ["ls-files", "-z"], {
    encoding: "buffer",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error("cannot enumerate Git tracked files");
  }
  return result.stdout.toString("utf8").split("\0").filter(Boolean);
}

function zipEntries(zipPath) {
  const result = spawnSync("zipinfo", ["-1", zipPath], {
    encoding: "utf8",
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`cannot list tracked archive: ${zipPath}`);
  }
  return result.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry && !entry.endsWith("/") && !entry.startsWith("__MACOSX/"));
}

function readZipEntry(zipPath, entry) {
  const result = spawnSync("unzip", ["-p", zipPath, entry], {
    encoding: "buffer",
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`cannot read tracked archive entry: ${zipPath}:${entry}`);
  }
  return result.stdout;
}

function isCredentialScanPath(file) {
  return file === "README.md"
    || file === "design-qa.md"
    || file === "package.json"
    || file.startsWith("app/src/")
    || file.startsWith("server/")
    || file.startsWith("extension/")
    || file.startsWith("scripts/");
}

function scanText(buffer, label, scanCredentials) {
  if (buffer.includes(0)) return [];
  const text = buffer.toString("utf8");
  const findings = findChineseMobileNumberFindings(text)
    .map((finding) => ({ ...finding, label }));
  if (scanCredentials) {
    findings.push(
      ...findCredentialLiteralFindings(text)
        .map((finding) => ({ ...finding, label })),
    );
  }
  return findings;
}

export function scanTrackedPersonalData() {
  const findings = [];
  for (const file of gitTrackedFiles()) {
    if (path.extname(file).toLowerCase() === ".zip") {
      for (const entry of zipEntries(file)) {
        findings.push(...scanText(
          readZipEntry(file, entry),
          `${file}:${entry}`,
          false,
        ));
      }
      continue;
    }
    findings.push(...scanText(
      readFileSync(file),
      file,
      isCredentialScanPath(file),
    ));
  }
  return findings;
}

function run() {
  const findings = scanTrackedPersonalData();
  if (findings.length === 0) {
    console.log("tracked personal-data and credential scan passed");
    return;
  }

  const grouped = new Map();
  for (const finding of findings) {
    const key = `${finding.kind}:${finding.label}`;
    grouped.set(key, (grouped.get(key) || 0) + 1);
  }
  for (const [key, count] of grouped) {
    console.error(`${key} count=${count}`);
  }
  process.exitCode = 1;
}

const entryUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entryUrl === import.meta.url) run();
