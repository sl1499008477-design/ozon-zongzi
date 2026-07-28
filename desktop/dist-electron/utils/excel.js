import ExcelJS from 'exceljs';
import { promises as fsPromises } from 'fs';
import { dirname } from 'path';
import log from '../log/index.js';
import sharp from 'sharp';

const IMAGE_HOST_SUFFIXES = [
    'ozon.ru',
    'ozone.ru',
    '1688.com',
    'alibaba.com',
    'alicdn.com',
];
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function assertTrustedImageUrl(value) {
    const url = new URL(String(value || ''));
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    if (url.protocol !== 'https:'
        || !IMAGE_HOST_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))) {
        throw new Error('图片地址不是受信任的 Ozon/1688 HTTPS 资源');
    }
    return url;
}

async function downloadTrustedImage(value) {
    let target = assertTrustedImageUrl(value);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
        for (let redirect = 0; redirect <= 3; redirect += 1) {
            const response = await fetch(target, {
                signal: controller.signal,
                redirect: 'manual',
            });
            if (response.status >= 300 && response.status < 400) {
                const location = response.headers.get('location');
                if (!location || redirect === 3)
                    throw new Error('图片重定向无效或次数过多');
                target = assertTrustedImageUrl(new URL(location, target).toString());
                continue;
            }
            if (!response.ok)
                throw new Error(`图片下载失败：HTTP ${response.status}`);
            if (!/^image\/(?:png|jpe?g|gif|webp)(?:;|$)/i.test(response.headers.get('content-type') || ''))
                throw new Error('图片响应类型无效');
            const declaredLength = Number(response.headers.get('content-length') || 0);
            if (declaredLength > MAX_IMAGE_BYTES)
                throw new Error('图片超过 8MB 限制');
            const chunks = [];
            let size = 0;
            for await (const chunk of response.body || []) {
                const buffer = Buffer.from(chunk);
                size += buffer.length;
                if (size > MAX_IMAGE_BYTES)
                    throw new Error('图片超过 8MB 限制');
                chunks.push(buffer);
            }
            if (!size)
                throw new Error('图片内容为空');
            return Buffer.concat(chunks);
        }
    }
    finally {
        clearTimeout(timer);
    }
    throw new Error('图片下载失败');
}

async function excelImageBuffer(value) {
    const input = await downloadTrustedImage(value);
    return sharp(input, {
        failOn: 'warning',
        limitInputPixels: 40_000_000,
        sequentialRead: true,
    }).png().toBuffer();
}

export class ExcelWriter {
    workbook;
    worksheet;
    filePath;
    sheetName;
    /** 是否已初始化加载过文件 */
    initialized = false;
    /** 是否正在写入磁盘 */
    saving = false;
    /** 内存写入队列（仅操作内存，不碰磁盘） */
    memoryQueue = Promise.resolve();
    constructor(filePath, sheetName = 'Sheet1') {
        this.filePath = filePath;
        this.sheetName = sheetName;
    }
    /**
     * 检查文件是否被其他进程占用
     */
    async isFileInUse(filePath) {
        try {
            // 尝试以写入模式打开文件
            const fileHandle = await fsPromises.open(filePath, 'r+');
            await fileHandle.close();
            return false; // 能够打开说明未被占用
        }
        catch (error) {
            const err = error;
            // 如果是 EBUSY 或 EPERM 错误，说明文件被占用
            if (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EBADF') {
                return true;
            }
            // 文件不存在不算被占用
            if (err.code === 'ENOENT') {
                return false;
            }
            // 其他错误也视为无法访问
            return true;
        }
    }
    /**
     * 初始化工作簿（只允许执行一次）
     * 应用生命周期内禁止重复 load
     */
    async init() {
        if (this.initialized)
            return;
        try {
            await fsPromises.access(this.filePath);
            this.workbook = new ExcelJS.Workbook();
            await this.workbook.xlsx.readFile(this.filePath);
            this.worksheet = this.workbook.getWorksheet(this.sheetName) || this.workbook.worksheets[0];
            if (!this.worksheet) {
                this.worksheet = this.workbook.addWorksheet(this.sheetName);
            }
        }
        catch {
            this.workbook = new ExcelJS.Workbook();
            this.worksheet = this.workbook.addWorksheet(this.sheetName);
        }
        this.initialized = true;
    }
    /**
     * 追加数据（仅写入内存，不写磁盘）
     * 该方法可高频调用，不会损坏文件
     */
    async appendRows(rows) {
        await this.init();
        this.memoryQueue = this.memoryQueue.then(async () => {
            for (const row of rows) {
                this.worksheet.addRow(row);
            }
        });
        return this.memoryQueue;
    }
    /**
     * 追加数据并立即保存到磁盘
     * @param rows 要追加的数据行
     * @returns 返回布尔值表示是否成功保存
     */
    async appendAndSave(rows) {
        await this.init();
        const savePromise = this.memoryQueue.then(async () => {
            const isInUse = await this.isFileInUse(this.filePath);
            if (isInUse) {
                log.warn(`文件 ${this.filePath} 被占用`);
                return false;
            }
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const rowObj = this.worksheet.addRow(row);
                const rowIndex = rowObj.number;
                try {
                    if (row.cover) {
                        const buffer = await excelImageBuffer(row.cover);
                        const imageId = this.workbook.addImage({
                            buffer,
                            extension: 'png',
                        });
                        rowObj.height = 80;
                        this.worksheet.getColumn(3).width = 15;
                        this.worksheet.addImage(imageId, {
                            tl: { col: 2, row: rowIndex - 1 },
                            br: { col: 3, row: rowIndex - 1 + 0.999 },
                            editAs: 'oneCell',
                        });
                        this.worksheet.getColumn(50).width = 15;
                        this.worksheet.addImage(imageId, {
                            tl: { col: 49, row: rowIndex - 1 },
                            br: { col: 50, row: rowIndex - 1 + 0.999 },
                            editAs: 'oneCell',
                        });
                    }
                    if (row.cover2) {
                        const convertedBuffer = await excelImageBuffer(row.cover2);
                        const imageId = this.workbook.addImage({
                            buffer: convertedBuffer,
                            extension: 'png',
                        });
                        rowObj.height = 80;
                        this.worksheet.getColumn(49).width = 15;
                        this.worksheet.addImage(imageId, {
                            tl: { col: 48, row: rowIndex - 1 },
                            br: { col: 49, row: rowIndex - 1 + 0.999 },
                            editAs: 'oneCell',
                        });
                    }
                    rowObj.eachCell((cell) => {
                        cell.alignment = {
                            vertical: 'middle',
                            horizontal: 'center',
                            wrapText: true,
                        };
                    });
                }
                catch (e) {
                    log.warn(`图片处理失败`, e);
                }
            }
            try {
                const dir = dirname(this.filePath);
                await fsPromises.mkdir(dir, {
                    recursive: true,
                });
                const tempPath = `${this.filePath}.tmp`;
                // 先写入临时文件
                await this.workbook.xlsx.writeFile(tempPath);
                // 删除旧文件（Windows 下 rename 覆盖容易 EPERM）
                try {
                    await fsPromises.unlink(this.filePath);
                }
                catch { }
                // 临时文件替换正式文件
                await fsPromises.rename(tempPath, this.filePath);
                return true;
            }
            catch (error) {
                log.error(`写入Excel失败`, error);
                return false;
            }
        });
        try {
            return await savePromise;
        }
        catch (error) {
            log.error(`保存Excel失败:`, error);
            return false;
        }
    }
    /**
     * 获取真实有效行数（不使用 rowCount）
     */
    getRealRowCount() {
        let count = 0;
        this.worksheet.eachRow((row) => {
            if (row.hasValues)
                count++;
        });
        return count;
    }
    /**
     * 安全写入磁盘
     * 只允许串行执行，避免并发损坏文件
     * @returns 返回布尔值表示是否成功保存
     */
    async flushToDisk() {
        await this.init();
        if (this.saving) {
            log.warn(`已有写盘任务进行中，跳过本次 flush`);
            return false;
        }
        this.saving = true;
        try {
            const dir = dirname(this.filePath);
            await fsPromises.mkdir(dir, { recursive: true });
            // 如果写入失败，检查是否被占用
            const writeResult = await this.writeFileWithProcessHandling(this.filePath);
            return writeResult;
        }
        finally {
            this.saving = false;
        }
    }
    /**
     * 尝试写入文件，如果被占用则返回false
     */
    async writeFileWithProcessHandling(filePath) {
        try {
            // 尝试直接写入
            await this.workbook.xlsx.writeFile(filePath);
            return true;
        }
        catch (error) {
            if (error.code === 'EBUSY' ||
                error.code === 'EPERM') {
                log.warn(`文件 ${filePath} 被占用，无法写入`);
                return false;
            }
            else {
                // 其他错误记录并抛出
                log.error(`写入Excel文件时发生错误:`, error);
                throw error;
            }
        }
    }
    /**
     * 设置列定义
     */
    setColumns(columns) {
        this.worksheet.columns = columns;
    }
    /**
     * 设置单元格值
     */
    setCellValue(row, col, value) {
        this.worksheet.getCell(row, col).value = value;
    }
    /**
     * 设置标题行样式
     */
    setTitleRowStyle(style = {}) {
        const titleRow = this.worksheet.getRow(1);
        if (style.font)
            titleRow.font = style.font;
        if (style.fill)
            titleRow.fill = style.fill;
        if (style.border)
            titleRow.border = style.border;
        titleRow.font = { ...(titleRow.font || {}), bold: true };
    }
    /**
     * 设置行的样式
     * @param rowNumber 行号
     * @param style 样式对象
     */
    setRowStyle(rowNumber, style) {
        const row = this.worksheet.getRow(rowNumber);
        if (style.font) {
            row.font = style.font;
        }
        if (style.fill) {
            row.fill = style.fill;
        }
        if (style.border) {
            row.border = style.border;
        }
        Object.keys(style).forEach((key) => {
            if (!['font', 'fill', 'border'].includes(key)) {
                ;
                row[key] = style[key];
            }
        });
    }
    /**
     * 自动调整列宽
     */
    autoFitColumns() {
        this.worksheet.columns.forEach((column) => {
            let max = 10;
            column.eachCell({ includeEmpty: true }, (cell) => {
                const len = cell.value ? String(cell.value).length : 10;
                if (len > max)
                    max = len;
            });
            column.width = Math.min(Math.max(max, 10), 50);
        });
    }
    /**
     * 合并单元格
     * @param range 合并范围，例如 'A1:B2'
     */
    mergeCells(range) {
        this.worksheet.mergeCells(range);
    }
    /**
     * 获取工作簿实例
     */
    getWorkbook() {
        return this.workbook;
    }
    /**
     * 获取工作表实例
     */
    getWorksheet() {
        return this.worksheet;
    }
    /**
     * 应用退出前调用，确保数据安全落盘
     */
    async dispose() {
        log.info(`应用退出，执行最终 Excel 落盘`);
        await this.flushToDisk();
    }
    /**
     * 设置特定单元格的样式
     * @param row 行号
     * @param col 列号或列名
     * @param style 样式对象
     */
    setCellStyle(row, col, style) {
        const cell = this.worksheet.getCell(row, col);
        if (style.font)
            cell.font = style.font;
        if (style.fill)
            cell.fill = style.fill;
        if (style.border)
            cell.border = style.border;
    }
    /**
     * 清空工作表内容（保留列定义）
     */
    clearContent() {
        log.info(`清空工作表内容（重建工作表）`);
        const sheetName = this.worksheet.name;
        const workbook = this.workbook;
        // 删除旧工作表
        workbook.removeWorksheet(this.worksheet.id);
        // 新建同名工作表
        this.worksheet = workbook.addWorksheet(sheetName);
    }
    /**
     * 检查文件是否可写入
     */
    async checkFileStatus() {
        let inUse = false;
        try {
            inUse = await this.isFileInUse(this.filePath);
        }
        catch (error) {
            log.warn(`检查文件状态失败:`, error);
        }
        return {
            writable: !inUse,
            inUse,
        };
    }
    /**
     * 获取表格文件路径
     */
    getFilePath() {
        return this.filePath;
    }
    reset(filePath) {
        this.workbook = new ExcelJS.Workbook();
        this.worksheet = this.workbook.addWorksheet(this.sheetName);
        this.initialized = true; // 已初始化，但用的是新 workbook
        this.saving = false;
        this.memoryQueue = Promise.resolve();
        if (filePath) {
            this.filePath = filePath;
        }
    }
}
