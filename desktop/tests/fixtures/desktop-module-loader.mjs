const stubs = {
  'electron-updater': `export default { autoUpdater: {} };`,
  electron: `
    import { EventEmitter } from 'node:events';
    const userData = process.env.DESKTOP_TEST_USER_DATA || process.cwd();
    export const app = {
      isPackaged: true,
      getPath: (name) => name === 'userData' ? userData : userData,
      getName: () => 'sonli-test',
      getVersion: () => '0.0.0-test',
      getAppPath: () => process.cwd(),
      getAppMetrics: () => [],
    };
    export class BrowserWindow extends EventEmitter {
      constructor() {
        super();
        this.webContents = Object.assign(new EventEmitter(), {
          send() {},
          setWindowOpenHandler() {},
          setUserAgent() {},
          executeJavaScript: async () => ({}),
        });
      }
      isDestroyed() { return Boolean(this.destroyed); }
      destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
      show() {}
      loadURL() { return Promise.resolve(); }
    }
    export const ipcMain = { handle(channel, handler) { (globalThis.__DESKTOP_IPC_HANDLERS__ ||= new Map()).set(channel, handler); }, on() {}, once() {}, removeAllListeners() {} };
    export const session = {
      fromPartition: () => ({
        cookies: { get: async () => [], remove: async () => {} },
        clearStorageData: async () => {},
      }),
    };
    export const safeStorage = {
      isEncryptionAvailable: () => false,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => Buffer.from(value).toString(),
    };
    export const dialog = {
      showSaveDialog: async () => process.env.DESKTOP_TEST_DIALOG_MODE === 'save'
        ? { canceled: false, filePath: process.env.DESKTOP_TEST_SAVE_PATH }
        : { canceled: true },
    };
    export const shell = { openExternal: async () => {}, openPath: async () => {} };
    export const clipboard = { writeText() {} };
    export const screen = {};
    export const powerMonitor = {};
    export class Notification {}
    export class Tray {}
    export const Menu = { buildFromTemplate: () => ({}) };
  `,
  'electron-log': `
    const noop = () => {};
    const log = {
      info: noop, warn: noop, error: noop, debug: noop,
      transports: { file: {}, console: {} },
      errorHandler: { startCatching: noop },
    };
    export default log;
  `,
  'electron-store': `
    export default class Store {
      constructor() { this.values = new Map(); }
      get(key) { return this.values.get(key); }
      set(key, value) { this.values.set(key, value); return value; }
      delete(key) { this.values.delete(key); }
    }
  `,
  exceljs: `
    export default { Workbook: class Workbook {} };
  `,
  sharp: `
    export default function sharp() {
      return { png() { return this; }, toBuffer: async () => Buffer.alloc(0) };
    }
  `,
  cheerio: `
    export function load() { return () => ({ length: 0 }); }
  `,
  dayjs: `
    export default function dayjs() {
      return { format: () => '2026-07-28 00:00:00', subtract() { return this; }, isBefore: () => false, diff: () => 0 };
    }
  `,
  axios: `
    const taskResponse = {
      data: {
        task: {
          id: 'task-1',
          _id: 'task-1',
          taskName: '../../unsafe display',
          taskStatus: 'noExecuted',
          progress: {},
          categoryIds: [],
        },
      },
    };
    const stateResponse = {
      data: {
        state: {
          currentStoreId: 'operating-1',
          currentDataCollectionStoreId: 'store-1',
        },
      },
    };
    const capture = (config = {}) => {
      globalThis.__DESKTOP_AXIOS_REQUESTS__ ||= [];
      globalThis.__DESKTOP_AXIOS_REQUESTS__.push(structuredClone(config));
      return globalThis.__DESKTOP_AXIOS_HANDLER__
        ? globalThis.__DESKTOP_AXIOS_HANDLER__(config)
        : responseFor(config);
    };
    const responseFor = (config = {}) =>
      String(config.url || '').includes('/local/state') ? stateResponse : taskResponse;
    function create() {
      return {
        interceptors: { request: { use() {} }, response: { use() {} } },
        request: async (config) => capture(config),
        get: async (url, config = {}) => capture({ ...config, method: 'get', url }),
        post: async (url, data, config = {}) => capture({ ...config, method: 'post', url, data }),
        patch: async (url, data, config = {}) => capture({ ...config, method: 'patch', url, data }),
        delete: async (url, config = {}) => capture({ ...config, method: 'delete', url }),
      };
    }
    export default { create, request: async (config) => capture(config) };
  `,
};

export async function resolve(specifier, context, nextResolve) {
  if (process.env.DESKTOP_TEST_REAL_EXCEL === '1' && ['exceljs', 'sharp'].includes(specifier))
    return nextResolve(specifier, context);
  if (specifier.endsWith('/seller-ozon.services.js') || specifier === '../seller-ozon.services.js') {
    const source = `
      export async function fetchSellerSkuAnalyticsBatch() {
        return structuredClone(globalThis.__SELLER_ANALYTICS_ITEMS__ || []);
      }
      export async function fetchSellerCategoryTree() { return structuredClone(globalThis.__SELLER_CATEGORY_TREE__ || { result: {} }); }
      export async function fetchSellerLeaderboard(options) {
        if (globalThis.__SELLER_LEADERBOARD_HANDLER__) return globalThis.__SELLER_LEADERBOARD_HANDLER__(options);
        return { items: structuredClone(globalThis.__SELLER_ANALYTICS_ITEMS__ || []), total: 1 };
      }
      export async function getSellerSessionStatus() { return { loggedIn: true, verification: globalThis.__SELLER_CONTEXT__ || {} }; }
      export async function verifyCurrentSellerStore() { return globalThis.__SELLER_CONTEXT__ || {}; }
      export async function acquireSellerRoute() { return { origin: 'https://seller.ozonru.cn', release() {} }; }
      export async function syncSellerRoute() { return { origin: 'https://seller.ozonru.cn', synced: true }; }
      export function rememberSellerRunRoute() {}
      export function getSellerRunRoute() { return 'https://seller.ozonru.cn'; }
      export async function requestSellerProduct(path, body) { if (!globalThis.__SELLER_PRODUCT_REQUEST__) throw new Error('Seller fixture not configured'); return globalThis.__SELLER_PRODUCT_REQUEST__(path, body); }
      export async function getSellerContext() { return {}; }
      export async function openSellerAnalyticsWindow() { return {}; }
      export async function destroySellerAnalyticsWindow() {}
      export async function destroySellerWindow() {}
    `;
    return {
      url: `data:text/javascript,${encodeURIComponent(source)}`,
      shortCircuit: true,
    };
  }
  if (Object.hasOwn(stubs, specifier)) {
    return {
      url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
