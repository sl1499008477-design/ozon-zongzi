import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

const { values: options } = parseArgs({ options: {
  "web-origin": { type: "string" },
  "output-dir": { type: "string" },
} });
let productionOrigin;
if (options["web-origin"]) {
  const url = new URL(options["web-origin"]);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Production Web origin must be an HTTPS origin without a path or credentials");
  }
  if (!options["output-dir"]) throw new Error("Production packaging requires --output-dir to keep local downloads unchanged");
  productionOrigin = url.origin;
}
const rootDir = process.cwd();
const extensionDir = path.join(rootDir, "extension");
const publicDir = path.resolve(options["output-dir"] || path.join(rootDir, "app", "public"));
const outputDir = options["output-dir"] ? publicDir : path.join(rootDir, "outputs");
const archiveDir = path.join(outputDir, "extension-archive");
const requiredRuntimeFiles = [
  "background/collector-client.js",
  "background/collector-account-status.js",
  "background/collector-ozon-enrichment-agent.js",
  "background/collector-ozon-enrichment-client.js",
  "background/ozon-web-collection.js",
  "background/service-worker.js",
  "content/seller-company-context-hook.js",
  "lib/collector-auth-flow.js",
  "lib/collector-session.js",
  "lib/category-strategy-handoff.js",
  "lib/category-strategy-sampling.js",
  "lib/ozon-buyer-category.js",
  "lib/ozon-collect-coordinator.js",
  "lib/ozon-enrichment-contract.js",
  "lib/seller-company-context.js",
  "lib/seller-company-context-runtime.js",
  "lib/seller-recovery-tab.js",
];

function isOlderVersion(candidate, current) {
  const left = candidate.split(".").map(Number);
  const right = current.split(".").map(Number);
  for (let index = 0; index < 4; index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference !== 0) return difference < 0;
  }
  return false;
}

// Apply deployment addresses only to the copied release, never to development source.
async function configureProductionRelease(directory, manifest, origin) {
  const host = new URL(origin).host;
  const replacements = [
    ["http://127.0.0.1:3000", origin],
    ["127.0.0.1:3000", host],
    ["qh.jizhangerp.com", host],
    ["store.jizhangerp.com", host],
    ["api.jizhangerp.com", `${host}/api`],
  ];
  async function rewriteFiles(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!["tests", "__tests__"].includes(entry.name)) await rewriteFiles(file);
      } else if (/\.(js|html|json)$/.test(entry.name) && file !== path.join(directory, "manifest.json")) {
        const source = await readFile(file, "utf8");
        const configured = replacements.reduce((text, [from, to]) => text.replaceAll(from, to), source);
        if (configured !== source) await writeFile(file, configured);
      }
    }
  }
  const appMatch = /^(?:\*|https?):\/\/(?:(?:\*\.)?qh\.jizhangerp\.com|api\.jizhangerp\.com|(?:localhost|127\.0\.0\.1|store\.localhost):3000)\//;
  const matches = values => [...new Set(values.map(value => appMatch.test(value) ? `${origin}/*` : value))];
  if (manifest.host_permissions) manifest.host_permissions = matches(manifest.host_permissions);
  for (const content of manifest.content_scripts || []) content.matches = matches(content.matches);
  await rewriteFiles(directory);
  await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

// Build a single snapshot outside public before touching any published release.
await mkdir(outputDir, { recursive: true });
const staging = await mkdtemp(path.join(outputDir, ".extension-package-"));
try {
  const stagedExtension = path.join(staging, "extension");
  await cp(extensionDir, stagedExtension, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(stagedExtension, "manifest.json"), "utf8"));
  if (!/^\d+(?:\.\d+){0,3}$/.test(manifest.version)) throw new Error("Invalid extension manifest version");
  for (const relativePath of requiredRuntimeFiles) await readFile(path.join(stagedExtension, relativePath));
  if (productionOrigin) await configureProductionRelease(stagedExtension, manifest, productionOrigin);

  const directoryName = `ozon 粽子-扩展-v${manifest.version}`;
  const fileName = `${directoryName}.zip`;
  const stagedZip = path.join(staging, fileName);
  const result = spawnSync("zip", [
    "-qr", stagedZip, ".", "-x", "tests/*", "background/__tests__/*", "popup/__tests__/*", "*.DS_Store",
  ], { cwd: stagedExtension, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Extension ZIP creation failed (${result.status ?? result.signal})`);

  await mkdir(publicDir, { recursive: true });
  const publicEntries = await readdir(publicDir, { withFileTypes: true });
  let rollbackDir;
  const archive = async (name) => {
    if (!rollbackDir) {
      await mkdir(archiveDir, { recursive: true });
      rollbackDir = await mkdtemp(path.join(archiveDir, `rollback-${new Date().toISOString().replace(/[:.]/g, "-")}-`));
    }
    const destination = path.join(rollbackDir, name);
    await rename(path.join(publicDir, name), destination);
    console.log(`archived ${path.relative(rootDir, destination)}`);
    return destination;
  };

  // A rebuild of the same version also retains the previous bytes in a unique batch.
  const saved = [];
  const published = [];
  try {
    for (const name of [directoryName, fileName]) {
      if (publicEntries.some(entry => entry.name === name)) saved.push({ name, location: await archive(name) });
    }
    for (const [source, name] of [[stagedExtension, directoryName], [stagedZip, fileName]]) {
      await rename(source, path.join(publicDir, name));
      published.push(name);
    }
  } catch (error) {
    for (const name of published) await rm(path.join(publicDir, name), { recursive: true, force: true });
    for (const { name, location } of saved) await rename(location, path.join(publicDir, name));
    throw error;
  }
  for (const name of published) console.log(`packaged ${path.relative(rootDir, path.join(publicDir, name))}`);

  // Only recognized older releases move; future versions and unrelated public files stay put.
  for (const entry of publicEntries) {
    const match = /^(?:(?:sonli|qh)-extension-|ozon 粽子-扩展-v)(\d+(?:\.\d+){0,3})(\.zip)?$/.exec(entry.name);
    if (!match || !(match[2] ? entry.isFile() : entry.isDirectory())) continue;
    if (isOlderVersion(match[1], manifest.version)) await archive(entry.name);
  }
} finally {
  await rm(staging, { recursive: true, force: true });
}
