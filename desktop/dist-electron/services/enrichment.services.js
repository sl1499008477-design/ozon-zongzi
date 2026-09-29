import { app } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { operationStore } from '../store/index.js';
import { globalBroadcast } from '../ipc/broadcast.js';
import { getCollectorAuthorization, sonliRequest } from './sonli-api.services.js';
import { verifyCurrentSellerStore, requestSellerProduct, acquireSellerRoute } from './seller-ozon.services.js';
import { captureSellerProduct } from './seller-enrichment.core.js';
import { createEnrichmentWorker } from './enrichment-worker.core.js';

const cachePath = key => path.join(app.getPath('userData'), 'seller-product-evidence', `${createHash('sha256').update(key).digest('hex')}.json`);
const cache = {
    async delete(key) { await unlink(cachePath(key)).catch(error => { if (error.code !== 'ENOENT') throw error; }); },
    async get(key) {
        try { return JSON.parse(await readFile(cachePath(key), 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    },
    async set(key, value) {
        const file = cachePath(key);
        await mkdir(path.dirname(file), { recursive: true });
        const temporary = `${file}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
        await rename(temporary, file);
    },
};

let sellerRouteLease = null;
export const enrichmentWorker = createEnrichmentWorker({
    getIdentity() {
        const user = operationStore.get('user') || {};
        return { accountId: String(user._id || user.id || ''), parentToken: String(operationStore.get('token') || '') };
    },
    async openSession(identity, signal) {
        const collectorToken = await getCollectorAuthorization();
        signal.throwIfAborted();
        // Pin both identities through claim, heartbeats and result. Renewal of a
        // Collector token must not change the owner halfway through a job.
        return (url, data) => sonliRequest({ url, method: 'POST', data, signal, timeout: 10000,
            collectorToken, expectedParentToken: identity.parentToken, quiet: true });
    },
    async verifySeller(identity, signal, expected) {
        if (!sellerRouteLease) sellerRouteLease = await acquireSellerRoute({ signal });
        return verifyCurrentSellerStore(expected || { accountId: identity.accountId }, { silent: true, signal });
    },
    releaseSeller() { sellerRouteLease?.release(); sellerRouteLease = null; },
    capture: (job, verification, signal) => captureSellerProduct({ sku: job.sku, verification, signal, cache,
        request: (url, body) => requestSellerProduct(url, body, verification, signal) }),
    notify: status => globalBroadcast.broadcast('enrichment-status', status),
});
