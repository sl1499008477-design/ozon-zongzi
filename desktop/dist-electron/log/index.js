import log from 'electron-log';
import os from 'os';
import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { SysTemUtils } from '../utils/system.js';
/**
 * 日志管理器类
 */
class LoggerManager {
    static instance;
    installDir;
    logPath;
    constructor() {
        this.installDir = app.getPath('userData');
        this.logPath = path.join(this.installDir, 'logs');
    }
    /**
     * 获取单例实例
     */
    static getInstance() {
        if (!LoggerManager.instance) {
            LoggerManager.instance = new LoggerManager();
        }
        return LoggerManager.instance;
    }
    /**
     * 初始化日志系统
     */
    initLogger() {
        // 确保日志目录存在
        this.ensureLogDirectoryExists();
        // 清理旧日志文件，只保留最近5天的日志
        this.cleanupOldLogs();
        // 主进程日志配置
        this.configureFileTransport();
        // 控制台日志配置
        this.configureConsoleTransport();
        // 设置异常处理器
        this.setupErrorHandler();
        // 捕获未处理的 Promise 拒绝
        this.setupUnhandledRejectionHandler();
        // 记录启动信息
        this.logStartupInfo();
        return log;
    }
    /**
     * 确保日志目录存在
     */
    ensureLogDirectoryExists() {
        if (!fs.existsSync(this.logPath)) {
            fs.mkdirSync(this.logPath, { recursive: true });
        }
    }
    /**
     * 配置文件传输
     */
    configureFileTransport() {
        log.transports.file.level = 'info';
        log.transports.file.maxSize = 10 * 1024 * 1024; // 10MB
        log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';
        log.transports.file.resolvePathFn = () => {
            // 按日期生成日志文件名
            const date = new Date();
            const fileName = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}.log`;
            return path.join(this.logPath, fileName);
        };
    }
    /**
     * 配置控制台传输
     */
    configureConsoleTransport() {
        log.transports.console.level = SysTemUtils.getEnv() === 'development' ? 'debug' : 'info';
        log.transports.console.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';
    }
    /**
     * 设置异常处理器
     */
    setupErrorHandler() {
        log.errorHandler.startCatching({
            showDialog: false,
            onError: (error) => {
                log.error('未捕获的异常:', error);
            },
        });
    }
    /**
     * 设置未处理的 Promise 拒绝处理器
     */
    setupUnhandledRejectionHandler() {
        process.on('unhandledRejection', (reason, promise) => {
            log.error('未处理的 Promise 拒绝:', reason);
        });
    }
    /**
     * 记录启动信息
     */
    logStartupInfo() {
        log.info('='.repeat(80));
        log.info('应用启动');
        log.info(`版本: ${app.getVersion()}`);
        log.info(`Electron: ${process.versions.electron}`);
        log.info(`Node: ${process.versions.node}`);
        log.info(`平台: ${process.platform}`);
        log.info(`架构: ${process.arch}`);
        log.info(`工作目录: ${process.cwd()}`);
        log.info(`安装目录: ${this.installDir}`);
        log.info(`日志目录: ${this.logPath}`);
        log.info(`环境: ${SysTemUtils.getEnv() || 'production'}`);
        log.info('='.repeat(80));
        log.info('设备信息');
        log.info(`主机名: ${os.hostname()}`);
        log.info(`系统类型: ${os.type()}`);
        log.info(`系统平台: ${os.platform()}`);
        log.info(`系统版本: ${os.release()}`);
        log.info(`CPU架构: ${os.arch()}`);
        log.info(`CPU型号: ${os.cpus()[0]?.model}`);
        log.info(`CPU核心数: ${os.cpus().length}`);
        log.info(`总内存: ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(2)} GB`);
        log.info(`空闲内存: ${(os.freemem() / 1024 / 1024 / 1024).toFixed(2)} GB`);
        log.info(`用户目录: ${os.homedir()}`);
        log.info(`临时目录: ${os.tmpdir()}`);
        log.info('='.repeat(80));
    }
    /**
     * 清理超过5天的日志文件
     */
    cleanupOldLogs() {
        try {
            const files = fs.readdirSync(this.logPath);
            // 提取日期并排序
            const logFilesWithDate = files
                .filter((file) => /^\d{4}-\d{2}-\d{2}\.log$/.test(file)) // 匹配 YYYY-MM-DD.log 格式
                .map((file) => {
                const dateStr = file.split('.')[0]; // 移除 .log 后缀
                return {
                    file,
                    date: new Date(dateStr),
                    fullPath: path.join(this.logPath, file),
                };
            })
                .sort((a, b) => b.date.getTime() - a.date.getTime()); // 按日期降序排列
            // 删除超过5天的旧日志
            for (let i = 5; i < logFilesWithDate.length; i++) {
                fs.unlinkSync(logFilesWithDate[i].fullPath);
                console.log(`删除旧日志文件: ${logFilesWithDate[i].file}`);
            }
        }
        catch (error) {
            console.error('清理旧日志文件时出错:', error);
        }
    }
}
/**
 * 初始化日志系统
 */
export function initLogger() {
    const loggerManager = LoggerManager.getInstance();
    return loggerManager.initLogger();
}
export default log;
