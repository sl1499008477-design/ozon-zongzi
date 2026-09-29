const { contextBridge, ipcRenderer } = require('electron');

const INVOKE_CHANNELS = new Set([
  'app',
  'check-network',
  'collection-cancel-all-task',
  'collection-cancel-task',
  'collection-add-to-collect-box',
  'collection-send-to-ai-listing',
  'collection-ai-configs', 'collection-filter-presets-list', 'collection-filter-presets-save',
  'collection-filter-presets-update', 'collection-filter-presets-delete',
  'collection-copy',
  'collection-create',
  'collection-create-and-start',
  'collection-delete-task',
  'collection-download-excel',
  'collection-get-all-tasks',
  'collection-get-task',
  'collection-get-duplicates',
  'collection-get-outcomes',
  'collection-get-runs',
  'collection-get-results',
  'collection-resume-task',
  'collection-retry-failed',
  'collection-re-execute-task',
  'collection-start-task',
  'download-all-tables',
  'export-all-logs',
  'get-category-list',
  'get-config',
  'get-current-task-count',
  'get-shop-list',
  'getUserInfo',
  'login',
  'logout',
  'open-url',
  'seller-analytics-leaderboard',
  'seller-analytics-sku',
  'seller-open-login',
  'seller-route-status',
  'enrichment-status',
  'enrichment-tasks',
  'enrichment-task-control',
  'enrichment-resume',
  'seller-session-status',
  'seller-verify-store',
  'set-max-concurrent-task-count',
]);

const SEND_CHANNELS = new Set([
  'account',
  'app-quit',
  'check-update-app',
  'open-url',
  'quit-and-install-app',
  'start-downloaded-app',
  'start-update-app',
  'window',
]);

const RECEIVE_CHANNELS = new Set([
  'app-ready-quit',
  'connect',
  'maximize',
  'network-error',
  'refresh-task-list',
  'request',
  'task-completed',
  'task-progress',
  'enrichment-status',
  'task-status-update',
  'unmaximize',
  'update-available',
  'update-checking',
  'update-download-progress',
  'update-downloaded',
  'update-error',
  'update-not-available',
  'window-close',
  'window-notify',
]);

function assertChannel(channel, allowlist) {
  const normalized = String(channel || '');
  if (!allowlist.has(normalized)) throw new Error(`IPC channel is not allowed: ${normalized}`);
  return normalized;
}

const listeners = new Map();

function addListener(channel, callback) {
  const normalized = assertChannel(channel, RECEIVE_CHANNELS);
  if (typeof callback !== 'function') throw new TypeError('IPC listener must be a function');
  const wrapped = (_event, data) => callback(data);
  let channelListeners = listeners.get(normalized);
  if (!channelListeners) {
    channelListeners = new Map();
    listeners.set(normalized, channelListeners);
  }
  const previous = channelListeners.get(callback);
  if (previous) ipcRenderer.off(normalized, previous);
  channelListeners.set(callback, wrapped);
  ipcRenderer.on(normalized, wrapped);
}

function removeListener(channel, callback) {
  const normalized = assertChannel(channel, RECEIVE_CHANNELS);
  const channelListeners = listeners.get(normalized);
  if (callback) {
    const wrapped = channelListeners?.get(callback);
    if (wrapped) ipcRenderer.off(normalized, wrapped);
    channelListeners?.delete(callback);
    return;
  }
  for (const wrapped of channelListeners?.values() || []) ipcRenderer.off(normalized, wrapped);
  listeners.delete(normalized);
}

contextBridge.exposeInMainWorld('electronAPI', {
  sendMessage: (channel, data) => ipcRenderer.send(assertChannel(channel, SEND_CHANNELS), data),
  invoke: (channel, data) => ipcRenderer.invoke(assertChannel(channel, INVOKE_CHANNELS), data),
  onMessage: addListener,
  removeListener,
  on: addListener,
  off: removeListener,
});

contextBridge.exposeInMainWorld('electronStore', {
  get: (key) => ipcRenderer.invoke('store-get', key),
  set: (key, value) => ipcRenderer.invoke('store-set', key, value),
  delete: (key) => ipcRenderer.invoke('store-delete', key),
});

contextBridge.exposeInMainWorld('electronLog', {
  info: (...args) => ipcRenderer.invoke('log-info', args),
  warn: (...args) => ipcRenderer.invoke('log-warn', args),
  error: (...args) => ipcRenderer.invoke('log-error', args),
  debug: (...args) => ipcRenderer.invoke('log-debug', args),
});
