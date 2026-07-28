import crypto from "node:crypto";
import { PgBoss } from "pg-boss";
import { postgresConfig } from "./db/connection.mjs";
import {
  LISTING_QUEUE,
  claimOutboxEventsV3,
  markOutboxFailedV3,
  markOutboxPublishedV3,
  transitionSubmissionJobV3,
} from "./listing-pipeline.mjs";

let bossPromise = null;

export async function getListingBoss() {
  if (!bossPromise) {
    bossPromise = (async () => {
      const boss = new PgBoss({
        ...postgresConfig(),
        schema: process.env.PG_BOSS_SCHEMA || "sonli_queue",
        application_name: process.env.PG_BOSS_APPLICATION_NAME || "sonli-listing-worker",
        max: Number(process.env.PG_BOSS_POOL_SIZE || 5),
        useListenNotify: true,
      });
      boss.on("error", (error) => console.error(`[listing-queue] ${error?.message || error}`));
      boss.on("warning", (warning) => console.warn(`[listing-queue] ${warning?.message || warning}`));
      await boss.start();
      await boss.createQueue(LISTING_QUEUE, {
        retryLimit: Number(process.env.LISTING_QUEUE_RETRY_LIMIT || 2),
        retryDelay: Number(process.env.LISTING_QUEUE_RETRY_DELAY_SECONDS || 5),
        retryBackoff: true,
        expireInSeconds: Number(process.env.LISTING_QUEUE_EXPIRE_SECONDS || 300),
        retentionSeconds: Number(process.env.LISTING_QUEUE_RETENTION_SECONDS || 1209600),
        deleteAfterSeconds: Number(process.env.LISTING_QUEUE_DELETE_AFTER_SECONDS || 604800),
        heartbeatSeconds: 30,
        notify: true,
      });
      return boss;
    })();
  }
  return bossPromise;
}

export async function stopListingBoss() {
  if (!bossPromise) return;
  const boss = await bossPromise;
  bossPromise = null;
  await boss.stop({ graceful: true, timeout: 30000 });
}

export async function dispatchListingOutboxOnce({ workerId = `relay_${crypto.randomUUID()}`, limit = 50 } = {}) {
  const boss = await getListingBoss();
  const events = await claimOutboxEventsV3(workerId, limit);
  let published = 0;
  for (const event of events) {
    try {
      const data = event.payload && typeof event.payload === "object" ? event.payload : {};
      const queueJobId = await boss.send(LISTING_QUEUE, {
        outboxEventId: event.id,
        submissionJobId: data.submissionJobId || event.aggregate_id,
        action: data.action || (event.event_type.includes("check") ? "check" : "submit"),
      }, {
        singletonKey: event.id,
        singletonSeconds: 60 * 60 * 24 * 14,
        group: { id: event.aggregate_id },
      });
      if (!queueJobId) throw new Error("pg-boss 未返回任务 ID");
      await markOutboxPublishedV3(event.id);
      if (event.event_type === "listing.submit.requested") {
        await transitionSubmissionJobV3(event.aggregate_id, "QUEUED", {}, {
          type: "submission.queued",
          message: `已投递到 pg-boss：${queueJobId}`,
          actorType: "outbox-relay",
          actorId: workerId,
          payload: { queueJobId, outboxEventId: event.id },
        }).catch(() => {});
      }
      published += 1;
    } catch (error) {
      await markOutboxFailedV3(event.id, error);
    }
  }
  return { claimed: events.length, published };
}
