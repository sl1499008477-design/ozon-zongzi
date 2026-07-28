import axios from 'axios';
import {
    getSonliApiBase,
    getSonliToken,
    sonliRequest,
} from '../services/sonli-api.services.js';

// 保留恢复代码的默认 request 导出，但唯一目标固定为 sonli 原生 API。
export default function request(config) {
    return sonliRequest(config);
}

export async function downloadFile(params) {
    const base = new URL(getSonliApiBase());
    const target = new URL(String(params.url || ''), base);
    if (target.origin !== base.origin || !target.pathname.startsWith('/local/files/'))
        throw new Error('仅允许下载 sonli 文件服务中的文件');
    return axios({
        url: target.toString(),
        method: params.method || 'get',
        responseType: params.responseType || 'arraybuffer',
        timeout: 30000,
        headers: {
            Authorization: `Bearer ${getSonliToken()}`,
            Accept: 'application/octet-stream',
        },
    });
}
