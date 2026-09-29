import Store from 'electron-store';
import { safeStorage } from 'electron';

const SECURE_KEYS = new Set(['token', 'loginInfo']);
const SECURE_PREFIX = '__secure__.';
const volatileSecrets = new Map();

export const store = new Store({
    name: 'store',
    defaults: {},
});

// 清理旧版第二套登录留下的令牌，不读取、不迁移到 sonli 会话。
const retiredTokenKey = ['collection', 'token'].join('-');
store.delete(retiredTokenKey);
store.delete(`${SECURE_PREFIX}${retiredTokenKey}`);

function secureStorageAvailable() {
    try {
        return safeStorage.isEncryptionAvailable();
    }
    catch {
        return false;
    }
}

function secureKey(key) {
    return `${SECURE_PREFIX}${key}`;
}

function readSecure(key) {
    if (volatileSecrets.has(key))
        return volatileSecrets.get(key);
    const encrypted = store.get(secureKey(key));
    if (encrypted && secureStorageAvailable()) {
        try {
            return JSON.parse(safeStorage.decryptString(Buffer.from(String(encrypted), 'base64')));
        }
        catch {
            // Keep the ciphertext if OS credentials are temporarily unavailable during migration.
        }
    }

    // 一次性迁移源程序留下的明文 token / 密码。
    const legacy = store.get(key);
    if (legacy !== undefined) {
        store.delete(key);
        writeSecure(key, legacy);
        return legacy;
    }
    return undefined;
}

function writeSecure(key, value) {
    if (value === undefined || value === null || value === '') {
        volatileSecrets.delete(key);
        store.delete(secureKey(key));
        store.delete(key);
        return;
    }
    if (!secureStorageAvailable()) {
        // macOS/Windows 正常会提供系统加密；不可用时只保留到本次进程，避免明文落盘。
        volatileSecrets.set(key, value);
        store.delete(secureKey(key));
        store.delete(key);
        return;
    }
    const encrypted = safeStorage.encryptString(JSON.stringify(value)).toString('base64');
    store.set(secureKey(key), encrypted);
    store.delete(key);
    volatileSecrets.delete(key);
}

export const operationStore = {
    get: (key) => SECURE_KEYS.has(key) ? readSecure(key) : store.get(key),
    set: (key, data) => SECURE_KEYS.has(key) ? writeSecure(key, data) : store.set(key, data),
    delete: (key) => {
        if (SECURE_KEYS.has(key)) {
            volatileSecrets.delete(key);
            store.delete(secureKey(key));
        }
        store.delete(key);
    },
};
