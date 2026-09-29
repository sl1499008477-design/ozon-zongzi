import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

export const PROFILE_NAME = 'ozon 粽子';
export const LEGACY_PROFILE_NAME = 'sonli-collector-desktop';

export function migrateProfileDirectory(appData) {
    const previous = join(appData, LEGACY_PROFILE_NAME);
    const current = join(appData, PROFILE_NAME);
    if (existsSync(current)) {
        if (existsSync(previous) && realpathSync(previous) !== realpathSync(current)) {
            throw new Error('存在两份独立的登录资料目录，请先核对，不能自动覆盖。');
        }
        return current;
    }
    if (!existsSync(previous)) {
        mkdirSync(current, { recursive: true });
        return current;
    }
    if (lstatSync(previous).isSymbolicLink()) throw new Error('原登录资料目录指向其他位置，请先核对。');
    try {
        renameSync(previous, current);
        try {
            // Historical file references and older installed clients still resolve to the same data.
            symlinkSync(current, previous, 'junction');
        } catch (error) {
            renameSync(current, previous);
            throw error;
        }
    } catch (error) {
        // Folder branding must not make an otherwise usable existing profile fail to open.
        if (['EPERM', 'EACCES', 'EBUSY'].includes(error.code) && existsSync(previous) && !existsSync(current)) {
            console.warn('登录资料目录暂时无法改名，继续使用原目录。', error.code);
            return previous;
        }
        throw error;
    }
    return current;
}
