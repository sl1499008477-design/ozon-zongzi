const stubs = {
  electron: `
    const userData = process.env.DESKTOP_TEST_USER_DATA || process.cwd();
    export const app = {
      isPackaged: true,
      getPath: (name) => name === 'userData' ? userData : userData,
      getName: () => 'sonli-test',
      getVersion: () => '0.0.0-test',
      getAppPath: () => process.cwd(),
      getAppMetrics: () => [],
    };
    export class BrowserWindow {
      constructor() {
        this.webContents = {
          send() {},
          setWindowOpenHandler() {},
          setUserAgent() {},
          on() {},
          once() {},
          executeJavaScript: async () => ({}),
        };
      }
      isDestroyed() { return false; }
      destroy() {}
      loadURL() { return Promise.resolve(); }
      once() {}
      on() {}
    }
    export const ipcMain = { handle() {}, on() {}, once() {}, removeAllListeners() {} };
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
      return { format: () => '2026-07-28 00:00:00', subtract() { return this; }, isBefore: () => false };
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
      return responseFor(config);
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
  if (Object.hasOwn(stubs, specifier)) {
    return {
      url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
