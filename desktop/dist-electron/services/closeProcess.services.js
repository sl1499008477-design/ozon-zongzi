import { TaskManager } from './collection/task-manager.services.js';
import { operationStore } from '../store/index.js';
export class CloseProcessService {
    // 关闭应用时将所有在执行等待执行的任务状态变更为取消
    async closeTask() {
        await TaskManager.getInstance().stopAllTasks();
    }
    async deleteFolder() {
        // 采集结果属于用户数据。退出应用时保留 Excel，改由用户显式删除任务时清理。
        return true;
    }
    async run() {
        const token = operationStore.get('token');
        operationStore.set('is-execute-close', true);
        if (!token)
            return;
        await this.closeTask();
    }
}
