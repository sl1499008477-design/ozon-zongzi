import { app } from 'electron';
import log from '../log/index.js';
/**
 * 内存监控服务
 * 用于追踪业务内存使用情况，帮助定位内存占用问题
 */
export class MemoryMonitorService {
    static instance;
    interval = null;
    isRunning = false;
    // 内存历史记录（最多保留最近 100 条）
    memoryHistory = [];
    // 内存阈值配置
    thresholds = {
        heap: 800, // 堆内存阈值 (MB)
        rss: 1200, // 常驻内存阈值 (MB)
        external: 300, // 外部内存阈值 (MB)
    };
    constructor() { }
    static getInstance() {
        if (!MemoryMonitorService.instance) {
            MemoryMonitorService.instance = new MemoryMonitorService();
        }
        return MemoryMonitorService.instance;
    }
    /**
     * 启动内存监控
     * @param intervalMs 监控间隔（毫秒），默认 30 秒
     */
    start(intervalMs = 30000) {
        if (this.isRunning) {
            log.warn('[MemoryMonitor] 监控已在运行中');
            return;
        }
        log.info('[MemoryMonitor] 启动内存监控');
        this.isRunning = true;
        // 立即执行一次
        this.checkMemory();
        // 定时执行
        this.interval = setInterval(() => {
            this.checkMemory();
        }, intervalMs);
    }
    /**
     * 停止内存监控
     */
    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
            this.isRunning = false;
            log.info('[MemoryMonitor] 停止内存监控');
        }
    }
    /**
     * 检查内存使用情况（核心方法）
     */
    checkMemory() {
        try {
            // 获取 Node.js 进程内存
            const usage = process.memoryUsage();
            const heapUsedMB = usage.heapUsed / 1024 / 1024;
            const heapTotalMB = usage.heapTotal / 1024 / 1024;
            const rssMB = usage.rss / 1024 / 1024;
            const externalMB = usage.external / 1024 / 1024;
            // 记录历史
            this.memoryHistory.push({
                timestamp: Date.now(),
                heapUsed: heapUsedMB,
                heapTotal: heapTotalMB,
                rss: rssMB,
                external: externalMB,
            });
            // 限制历史记录数量
            if (this.memoryHistory.length > 100) {
                this.memoryHistory.shift();
            }
            // 输出日志
            log.info(`[MemoryMonitor] Heap: ${heapUsedMB.toFixed(2)}/${heapTotalMB.toFixed(2)}MB | ` +
                `RSS: ${rssMB.toFixed(2)}MB | ` +
                `External: ${externalMB.toFixed(2)}MB`);
            // 获取所有 Electron 进程信息
            this.checkElectronProcesses();
            // 检查阈值并触发警告
            this.checkThresholds(heapUsedMB, rssMB, externalMB);
        }
        catch (error) {
            log.error('[MemoryMonitor] 检查内存失败', error);
        }
    }
    /**
     * 检查 Electron 所有进程的内存使用
     */
    checkElectronProcesses() {
        try {
            const metrics = app.getAppMetrics();
            const totalMemoryKB = metrics.reduce((sum, m) => {
                return sum + (m.memory?.workingSetSize || 0);
            }, 0);
            const totalMemoryMB = totalMemoryKB / 1024;
            log.info(`[MemoryMonitor] Electron 进程数: ${metrics.length}, ` +
                `总内存: ${totalMemoryMB.toFixed(2)}MB`);
            // 详细进程信息（可选）
            metrics.forEach((m) => {
                const memMB = (m.memory?.workingSetSize || 0) / 1024;
                if (memMB > 50) {
                    // 只记录超过 50MB 的进程
                    log.info(`  - PID ${m.pid} [${m.type}]: ${memMB.toFixed(2)}MB ` +
                        `(CPU: ${m.cpu.percentCPUUsage.toFixed(1)}%)`);
                }
            });
        }
        catch (error) {
            log.error('[MemoryMonitor] 获取进程信息失败', error);
        }
    }
    /**
     * 检查内存阈值并触发警告
     */
    checkThresholds(heapUsed, rss, external) {
        const warnings = [];
        if (heapUsed > this.thresholds.heap) {
            warnings.push(`堆内存过高: ${heapUsed.toFixed(2)}MB (阈值: ${this.thresholds.heap}MB)`);
        }
        if (rss > this.thresholds.rss) {
            warnings.push(`常驻内存过高: ${rss.toFixed(2)}MB (阈值: ${this.thresholds.rss}MB)`);
        }
        if (external > this.thresholds.external) {
            warnings.push(`外部内存过高: ${external.toFixed(2)}MB (阈值: ${this.thresholds.external}MB)`);
        }
        if (warnings.length > 0) {
            log.warn(`⚠️ [MemoryMonitor] 内存警告:\n  - ${warnings.join('\n  - ')}`);
            // 尝试触发垃圾回收
            this.triggerGC();
        }
    }
    /**
     * 触发垃圾回收（需要 --expose-gc 启动）
     */
    triggerGC() {
        if (global.gc) {
            log.info('[MemoryMonitor] 触发手动 GC');
            const before = process.memoryUsage().heapUsed / 1024 / 1024;
            global.gc();
            // 等待 GC 完成后记录
            setTimeout(() => {
                const after = process.memoryUsage().heapUsed / 1024 / 1024;
                const freed = before - after;
                log.info(`[MemoryMonitor] GC 完成，释放: ${freed > 0 ? freed.toFixed(2) : 0}MB ` +
                    `(${before.toFixed(2)}MB → ${after.toFixed(2)}MB)`);
            }, 100);
        }
        else {
            log.warn('[MemoryMonitor] GC 未启用，请使用 --expose-gc 启动应用');
        }
    }
    /**
     * 获取当前内存快照
     */
    getCurrentMemory() {
        const usage = process.memoryUsage();
        return {
            heapUsed: (usage.heapUsed / 1024 / 1024).toFixed(2) + 'MB',
            heapTotal: (usage.heapTotal / 1024 / 1024).toFixed(2) + 'MB',
            rss: (usage.rss / 1024 / 1024).toFixed(2) + 'MB',
            external: (usage.external / 1024 / 1024).toFixed(2) + 'MB',
            arrayBuffers: (usage.arrayBuffers / 1024 / 1024).toFixed(2) + 'MB',
        };
    }
    /**
     * 获取内存增长趋势
     */
    getMemoryTrend() {
        if (this.memoryHistory.length < 2) {
            return null;
        }
        const first = this.memoryHistory[0];
        const last = this.memoryHistory[this.memoryHistory.length - 1];
        const duration = (last.timestamp - first.timestamp) / 1000 / 60; // 分钟
        return {
            duration: `${duration.toFixed(1)} 分钟`,
            heapGrowth: `${(last.heapUsed - first.heapUsed).toFixed(2)}MB`,
            rssGrowth: `${(last.rss - first.rss).toFixed(2)}MB`,
            externalGrowth: `${(last.external - first.external).toFixed(2)}MB`,
            samples: this.memoryHistory.length,
            avgHeap: `${(this.memoryHistory.reduce((sum, h) => sum + h.heapUsed, 0) / this.memoryHistory.length).toFixed(2)}MB`,
        };
    }
    /**
     * 生成内存报告
     */
    generateReport() {
        const current = this.getCurrentMemory();
        const trend = this.getMemoryTrend();
        const report = {
            timestamp: new Date().toLocaleString('zh-CN'),
            current,
            trend,
            thresholds: this.thresholds,
            history: this.memoryHistory.slice(-10), // 最近 10 条记录
        };
        log.info('[MemoryMonitor] 内存报告:', JSON.stringify(report, null, 2));
        return report;
    }
    /**
     * 追踪业务指标（供业务代码调用）
     * @param metrics 业务指标对象
     */
    trackBusinessMetrics(metrics) {
        const items = Object.entries(metrics)
            .filter(([_, v]) => v !== undefined)
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ');
        log.info(`[MemoryMonitor] 业务指标 - ${items}`);
    }
    /**
     * 设置内存阈值
     */
    setThresholds(thresholds) {
        this.thresholds = { ...this.thresholds, ...thresholds };
        log.info('[MemoryMonitor] 更新内存阈值:', this.thresholds);
    }
    /**
     * 清空历史记录
     */
    clearHistory() {
        this.memoryHistory = [];
        log.info('[MemoryMonitor] 清空历史记录');
    }
    /**
     * 手动触发内存检查（供外部调用）
     */
    manualCheck() {
        log.info('[MemoryMonitor] 手动触发内存检查');
        this.checkMemory();
    }
    /**
     * 强制执行 GC（供外部调用）
     */
    forceGC() {
        this.triggerGC();
    }
}
// 导出单例
export const memoryMonitor = MemoryMonitorService.getInstance();
