function cleanKey(value) {
  return String(value || "").trim();
}

function retryAt(now, attemptCount) {
  const delayMs = Math.min(24 * 60 * 60 * 1000, 5 * 60 * 1000 * (2 ** Math.max(0, attemptCount - 1)));
  return new Date(now.getTime() + delayMs).toISOString();
}

export function enqueueObjectDeletions(state, objectKeys, now = new Date().toISOString()) {
  const pending = Array.isArray(state.pendingObjectDeletions)
    ? state.pendingObjectDeletions
    : [];
  const byKey = new Map(
    pending
      .filter((item) => cleanKey(item?.objectKey))
      .map((item) => [cleanKey(item.objectKey), item]),
  );
  for (const objectKey of Array.isArray(objectKeys) ? objectKeys : [objectKeys]) {
    const key = cleanKey(objectKey);
    if (!key || byKey.has(key)) continue;
    byKey.set(key, {
      objectKey: key,
      attemptCount: 0,
      lastError: "",
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }
  state.pendingObjectDeletions = [...byKey.values()];
  return state.pendingObjectDeletions;
}

export async function processPendingObjectDeletions(
  state,
  remove,
  now = new Date(),
) {
  if (typeof remove !== "function") throw new TypeError("缺少对象删除函数");
  const pending = Array.isArray(state.pendingObjectDeletions)
    ? state.pendingObjectDeletions
    : [];
  const next = [];
  let attempted = 0;
  let deleted = 0;
  let failed = 0;

  for (const item of pending) {
    const objectKey = cleanKey(item?.objectKey);
    if (!objectKey) continue;
    const nextAttemptAt = new Date(item.nextAttemptAt || 0).getTime();
    if (Number.isFinite(nextAttemptAt) && nextAttemptAt > now.getTime()) {
      next.push(item);
      continue;
    }
    attempted += 1;
    try {
      await remove(objectKey);
      deleted += 1;
    } catch (error) {
      failed += 1;
      const attemptCount = Number(item.attemptCount || 0) + 1;
      next.push({
        ...item,
        objectKey,
        attemptCount,
        lastError: String(error?.message || error || "对象删除失败").slice(0, 240),
        nextAttemptAt: retryAt(now, attemptCount),
        updatedAt: now.toISOString(),
      });
    }
  }

  state.pendingObjectDeletions = next;
  return { attempted, deleted, failed, pending: next.length };
}
