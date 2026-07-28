import { accountIpc } from './account.ipc.js';
import { storeIpc } from './store.ipc.js';
import { windowIpc } from './system.ipc.js';
import { collectionIpc } from './collection.ipc.js';
import { registerLogIpc } from './log.ipc.js';
import { globalBroadcast } from './broadcast.js';
import { sellerIpc } from './seller.ipc.js';
export const resisterAllIpc = (win) => {
    accountIpc(win);
    storeIpc();
    windowIpc(win);
    collectionIpc(win);
    sellerIpc();
    registerLogIpc();
    globalBroadcast.registerWindow(win);
    setTimeout(() => {
        globalBroadcast.broadcast('connect', '广播连接状态测试');
    }, 2000);
};
