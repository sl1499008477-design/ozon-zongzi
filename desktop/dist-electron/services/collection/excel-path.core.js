import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';

const MAX_EXCEL_PATH_LENGTH = 2048;
const MAX_TASK_ID_BYTES = 96;
const MAX_DISPLAY_SLUG_LENGTH = 80;
const MAX_EXCEL_FILENAME_BYTES = 240;

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

function truncateUtf8(value, maxBytes) {
    let result = '';
    let size = 0;
    for (const character of value) {
        const characterSize = Buffer.byteLength(character, 'utf8');
        if (size + characterSize > maxBytes)
            break;
        result += character;
        size += characterSize;
    }
    return result;
}

function hasUnpairedSurrogate(value) {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff))
                return true;
            index += 1;
        }
        else if (code >= 0xdc00 && code <= 0xdfff) {
            return true;
        }
    }
    return false;
}

function normalizeTaskId(value) {
    const id = String(value || '').trim();
    if (!id
        || Buffer.byteLength(id, 'utf8') > MAX_TASK_ID_BYTES
        || /[\u0000-\u001f\u007f]/.test(id)
        || hasUnpairedSurrogate(id)) {
        throw new Error('任务 ID 无效');
    }
    return id;
}

export function taskIdFilenameSegment(taskId) {
    const id = normalizeTaskId(taskId);
    const bytes = Buffer.from(id, 'utf8');
    return `id${bytes.length}_${bytes.toString('hex')}`;
}

export function getExcelRoot(userDataPath) {
    const userData = String(userDataPath || '').trim();
    if (!userData)
        throw new Error('缺少桌面端 userData 目录');
    return resolve(userData, 'excel');
}

export function buildTaskExcelPath(userDataPath, taskId, displayName) {
    const id = taskIdFilenameSegment(taskId);
    const slugLimit = MAX_EXCEL_FILENAME_BYTES - Buffer.byteLength(`${id}--.xlsx`, 'utf8');
    const slug = truncateUtf8(
        sanitizeFilePart(displayName, 'task', MAX_DISPLAY_SLUG_LENGTH),
        slugLimit,
    );
    return assertManagedExcelPath(userDataPath, `${id}--${slug}.xlsx`);
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
    const id = taskIdFilenameSegment(taskId);
    const target = assertExistingManagedExcelFile(userDataPath, candidate);
    const fileName = basename(target, '.xlsx');
    const separator = fileName.indexOf('--');
    if (separator < 0 || fileName.slice(0, separator) !== id)
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
    const rawTaskId = String(payload.taskId || '').trim();
    if (rawTaskId)
        return { taskId: normalizeTaskId(rawTaskId) };
    const filePath = String(payload.filePath || '').trim();
    if (filePath) {
        if (filePath.length > MAX_EXCEL_PATH_LENGTH)
            throw new Error('Excel 下载路径无效');
        return { filePath };
    }
    throw new Error('Excel 下载请求缺少有效任务 ID');
}
