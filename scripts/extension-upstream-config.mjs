const extensionVersionParts = (value) => {
  const normalized = String(value || "").trim();
  if (!/^\d+(?:\.\d+){2,3}$/.test(normalized)) {
    throw new Error(`invalid extension version: ${normalized || "<empty>"}`);
  }
  return normalized.split(".").map(Number);
};

export function assertCompatibleExtensionVersions(localVersion, upstreamVersion) {
  const local = extensionVersionParts(localVersion);
  const upstream = extensionVersionParts(upstreamVersion);
  const localReleaseLine = local.slice(0, -1).join(".");
  const upstreamReleaseLine = upstream.slice(0, -1).join(".");
  if (local.length !== upstream.length || localReleaseLine !== upstreamReleaseLine) {
    throw new Error(
      `local extension ${localVersion} is outside upstream release line ${upstreamReleaseLine}`,
    );
  }
  if (local.at(-1) < upstream.at(-1)) {
    throw new Error(
      `local extension ${localVersion} is older than upstream ${upstreamVersion}`,
    );
  }
}

export function requireExtensionUpstreamDir(scriptPath, env = process.env) {
  const sourceDir = String(env.QH_SOURCE_EXTENSION_DIR || "").trim();
  if (sourceDir) return sourceDir;

  console.error(
    `extension upstream check blocked: QH_SOURCE_EXTENSION_DIR is required\n`
    + `usage: QH_SOURCE_EXTENSION_DIR=/absolute/path/to/upstream-extension node ${scriptPath}`,
  );
  return null;
}
