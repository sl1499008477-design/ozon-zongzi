import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export async function writeJsonAtomically({
  fsApi = fs,
  dataDir,
  dataFile,
  value,
}) {
  await fsApi.mkdir(dataDir, { recursive: true });
  const temporaryFile = path.join(
    dataDir,
    `.${path.basename(dataFile)}.tmp-${process.pid}-${crypto.randomUUID()}`,
  );
  let handle;
  try {
    handle = await fsApi.open(temporaryFile, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fsApi.rename(temporaryFile, dataFile);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fsApi.unlink(temporaryFile).catch(() => {});
    throw error;
  }
}
