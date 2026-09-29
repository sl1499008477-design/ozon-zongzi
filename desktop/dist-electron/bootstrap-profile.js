import { app } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { LEGACY_PROFILE_NAME, PROFILE_NAME, migrateProfileDirectory } from './profile-directory.core.js';

// Keep the original OS encryption identity so saved credentials and Seller cookies remain readable.
// The visible application name is set after Electron is ready; user data uses the new folder.
app.setName(LEGACY_PROFILE_NAME);
const base = app.getPath('appData');
const previous = join(base, LEGACY_PROFILE_NAME);
const current = join(base, PROFILE_NAME);
const configured = app.getPath('userData');
const usesDefaultProfile = [previous, current, join(base, 'ozon-zongzi-desktop')].includes(configured);
if (usesDefaultProfile) app.setPath('userData', existsSync(current) || !existsSync(previous) ? current : previous);
// First reject a second instance before touching existing data or initializing electron-store.
if (!app.requestSingleInstanceLock()) app.exit(0);
if (usesDefaultProfile) {
    // Windows keeps a lockfile open inside userData. Release our handle before renaming,
    // then obtain the lock for the selected final directory before initializing stores.
    if (process.platform === 'win32') app.releaseSingleInstanceLock();
    app.setPath('userData', migrateProfileDirectory(base));
    if (process.platform === 'win32' && !app.requestSingleInstanceLock()) app.exit(0);
}
