import { sonliRequest } from '../services/sonli-api.services.js';
import pako from 'pako';
import Decimal from 'decimal.js';
import log from '../log/index.js';
import * as dns from 'node:dns';
export const compressData = (text) => {
    text = JSON.stringify(text);
    // 将文本数据转换为 Uint8Array
    const textBytes = new TextEncoder().encode(text);
    // 使用 pako 压缩数据
    const compressedData = pako.deflate(textBytes);
    // 将压缩后的数据转换为 ArrayBuffer
    const compressedArrayBuffer = compressedData.buffer.slice(compressedData.byteOffset, compressedData.byteOffset + compressedData.byteLength);
    // 将 ArrayBuffer 转换为 ArrayBuffer 的 base64 编码字符串
    const compressedBase64 = btoa(String.fromCharCode(...new Uint8Array(compressedArrayBuffer)));
    return compressedBase64;
};
/**
 * 获取汇率
 */
export const getRate = async () => {
    try {
        const payload = await sonliRequest({ method: 'get', url: '/pricing/config/active' });
        const config = payload?.config || payload?.data?.config || payload || {};
        return config.exchangeRates || config.rates || {};
    }
    catch (error) {
        return 0;
    }
};
/**
 * 货币转换
 * @params price 价格
 * @params rate 汇率
 */
export const currencyConversion = (basePrice, rateObj, unit) => {
    let rate;
    if (!rateObj)
        return 0;
    switch (unit) {
        case '¥':
            rate = 1;
            break;
        case 'YN':
        case '₽':
            rate = rateObj?.['CNY/RUB'];
            break;
        case '$':
            rate = rateObj?.['CNY/USD'];
            break;
        case '€':
            const num = rateObj?.['CNY/EUR'];
            rate = (1 / num).toFixed(4);
            break;
        case '₸':
            rate = rateObj?.['CNY/KZT'];
            break;
    }
    const priceNum = Number(basePrice);
    const rateNum = Number(rate);
    if (isNaN(priceNum) || isNaN(rateNum)) {
        log.error('货币转换错误', basePrice, rate, unit);
        return 0;
    }
    let price = new Decimal(basePrice);
    return Number(price.mul(rate).toFixed(2)); // 最终展示精度
};
const codeMap = {
    CNY: '¥',
    USD: '$',
    RUB: '₽',
    EUR: '€',
    BYN: 'YN',
    KZT: '₸',
};
export const getShopCurCode = (code) => {
    function getCurrencyName(code) {
        return codeMap[code];
    }
    return getCurrencyName(code);
};
/**
 * 检测网络是否可用
  */
export const checkNetworkStatus = () => {
    return new Promise((resolve) => {
        const TIMEOUT = 5000; // 5秒超时
        const domains = ['qq.com', 'taobao.com', 'baidu.com']; // 备用域名列表
        let isResolved = false;
        // 设置超时定时器
        const timer = setTimeout(() => {
            if (!isResolved) {
                isResolved = true;
                console.warn('网络检测超时');
                resolve(false);
            }
        }, TIMEOUT);
        // 创建独立的 DNS Resolver 实例，避免全局缓存影响
        const resolver = new dns.Resolver();
        const tryResolveDomain = (index) => {
            if (isResolved || index >= domains.length) {
                if (!isResolved) {
                    isResolved = true;
                    clearTimeout(timer);
                    console.error('所有域名解析失败，判定网络不可用');
                    resolve(false);
                }
                return;
            }
            const domain = domains[index];
            // 使用 resolve4 强制 IPv4 解析，通常更稳定
            resolver.resolve4(domain, (err, addresses) => {
                if (isResolved)
                    return; // 如果已经得到结果，忽略后续回调
                if (err) {
                    console.warn(`域名 ${domain} 解析失败: ${err.message}`);
                    // 当前域名失败，尝试下一个
                    tryResolveDomain(index + 1);
                }
                else {
                    // 解析成功
                    isResolved = true;
                    clearTimeout(timer);
                    console.log(`网络可用 (通过 ${domain} 检测, IP: ${addresses?.[0]})`);
                    resolve(true);
                }
            });
        };
        // 开始尝试解析第一个域名
        tryResolveDomain(0);
    });
};
