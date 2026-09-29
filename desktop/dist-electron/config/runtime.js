import { createRequire } from 'node:module';

const packagedDefaults = createRequire(import.meta.url)('../../package.json').sonliRuntime || {};
const DEFAULT_SONLI_API_BASE = 'http://127.0.0.1:3001';
const DEFAULT_SELLER_CENTER_URL = 'https://seller.ozonru.cn/app/analytics/what-to-sell';

function argumentValue(name) {
    const prefix = `--${name}=`;
    const arg = process.argv.find((value) => String(value).startsWith(prefix));
    return arg ? String(arg).slice(prefix.length) : '';
}

function normalizeBaseUrl(value, fallback) {
    const candidate = String(value || fallback || '').trim().replace(/\/+$/, '');
    const url = new URL(candidate);
    const isLocalHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !isLocalHttp) {
        throw new Error(`仅允许 HTTPS 或本机 HTTP 服务：${url.origin}`);
    }
    return url.toString().replace(/\/$/, '');
}

export function normalizeSellerUrl(value) {
    const normalized = normalizeBaseUrl(value, DEFAULT_SELLER_CENTER_URL);
    const url = new URL(normalized);
    if (!['https://seller.ozon.ru', 'https://seller.ozonru.cn'].includes(url.origin) || url.username || url.password)
        throw new Error('Seller Center 地址仅允许 https://seller.ozon.ru 或 https://seller.ozonru.cn');
    return normalized;
}

export function getRuntimeConfig(env = process.env) {
    const sonliApiBase = normalizeBaseUrl(
        argumentValue('sonli-api-base') || env.SONLI_API_BASE,
        packagedDefaults.apiBase || DEFAULT_SONLI_API_BASE,
    );
    const sonliWebBase = normalizeBaseUrl(
        argumentValue('sonli-web-base') || env.SONLI_WEB_BASE,
        packagedDefaults.webBase || sonliApiBase.replace(/:3001$/, ':3000'),
    );
    const updateUrl = String(argumentValue('update-url') || env.SONLI_UPDATE_URL || '').trim();
    const configUrl = String(argumentValue('config-url') || env.SONLI_CONFIG_URL || '').trim();
    const sellerCenterUrl = normalizeSellerUrl(
        argumentValue('seller-center-url') || env.SONLI_SELLER_CENTER_URL,
        DEFAULT_SELLER_CENTER_URL,
    );

    return {
        sonliApiBase,
        sonliWebBase,
        sellerCenterUrl,
        updateUrl: updateUrl ? normalizeBaseUrl(updateUrl, '') : '',
        configUrl: configUrl ? normalizeBaseUrl(configUrl, '') : '',
    };
}

export function isTrustedExternalUrl(value, config = getRuntimeConfig()) {
    try {
        const url = new URL(String(value || ''));
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) {
            return false;
        }
        const configuredHosts = [config.sonliApiBase, config.sonliWebBase, config.sellerCenterUrl]
            .map((item) => new URL(item).hostname);
        const allowedSuffixes = ['yuque.com', 'ozon.ru'];
        return (url.origin === 'https://seller.ozonru.cn' && !url.username && !url.password)
            || configuredHosts.includes(url.hostname)
            || allowedSuffixes.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
    }
    catch {
        return false;
    }
}

export const runtimeConfig = getRuntimeConfig();
