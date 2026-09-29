import { listCollectorRunDuplicateEvents } from './collector-backend.services.js';
import { runtimeConfig } from '../config/runtime.js';

// Read the selected run only. A newer run must not replace the user's selection.
export async function readCollectorDuplicates({ runId } = {}) {
    runId = String(runId || '').trim();
    if (!runId) throw Object.assign(new Error('该任务还没有可查看的运行记录'), { status: 422 });
    const items = new Map();
    let afterId = 0;
    while (true) {
        const events = await listCollectorRunDuplicateEvents(runId, afterId);
        for (const event of events) {
            for (const item of Array.isArray(event.payload?.items) ? event.payload.items : []) {
                if (!item?.sku || !['COLLECTED', 'LISTED', 'COLLECTING'].includes(item.state)) continue;
                items.set(String(item.sku), {
                    sku: String(item.sku), state: item.state,
                    ...Object.fromEntries(['collectItemId', 'collectorItemId', 'listingTaskId', 'submissionJobId',
                        ...(item.taskId && item.runId ? ['taskId', 'runId', 'taskName'] : [])]
                        .filter(key => item[key]).map(key => [key, String(item[key])])),
                });
            }
        }
        if (events.length < 500) break;
        const nextId = Number(events.at(-1)?.id);
        if (!Number.isSafeInteger(nextId) || nextId <= afterId)
            throw new Error('读取跳过商品失败，请重新打开查看');
        afterId = nextId;
    }
    // CollectPage has no SKU/id query filter; do not invent one or trigger collection.
    return { runId, items: [...items.values()],
        collectBoxUrl: new URL('/ozon/products/collect', `${runtimeConfig.sonliWebBase}/`).toString(),
        listingHistoryUrl: new URL('/ozon/products/import-history', `${runtimeConfig.sonliWebBase}/`).toString(),
    };
}
