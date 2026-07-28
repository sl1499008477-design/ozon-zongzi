export function requireExtensionUpstreamDir(scriptPath, env = process.env) {
  const sourceDir = String(env.QH_SOURCE_EXTENSION_DIR || "").trim();
  if (sourceDir) return sourceDir;

  console.error(
    `extension upstream check blocked: QH_SOURCE_EXTENSION_DIR is required\n`
    + `usage: QH_SOURCE_EXTENSION_DIR=/absolute/path/to/upstream-extension node ${scriptPath}`,
  );
  return null;
}
