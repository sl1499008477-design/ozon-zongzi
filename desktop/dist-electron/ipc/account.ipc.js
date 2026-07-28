import { ipcMain } from 'electron';
import { accountHandle, getUserInfo, login, logout } from '../services/account.services.js';
export const accountIpc = (win) => {
    ipcMain.on('account', (event, args) => {
        accountHandle(args, win);
    });
    ipcMain.handle('login', async (event, data) => {
        return await login(data);
    });
    ipcMain.handle('getUserInfo', async (event, data) => {
        return await getUserInfo(data);
    });
    ipcMain.handle('logout', async (event, data) => {
        return await logout();
    });
};
