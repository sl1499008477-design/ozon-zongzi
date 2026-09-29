import * as dns from 'node:dns';
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
