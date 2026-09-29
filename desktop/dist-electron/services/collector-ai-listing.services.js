import { shell } from 'electron';
import { prepareCollectorAiListing, startCollectorRunAiListing, getCollectorCapabilities, getCollectorRun,
    latestCollectorRunId, retryCollectorRunHandoff } from './collector-backend.services.js';
import { runtimeConfig } from '../config/runtime.js';

export function describeCollectorHandoff(handoff) {
    const status = handoff?.status || 'UNKNOWN';
    const incomplete = ['FAILED', 'PARTIAL', 'UNKNOWN'].includes(status);
    const message = ['PENDING', 'PROCESSING'].includes(status)
        ? '采集完成，后台正在发送 AI 上架；关闭助手后服务器仍会继续，可在任务中心查看'
        : `${incomplete ? '后台交接尚未全部完成' : '后台交接完成'}：新建 ${Number(handoff?.created || 0)}，复用 ${Number(handoff?.reused || 0)}，阻断 ${Number(handoff?.blocked || 0)}${incomplete ? '；请查看原因后使用“发送至 AI 上架”补发' : ''}`;
    return { code: incomplete ? 207 : 200, message,
        data: { handoff, aiListingBatches: [], aiTaskUrl: `${runtimeConfig.sonliWebBase}/ozon/tools/ai-listing?tab=tasks` } };
}

// Manual and completion-triggered handoffs share the same result and browser behavior.
export async function sendCollectorResultsToAiListing(payload = {}) {
    try {
        // A manual all-results resend schedules only the server's durable remainder. Targeted selections keep their original semantics.
        if (payload.allQualified && !payload.itemIds?.length && !payload.sourceKeys?.length
            && (await getCollectorCapabilities()).durableHandoff === true) {
            const runId = payload.runId || await latestCollectorRunId(payload.taskId);
            const run = await getCollectorRun(runId);
            const options = run?.configurationSnapshot?.configuration || {};
            if (run.status === 'COMPLETED' && run.handoff && options.autoSendToAiListing === true && options.autoStartAiGeneration === true) {
                const response = await retryCollectorRunHandoff(runId);
                const result = describeCollectorHandoff(response?.run?.handoff || response?.handoff);
                try { await shell.openExternal(result.data.aiTaskUrl); }
                catch { result.code = 207; result.message += '；请手动打开 AI 上架任务中心'; }
                return result;
            }
        }
        const result = await prepareCollectorAiListing(payload);
        const batches = result.aiListingBatches;
        const count = batches.reduce((sum, batch) => sum + batch.count, 0);
        if (!count) return { code: 422, message: result.errors[0]?.message || '没有可发送至 AI 上架的商品', data: result };
        let generation;
        try { generation = await startCollectorRunAiListing(result, { manual: payload.manual === true }); }
        catch (error) {
            return { code: 207, message: `${count} 个商品已准备好，但未能核对本次运行的自动生图配置：${error?.message || error}；可稍后手动补发`, data: result };
        }
        Object.assign(result, generation);
        if (result.aiGenerationRequested) {
            const failed = result.aiStartErrors.length;
            let message = `${count} 个商品已准备好，新建 ${result.aiCreatedTaskIds.length} 个 AI 任务，复用 ${result.aiReusedTaskIds.length} 个已有任务${failed ? `，${failed} 个商品待核对或补发` : ''}；新 SKU 按本次保存的配置执行，已有任务保留原状态`;
            try { await shell.openExternal(result.aiTaskUrl); }
            catch { result.browserOpenFailed = true; message += '；未能打开浏览器，请前往 AI 上架任务中心查看'; }
            return { code: result.ok && !failed && !result.browserOpenFailed ? 200 : 207, message, data: result };
        }
        if (batches.length === 1) {
            try {
                await shell.openExternal(batches[0].url);
            }
            catch {
                return {
                    code: 207,
                    message: `${count} 个商品已准备好，但未能自动打开浏览器；请点击批次打开 AI 上架页`,
                    data: { ...result, browserOpenFailed: true },
                };
            }
        }
        const incomplete = result.errors.length + result.missing.length;
        const message = `${count} 个商品已准备好${incomplete ? `，${incomplete} 个未成功` : ''}；`
            + (batches.length === 1 ? '已打开 AI 上架页，请使用店铺配置开始上架' : `请分 ${batches.length} 批打开 AI 上架页`);
        return { code: result.ok ? 200 : 207, message, data: result };
    }
    catch (error) {
        return { code: Number(error?.status || 500), message: error?.message || String(error), data: null };
    }
}
