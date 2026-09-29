import './env.mjs';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { assertProductionConfiguration } from './runtime-config.mjs';
import { listingPipelineEnabled } from './listing-pipeline.mjs';
import { getPostgresPool, closePostgresPool } from './db/connection.mjs';
import { createAiListingRuntime } from './ai-listing-runtime.mjs';

const LOCK_KEY = 'ai-listing-image-worker';

export async function startAiListingWorker({
  enabled = listingPipelineEnabled,
  assertConfiguration = () => assertProductionConfiguration('worker'),
  resolvePool = getPostgresPool,
  closePool = closePostgresPool,
  createRuntime = createAiListingRuntime,
  processRef = process,
  logger = console,
} = {}) {
  if (!enabled()) {
    logger.log('[ai-worker] disabled by configuration');
    return { stop: async () => {}, done: Promise.resolve(0) };
  }
  assertConfiguration();
  processRef.env.POSTGRES_POOL_MAX ||= '4';
  processRef.env.OMP_THREAD_LIMIT ||= '1';
  sharp.concurrency(1);
  sharp.cache({ memory: 32, files: 0, items: 20 });
  let client;
  let runtime;
  let locked = false;
  let connectionLost = false;
  let stopping;
  let failed = false;
  let finish;
  const done = new Promise(resolve => { finish = resolve; });

  function stop(error) {
    if (error) {
      failed = true;
      processRef.exitCode = 1;
    }
    if (stopping) return stopping;
    stopping = (async () => {
      try {
        // stop() closes admission synchronously, then drains in-flight work.
        await runtime?.stop();
      } catch {
        failed = true;
      } finally {
        try {
          if (locked && !connectionLost) {
            const result = await client.query('SELECT pg_advisory_unlock(hashtext($1)) AS unlocked', [LOCK_KEY]);
            if (result.rows[0]?.unlocked !== true) throw new Error('AI worker lock was lost');
          }
        } catch {
          failed = true;
          connectionLost = true;
        }
        client?.removeListener('error', onConnectionLost);
        client?.removeListener('end', onConnectionLost);
        client?.release(connectionLost);
        try { await closePool(); } catch { failed = true; }
        processRef.removeListener('SIGINT', onSignal);
        processRef.removeListener('SIGTERM', onSignal);
        if (failed) processRef.exitCode = 1;
        finish(failed ? 1 : 0);
      }
    })();
    return stopping;
  }
  const onSignal = () => { void stop(); };
  const onConnectionLost = () => {
    connectionLost = true;
    logger.error('[ai-worker] lock connection lost; draining and exiting');
    void stop(new Error('AI worker lock connection lost'));
  };

  try {
    const pool = await resolvePool();
    client = await pool.connect();
    client.on('error', onConnectionLost);
    client.on('end', onConnectionLost);
    const result = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [LOCK_KEY]);
    locked = result.rows[0]?.locked === true;
    if (!locked) throw Object.assign(new Error('AI 图片 Worker 已运行'), { code: 'AI_LISTING_WORKER_ALREADY_RUNNING' });
    if (connectionLost) throw new Error('AI worker lock connection lost');
    runtime = createRuntime();
    processRef.on('SIGINT', onSignal);
    processRef.on('SIGTERM', onSignal);
    await runtime.start({ mode: 'worker' });
    if (!stopping) logger.log('[ai-worker] started');
    return { stop, done };
  } catch (error) {
    await stop(error);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const worker = await startAiListingWorker();
    process.exitCode = await worker.done;
  } catch (error) {
    console.error('[ai-worker] startup failed', { code: error?.code || 'AI_LISTING_WORKER_START_FAILED' });
    process.exitCode = 1;
  }
}
