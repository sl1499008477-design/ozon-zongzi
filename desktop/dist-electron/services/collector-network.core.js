// One process-wide request budget. Task and item concurrency must not multiply sockets.
const waiting = [];
let active = 0, thumbnails = 0, sellerWrites = 0;

function dispatch() {
    while (active < 4) {
        const control = waiting.findIndex(item => item.kind === 'control');
        const index = control >= 0 ? control : waiting.findIndex(item =>
            (item.kind !== 'thumbnail' || thumbnails < 2) && (item.kind !== 'seller-write' || sellerWrites < 1));
        if (index < 0) return;
        const item = waiting.splice(index, 1)[0];
        item.signal?.removeEventListener('abort', item.cancel);
        active++;
        if (item.kind === 'thumbnail') thumbnails++;
        if (item.kind === 'seller-write') sellerWrites++;
        Promise.resolve().then(() => {
            item.signal?.throwIfAborted();
            return item.work();
        }).then(item.resolve, item.reject).finally(() => {
            active--;
            if (item.kind === 'thumbnail') thumbnails--;
            if (item.kind === 'seller-write') sellerWrites--;
            dispatch();
        });
    }
}

export function withCollectorRequest(work, { signal, kind = 'read' } = {}) {
    return new Promise((resolve, reject) => {
        signal?.throwIfAborted();
        const item = { work, signal, kind, resolve, reject };
        item.cancel = () => {
            const index = waiting.indexOf(item);
            if (index >= 0) waiting.splice(index, 1);
            reject(signal.reason);
        };
        signal?.addEventListener('abort', item.cancel, { once: true });
        waiting.push(item);
        dispatch();
    });
}
