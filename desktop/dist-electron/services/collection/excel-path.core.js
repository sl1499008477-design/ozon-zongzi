import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';

const MAX_EXCEL_PATH_LENGTH = 2048;
const MAX_TASK_ID_LENGTH = 120;
const MAX_DISPLAY_SLUG_LENGTH = 80;

function sanitizeFilePart(value, fallback, maxLength) {
    const normalized = String(value || '')
        .normalize('NFKC')
        .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, '_')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^[._-]+|[._-]+$/g, '')
        .slice(0, maxLength);
    return normalized || fallback;
}

function assertInside(root, target) {
    const scoped = relative(root, target);
    if (!scoped || scoped.startsWith('..') || isAbsolute(scoped))
        throw new Error('Excel 文件必须位于受控目录内');
}

export function getExcelRoot(userDataPath) {
    const userData = String(userDataPath || '').trim();
    if (!userData)
        throw new Error('缺少桌面端 userData 目录');
    return resolve(userData, 'excel');
}

export function buildTaskExcelPath(userDataPath, taskId, displayName) {
    const id = sanitizeFilePart(taskId, '', MAX_TASK_ID_LENGTH);
    if (!id)
        throw new Error('生成 Excel 文件需要可信任务 ID');
    const slug = sanitizeFilePart(displayName, 'task', MAX_DISPLAY_SLUG_LENGTH);
    return assertManagedExcelPath(userDataPath, `${id}_${slug}.xlsx`);
}

export function assertManagedExcelPath(userDataPath, candidate) {
    const value = String(candidate || '').trim();
    if (!value || value.length > MAX_EXCEL_PATH_LENGTH || value.includes('\0'))
        throw new Error('Excel 文件路径无效');
    if (/%(?:00|2e|2f|5c)/i.test(value))
        throw new Error('Excel 文件路径不得包含编码后的路径控制字符');
    const root = getExcelRoot(userDataPath);
    if (existsSync(root) && lstatSync(root).isSymbolicLink())
        throw new Error('Excel 受控目录不得为符号链接');
    const target = resolve(root, value);
    assertInside(root, target);
    if (extname(target) !== '.xlsx')
        throw new Error('只允许访问 .xlsx Excel 文件');
    return target;
}

export function assertExistingManagedExcelFile(userDataPath, candidate) {
    const root = getExcelRoot(userDataPath);
    const target = assertManagedExcelPath(userDataPath, candidate);
    const stat = lstatSync(target);
    if (stat.isSymbolicLink())
        throw new Error('Excel 文件不得为符号链接');
    if (!stat.isFile())
        throw new Error('Excel 路径必须指向普通文件');
    const realTarget = realpathSync(target);
    const realRoot = realpathSync(root);
    assertInside(realRoot, realTarget);
    return target;
}

export function assertTaskOwnsManagedExcelFile(userDataPath, taskId, candidate) {
    const id = sanitizeFilePart(taskId, '', MAX_TASK_ID_LENGTH);
    if (!id)
        throw new Error('校验 Excel 文件需要可信任务 ID');
    const target = assertExistingManagedExcelFile(userDataPath, candidate);
    if (!basename(target).startsWith(`${id}_`))
        throw new Error('Excel 文件与请求任务不匹配');
    return target;
}

export function normalizeExcelDownloadRequest(payload) {
    if (typeof payload === 'string') {
        const filePath = payload.trim();
        if (!filePath || filePath.length > MAX_EXCEL_PATH_LENGTH)
            throw new Error('Excel 下载路径无效');
        return { filePath };
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        throw new Error('Excel 下载请求格式无效');
    const taskId = String(payload.taskId || '').trim();
    if (taskId) {
        if (taskId.length > MAX_TASK_ID_LENGTH)
            throw new Error('Excel 下载请求缺少有效任务 ID');
        return { taskId };
    }
    const filePath = String(payload.filePath || '').trim();
    if (filePath) {
        if (filePath.length > MAX_EXCEL_PATH_LENGTH)
            throw new Error('Excel 下载路径无效');
        return { filePath };
    }
    throw new Error('Excel 下载请求缺少有效任务 ID');
}
