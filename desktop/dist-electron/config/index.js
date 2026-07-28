import axios from 'axios';
import { runtimeConfig } from './runtime.js';

const EMPTY_CONFIG = { feature: [], optimize: [], repair: [] };

export const getConfig = async () => {
    if (!runtimeConfig.configUrl)
        return EMPTY_CONFIG;
    try {
        const res = await axios.get(runtimeConfig.configUrl, { timeout: 10000 });
        return {
            feature: Array.isArray(res.data?.feature) ? res.data.feature : [],
            optimize: Array.isArray(res.data?.optimize) ? res.data.optimize : [],
            repair: Array.isArray(res.data?.repair) ? res.data.repair : [],
        };
    }
    catch (error) {
        console.error('获取配置失败', error?.message || error);
        return EMPTY_CONFIG;
    }
};
