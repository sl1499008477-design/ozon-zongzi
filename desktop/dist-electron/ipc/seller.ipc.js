import { ipcMain } from 'electron';
import {
    fetchSellerLeaderboard,
    fetchSellerSkuAnalytics,
    getSellerSessionStatus,
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
    ipcMain.handle('seller-open-login', ipcResult(() => openSellerLoginWindow()));
    ipcMain.handle('seller-session-status', ipcResult((data) => getSellerSessionStatus(data)));
    ipcMain.handle('seller-verify-store', ipcResult(() => verifyCurrentSellerStore()));
    ipcMain.handle('seller-analytics-sku', ipcResult((data) => fetchSellerSkuAnalytics(data.sku, data)));
    ipcMain.handle('seller-analytics-leaderboard', ipcResult((data) => fetchSellerLeaderboard(data)));
};
