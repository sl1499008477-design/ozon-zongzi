import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import test from 'node:test';

const activeCollectionUrl = new URL(
    '../dist-electron/services/collection/collection.services.js',
    import.meta.url,
);

const obsoleteRuntimeUrls = [
    new URL('../dist-electron/services/collection.services.js', import.meta.url),
    new URL('../dist-electron/services/collection/type.js', import.meta.url),
    new URL('../dist-electron/types/index.js', import.meta.url),
    new URL('../dist-electron/utils/file.js', import.meta.url),
    new URL('../dist-electron/utils/request.js', import.meta.url),
];

test('desktop package exposes only the active modular collection runtime', async () => {
    await access(activeCollectionUrl);

    for (const obsoleteUrl of obsoleteRuntimeUrls) {
        await assert.rejects(
            access(obsoleteUrl),
            (error) => error?.code === 'ENOENT',
            `${obsoleteUrl.pathname} must not ship as a second unsupported runtime`,
        );
    }
});

