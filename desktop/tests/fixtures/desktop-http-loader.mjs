import { resolve as desktopResolve } from './desktop-module-loader.mjs';
export async function resolve(specifier, context, nextResolve) {
    // Keep real Axios, HTTP, authentication and Collector services; only native
    // Electron/Seller surfaces use the explicitly isolated fixture adapter.
    if (specifier === 'axios') return nextResolve(specifier, context);
    return desktopResolve(specifier, context, nextResolve);
}
