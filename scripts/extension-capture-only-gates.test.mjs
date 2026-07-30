import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

const rootDir = process.cwd();
const extensionDir = path.join(rootDir, "extension");
const readinessGate = path.join(rootDir, "scripts", "check-plugin-readiness-gate.mjs");
const zipGate = path.join(rootDir, "scripts", "check-extension-zip-smoke.mjs");

const mutations = {
  "required permission": (manifest) => {
    manifest.permissions = [...(manifest.permissions || []), "downloads"];
  },
  "optional permission": (manifest) => {
    manifest.optional_permissions = [
      ...(manifest.optional_permissions || []),
      "tabs",
    ];
  },
  "required host": (manifest) => {
    manifest.host_permissions = [
      ...(manifest.host_permissions || []),
      "https://evil.example/*",
    ];
  },
  "optional host": (manifest) => {
    manifest.optional_host_permissions = [
      ...(manifest.optional_host_permissions || []),
      "https://optional.example/*",
    ];
  },
};

const runGate = (script, env) =>
  spawnSync(process.execPath, [script], {
    cwd: rootDir,
    env: { ...process.env, ...env },
    encoding: "utf8",
    shell: false,
  });

async function createCandidate(tmpDir, label, mutate) {
  const candidateDir = path.join(tmpDir, label.replaceAll(" ", "-"));
  await cp(extensionDir, candidateDir, { recursive: true });
  const manifestPath = path.join(candidateDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  mutate(manifest);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    candidateDir,
    candidateZip: await zipCandidate(candidateDir),
  };
}

function zipCandidate(candidateDir) {
  const candidateZip = `${candidateDir}.zip`;
  const zipped = spawnSync("zip", ["-qr", candidateZip, "."], {
    cwd: candidateDir,
    encoding: "utf8",
    shell: false,
  });
  assert.equal(zipped.status, 0, zipped.stderr);
  return candidateZip;
}

test("standalone readiness and ZIP gates reject every unreviewed capability class", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "capture-only-gates-"));
  try {
    for (const [label, mutate] of Object.entries(mutations)) {
      const { candidateDir, candidateZip } = await createCandidate(
        tmpDir,
        label,
        mutate,
      );

      const readiness = runGate(readinessGate, {
        QH_LOCAL_EXTENSION_DIR: candidateDir,
      });
      const zipSmoke = runGate(zipGate, {
        QH_EXTENSION_ZIP_PATHS: candidateZip,
      });
      assert.notEqual(
        readiness.status,
        0,
        `readiness gate accepted unreviewed ${label}`,
      );
      assert.notEqual(
        zipSmoke.status,
        0,
        `ZIP gate accepted unreviewed ${label}`,
      );
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("permission omissions are allowed only while capture invariants remain", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "capture-omissions-"));
  try {
    const missingStorage = await createCandidate(
      tmpDir,
      "missing required storage",
      (manifest) => {
        manifest.permissions = manifest.permissions.filter(
          (permission) => permission !== "storage",
        );
      },
    );
    const withoutNotification = await createCandidate(
      tmpDir,
      "missing reviewed notification",
      (manifest) => {
        manifest.permissions = manifest.permissions.filter(
          (permission) => permission !== "notifications",
        );
      },
    );
    const optionalOnlyLocalhost = await createCandidate(
      tmpDir,
      "required localhost moved optional",
      (manifest) => {
        manifest.host_permissions = manifest.host_permissions.filter(
          (permission) => permission !== "http://127.0.0.1:3000/*",
        );
        manifest.optional_host_permissions = [
          ...(manifest.optional_host_permissions || []),
          "http://127.0.0.1:3000/*",
        ];
      },
    );

    for (const [gate, script, envName] of [
      ["readiness", readinessGate, "QH_LOCAL_EXTENSION_DIR"],
      ["ZIP", zipGate, "QH_EXTENSION_ZIP_PATHS"],
    ]) {
      const requiredCandidate = envName === "QH_LOCAL_EXTENSION_DIR"
        ? missingStorage.candidateDir
        : missingStorage.candidateZip;
      const omittedCandidate = envName === "QH_LOCAL_EXTENSION_DIR"
        ? withoutNotification.candidateDir
        : withoutNotification.candidateZip;
      const optionalHostCandidate = envName === "QH_LOCAL_EXTENSION_DIR"
        ? optionalOnlyLocalhost.candidateDir
        : optionalOnlyLocalhost.candidateZip;
      assert.notEqual(
        runGate(script, { [envName]: requiredCandidate }).status,
        0,
        `${gate} gate accepted a candidate without required storage`,
      );
      const omissionResult = runGate(script, { [envName]: omittedCandidate });
      assert.equal(
        omissionResult.status,
        0,
        `${gate} gate rejected omission of non-core reviewed notifications:\n`
          + `${omissionResult.stdout || ""}${omissionResult.stderr || ""}`,
      );
      assert.notEqual(
        runGate(script, { [envName]: optionalHostCandidate }).status,
        0,
        `${gate} gate accepted required local Web access as optional-only`,
      );
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("ZIP smoke requires both packaged popup runtime tests", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "popup-zip-gates-"));
  try {
    for (const popupTest of [
      "popup/__tests__/popup-collector-session.runtime.test.js",
      "popup/__tests__/popup-routing.smoke.test.js",
    ]) {
      const candidateDir = path.join(
        tmpDir,
        path.basename(popupTest, ".js"),
      );
      await cp(extensionDir, candidateDir, { recursive: true });
      await rm(path.join(candidateDir, popupTest));
      const candidateZip = zipCandidate(candidateDir);
      const result = runGate(zipGate, {
        QH_EXTENSION_ZIP_PATHS: candidateZip,
      });
      assert.notEqual(
        result.status,
        0,
        `ZIP smoke accepted a package missing ${popupTest}`,
      );
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
