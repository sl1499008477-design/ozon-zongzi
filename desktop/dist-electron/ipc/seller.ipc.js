import { ipcMain } from 'electron';
import { TaskManager } from '../services/collection/task-manager.services.js';
import { enrichmentWorker } from '../services/enrichment.services.js';
import {
    fetchSellerLeaderboard,
    fetchSellerSkuAnalytics,
    getSellerSessionStatus,
    syncSellerRoute,
    acquireSellerRoute,
    openSellerLoginWindow,
    verifyCurrentSellerStore,
} from '../services/seller-ozon.services.js';

function ipcResult(action) {
    return async (_event, data = {}) => {
        try {
            return { code: 200, message: 'success', data: await action(data) };
        }
        catch (error) {
            return {
                code: Number(error?.status || 500),
                message: error?.message || String(error),
                errorCode: error?.code || 'SELLER_OPERATION_FAILED',
                data: null,
            };
        }
    };
}

export const sellerIpc = () => {
    const routeOptions = () => ({ busy: TaskManager.getInstance().hasActiveWork() || enrichmentWorker.isBusy() });
    const standaloneRead = action => ipcResult(async data => {
        const lease = await acquireSellerRoute();
        try { return await action(data); }
        finally { lease.release(); }
    });
    ipcMain.handle('seller-route-status', ipcResult(() => syncSellerRoute(routeOptions())));
    ipcMain.handle('enrichment-status', () => enrichmentWorker.getStatus());
    ipcMain.handle('enrichment-tasks', ipcResult(() => enrichmentWorker.listTasks()));
    ipcMain.handle('enrichment-task-control', ipcResult(data => enrichmentWorker.controlTask(data)));
    ipcMain.handle('enrichment-resume', () => { void enrichmentWorker.resume(); return enrichmentWorker.getStatus(); });
    ipcMain.handle('seller-open-login', ipcResult(async () => {
        await syncSellerRoute(routeOptions());
        return openSellerLoginWindow();
    }));
    ipcMain.handle('seller-session-status', ipcResult(async data => {
        await syncSellerRoute(routeOptions());
        return getSellerSessionStatus(data);
    }));
    ipcMain.handle('seller-verify-store', standaloneRead(() => verifyCurrentSellerStore()));
    ipcMain.handle('seller-analytics-sku', standaloneRead((data) => fetchSellerSkuAnalytics(data.sku, data)));
    ipcMain.handle('seller-analytics-leaderboard', standaloneRead((data) => fetchSellerLeaderboard(data)));
};
