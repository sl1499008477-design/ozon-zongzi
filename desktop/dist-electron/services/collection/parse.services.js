import * as cheerio from 'cheerio';
import log from '../../log/index.js';
import { parseOzonProductCards } from './ozon-list-parser.core.js';

export function parseOzonMoney(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    const currencyCode = /[¥￥]|\bCNY\b/i.test(text) ? 'CNY' : /₽|\bRUB\b/i.test(text) ? 'RUB' : '';
    const amount = text.replace(/CNY|RUB|[¥￥₽\s]/gi, '').replace(',', '.');
    if (!currencyCode || !/^\d+(?:\.\d+)?$/.test(amount))
        return null;
    return { amount: amount.replace(/^0+(?=\d)/, ''), currencyCode };
}

function parseStorefrontPrice(widget) {
    const bank = parseOzonMoney(widget.cardPrice);
    const ordinary = parseOzonMoney(widget.price);
    const price = ordinary || (widget.price == null || widget.price === '' ? bank : null);
    if (!price)
        return null;
    const original = parseOzonMoney(widget.originalPrice);
    const marketing = parseOzonMoney(widget.marketingPrice);
    return {
        ...price,
        ordinaryAmount: ordinary?.amount ?? null,
        ...(original?.currencyCode === price.currencyCode ? { originalAmount: original.amount } : {}),
        ...(bank?.currencyCode === price.currencyCode ? { bankAmount: bank.amount } : {}),
        ...(marketing?.currencyCode === price.currencyCode ? { marketingAmount: marketing.amount } : {}),
        source: 'ozon-web-price',
    };
}

function readWidget(states, name) {
    for (const [key, raw] of Object.entries(states || {})) {
        if (key !== name && !key.startsWith(`${name}-`)) continue;
        try { return typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); }
        catch { /* A malformed optional score or offers widget must not discard product content. */ }
    }
    return {};
}

function widgetText(value) {
    if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
    if (Array.isArray(value)) return value.map(widgetText).join('').trim();
    return value ? widgetText(value.textRs || value.content || value.text || value.title || value.value || '') : '';
}

function parseProductContent(states, sku, goods) {
    const images = new Set(), videos = new Map(), characteristics = new Map();
    let description = '', richContent = '', descriptionSource = '', colorImage = '', videoCoverUrl = '';
    let galleryRead = false, descriptionRead = false, invalidVideos = false, invalidColor = false, coverUnverified = false, richContentFailed = false;
    const mediaUrl = value => {
        if (typeof value !== 'string') return '';
        const candidate = value.trim();
        try {
            const url = new URL(candidate);
            return /^https?:\/\//i.test(candidate) && !/\s/u.test(candidate) && url.hostname ? candidate : '';
        }
        catch { return ''; }
    };
    const imageUrl = value => {
        const url = typeof value === 'string' ? value : value?.src || value?.url || value?.image || value?.imageUrl;
        return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : '';
    };
    const addCharacteristic = row => {
        if (!row || typeof row !== 'object') return;
        const name = widgetText(row.name || row.title || row.key);
        const value = Array.isArray(row.values) ? row.values.map(widgetText).filter(Boolean).join(', ')
            : widgetText(row.value ?? row.content ?? row.text);
        if (name && value) characteristics.set(`${name}\0${value}`, { name, value });
        for (const group of ['short', 'items', 'characteristics']) {
            if (Array.isArray(row[group])) row[group].forEach(addCharacteristic);
        }
    };
    for (const [key, raw] of Object.entries(states || {})) {
        if (!/^(?:webGallery|webCharacteristics|webShortCharacteristics|webDescription)(?:-|$)/.test(key)) continue;
        let widget;
        try { widget = typeof raw === 'string' ? JSON.parse(raw) : raw; }
        catch { throw Object.assign(new Error(`Ozon 商品资料 ${key} 解析失败，请重试采集`), { code: 'ZONGZI_DETAIL_INCOMPLETE' }); }
        if (!widget || typeof widget !== 'object') continue;
        if (widget.sku && String(widget.sku) !== String(sku))
            throw Object.assign(new Error('Ozon 返回了其他 SKU 的商品资料，请重试采集'), { code: 'ZONGZI_RESPONSE_SKU_MISMATCH' });
        if (/^webGallery(?:-|$)/.test(key)) {
            galleryRead = true;
            for (const value of [widget.coverImage, ...(Array.isArray(widget.images) ? widget.images : [])]) {
                const url = imageUrl(value);
                if (url) images.add(url);
            }
            for (const video of Array.isArray(widget.videos) ? widget.videos : []) {
                const url = mediaUrl(typeof video === 'string' ? video : video?.url);
                if (url && !/\.(?:jpg|jpeg|png|webp|gif|avif)(?:[?#]|$)/i.test(url))
                    videos.set(url, { ...videos.get(url), url, ...(imageUrl(video?.coverUrl) ? { coverUrl: video.coverUrl } : {}) });
                else invalidVideos = true;
            }
            if (widget.videos && !Array.isArray(widget.videos)) invalidVideos = true;
            if (widget.color_image) {
                const url = mediaUrl(widget.color_image);
                if (url) colorImage ||= url;
                else invalidColor = true;
            }
            if (widget.videoCover) {
                const url = mediaUrl(widget.videoCover.url);
                if (url && /\.(?:mp4|mov)$/i.test(new URL(url).pathname)) videoCoverUrl ||= url;
                else coverUnverified = true;
            }
        }
        if (Array.isArray(widget.characteristics)) widget.characteristics.forEach(addCharacteristic);
        if (/^webDescription(?:-|$)/.test(key)) {
            descriptionRead = true;
            if (String(widget.richAnnotationType).toUpperCase() === 'HTML' && typeof widget.richAnnotation === 'string' && widget.richAnnotation.trim()) {
                description = widget.richAnnotation;
                descriptionSource = 'web_description';
            }
            if (widget.richAnnotationJson) {
                let doc;
                try { doc = typeof widget.richAnnotationJson === 'string' ? JSON.parse(widget.richAnnotationJson) : widget.richAnnotationJson; }
                catch { throw Object.assign(new Error('Ozon 商品富内容解析失败，请重试采集'), { code: 'ZONGZI_DETAIL_INCOMPLETE' }); }
                if (Array.isArray(doc?.content)) {
                    if (doc.content.length) richContent = typeof widget.richAnnotationJson === 'string' ? widget.richAnnotationJson : JSON.stringify(doc);
                }
                else richContentFailed = true;
            }
        }
    }
    for (const url of Array.isArray(goods.images) ? goods.images : []) if (imageUrl(url)) images.add(imageUrl(url));
    for (const row of Array.isArray(goods.sourceCharacteristics) ? goods.sourceCharacteristics : []) addCharacteristic(row);
    if (!description && !goods.description) {
        description = [...characteristics.values()].filter(row => /^Описание$/i.test(row.name))
            .map(row => row.value).join('\n');
        if (description) descriptionSource = 'public_characteristics';
    }
    const contentDiagnostics = { ...goods.contentDiagnostics };
    for (const [field, value, status, source] of [
        ['description', description, descriptionRead ? 'not_provided' : 'unverified', descriptionSource || 'web_description'],
        ['richContent', richContent, richContentFailed ? 'read_failed' : descriptionRead ? 'not_provided' : 'unverified', 'webDescription.richAnnotationJson'],
        ['videos', videos.size, invalidVideos ? 'unverified' : galleryRead ? 'not_provided' : 'unverified', 'webGallery.videos'],
        ['color_image', colorImage, invalidColor ? 'unverified' : galleryRead ? 'not_provided' : 'unverified', 'webGallery.color_image'],
        ['videoCoverUrl', videoCoverUrl, coverUnverified ? 'unverified' : galleryRead ? 'not_provided' : 'unverified', 'webGallery.videoCover'],
    ]) {
        const retained = Array.isArray(goods[field]) ? goods[field].length > 0 : !!goods[field];
        contentDiagnostics[field] = value ? { status: 'provided', source }
            : retained ? goods.contentDiagnostics?.[field] || { status: 'provided', source: 'existing_same_sku' }
            : { status, source, ...(status === 'read_failed' ? { message: '商品富内容结构未能识别，请重试采集' } : {}) };
    }
    return {
        ...(images.size ? { images: [...images], primaryImage: [...images][0] } : {}),
        ...(videos.size ? { videos: [...videos.values()] } : {}),
        ...(characteristics.size ? { sourceCharacteristics: [...characteristics.values()] } : {}),
        ...(description ? { description } : {}),
        ...(richContent ? { richContent } : {}),
        ...(colorImage ? { color_image: colorImage } : {}),
        ...(videoCoverUrl ? { videoCoverUrl } : {}),
        contentDiagnostics,
    };
}

function readProductJsonLd(html, sku) {
    const products = [];
    let status = 'not_provided';
    const visit = value => {
        if (Array.isArray(value)) { value.forEach(visit); return; }
        if (!value || typeof value !== 'object') return;
        const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
        if (types.some(type => /(?:^|[/#])Product$/.test(String(type)))) products.push(value);
        if (Array.isArray(value['@graph'])) visit(value['@graph']);
    };
    const $ = cheerio.load(html || '');
    for (const script of $('script[type="application/ld+json"]').toArray()) {
        try { visit(JSON.parse($(script).text())); }
        catch { status = 'read_failed'; }
    }
    const product = products.find(value => String(value.sku || '') === String(sku));
    if (!product && products.length && status !== 'read_failed') status = 'unverified';
    const name = typeof product?.name === 'string' && !/\p{Script=Han}/u.test(product.name) ? product.name.trim() : '';
    const description = typeof product?.description === 'string' ? product.description.trim() : '';
    if (description && /[А-Яа-яЁё]/.test(description) && !/\p{Script=Han}/u.test(description))
        return { name, description, status: 'provided', source: 'json_ld' };
    return { name, description: '', status: description ? 'read_failed' : status, source: 'json_ld' };
}

function publicFilterMeasurements(characteristics, goods) {
    const result = {};
    for (const { name, value } of characteristics || []) {
        const label = name.toLowerCase().trim();
        const field = /^(?:(?:вес|масса)(?: товара)? с упаковкой|(?:вес|масса) брутто)(?:,|\s*\(|$)/.test(label) ? 'weight'
            : /^длина упаковки(?:,|\s*\(|$)/.test(label) ? 'length'
            : /^ширина упаковки(?:,|\s*\(|$)/.test(label) ? 'width'
            : /^высота упаковки(?:,|\s*\(|$)/.test(label) ? 'height' : '';
        if (!field || (goods[field] != null && goods[field] !== '') || result[field] != null) continue;
        const match = String(value).trim().replace(',', '.').match(/^(\d+(?:\.\d+)?)\s*(кг|г|см|мм|kg|g|cm|mm)?$/i);
        if (!match) continue;
        const unit = (match[2] || label.match(/(?:,|\()\s*(кг|г|см|мм|kg|g|cm|mm)\s*\)?$/i)?.[1] || '').toLowerCase();
        const multiplier = field === 'weight' ? ({ кг: 1000, kg: 1000, г: 1, g: 1 })[unit]
            : ({ см: 10, cm: 10, мм: 1, mm: 1 })[unit];
        const amount = Number(match[1]) * multiplier;
        if (amount > 0) result[field] = amount;
    }
    return result;
}

export class ParseService {
    ozonGoodsData = new Set();
    windowService = null;
    guessLikeList = new Set();
    constructor(windowService) {
        this.windowService = windowService;
    }
    async ozonListParser(html, domain, selectCandidates = items => items, { deferOffers = false } = {}) {
        if (!html)
            return [];
        const $ = cheerio.load(html);
        const data = parseOzonProductCards(html, domain);
        if (!this.guessLikeList.size) {
            const likeDom = $('[data-widget="skuGrid"] a');
            // 获取猜你喜欢数据
            likeDom.each((index, element) => {
                const href = $(element).attr('href');
                const id = href?.match(/-(\d+)(?=\/|\?)/)?.[1];
                const queryUrl = encodeURIComponent(`/modal/otherOffersFromSellers?product_id=${id}&page_changed=true`);
                const requestUrl = `${domain}/api/entrypoint-api.bx/page/json/v2?url=${queryUrl}`;
                this.guessLikeList.add(requestUrl);
            });
        }
        const uniqueData = [];
        for (const item of data) {
            if (this.ozonGoodsData.has(item.id))
                continue;
            this.ozonGoodsData.add(item.id);
            uniqueData.push(item);
        }
        const selected = await selectCandidates(uniqueData);
        if (deferOffers) return selected;
        for (const item of selected) {
            const pagePrice = parseOzonMoney(item.priceText);
            const response = await this.windowService?.getSellingData(item.requestUrl);
            if (response?.success) {
                item.sellers = JSON.parse(response.data.widgetStates?.['webSellerList-4723017-default-1'] || '{}');
                item.sellerNumber = item?.sellers?.sellers?.length || undefined;
                const priceList = (item.sellers?.sellers || []).map((seller) => parseOzonMoney(seller?.price?.cardPrice?.price))
                    .filter((price) => price && price.currencyCode === pagePrice?.currencyCode
                        && Number(price.amount) < Number(pagePrice.amount));
                item.sellerNumber1 = item.sellerNumber;
                item.followMinPrice = priceList.sort((a, b) => Number(a.amount) - Number(b.amount))[0]?.amount || pagePrice?.amount;
                item.followMinPrice1 = item.followMinPrice;
            }
            else {
                item.sellerNumber = undefined;
                item.sellerNumber1 = undefined;
                item.followMinPrice = pagePrice?.amount;
                item.followMinPrice1 = item.followMinPrice;
                log.error('获取跟卖数据失败');
            }
            item.followPriceCurrency = item.followMinPrice === undefined ? '' : pagePrice.currencyCode;
        }
        return selected;
    }
    /**
     * 商品去重
      */
    async ozonDetailListParser(list) {
        const uniqueData = [];
        for (const item of list) {
            const sku = String(item.sku || item._id || item.id || '');
            if (this.ozonGoodsData.has(sku)) continue;
            this.ozonGoodsData.add(sku);
            uniqueData.push(item);
        }
        return uniqueData;
    }
    async ozonDetailParse(data, domain, goods) {
        const original = { ...goods, id: goods._id || goods.id || goods.sku, storefrontPrice: null };
        if (!data?.success)
            return original;
        try {
            const states = data.data.widgetStates || {};
            const sourceAspects = readWidget(states, 'webAspects').aspects;
            if (Array.isArray(sourceAspects)) original.sourceAspects = sourceAspects;
            const content = parseProductContent(states, original.id, goods);
            // Keep successfully read product content even if optional historical metadata is malformed.
            Object.assign(original, content, publicFilterMeasurements(content.sourceCharacteristics, goods));
            const heading = readWidget(states, 'webProductHeading');
            if (heading.sku && String(heading.sku) !== String(original.id))
                throw Object.assign(new Error('Ozon 返回了其他 SKU 的商品标题，请重试采集'), { code: 'ZONGZI_RESPONSE_SKU_MISMATCH' });
            let name = widgetText(heading.title);
            if (/\p{Script=Han}/u.test(name)) name = '';
            if ((!original.description || /\p{Script=Han}/u.test(original.description)) && this.windowService?.getProductHtml) {
                let evidence;
                try {
                    const html = await this.windowService.getProductHtml(String(original.id));
                    const { name: jsonName, description, ...diagnostics } = readProductJsonLd(html, original.id);
                    if (description) original.description = description;
                    if (!name) name = jsonName;
                    evidence = diagnostics;
                }
                catch (error) {
                    if (/(?:ACCOUNT|CONTEXT|CANCELLED|WINDOW_CLOSED)/.test(error?.code || '')
                        || error?.code === 'ZONGZI_ACCESS_BLOCKED' || [401, 403, 429].includes(Number(error?.status))) throw error;
                    evidence = { status: 'read_failed', source: 'json_ld', message: '商品简介暂未读取成功，可稍后重试' };
                }
                original.contentDiagnostics = { ...original.contentDiagnostics, description: evidence };
            }
            if (name) Object.assign(original, { name, nameLabel: name, title: name });
            const storefrontPrice = parseStorefrontPrice(readWidget(states, 'webPrice'));
            original.storefrontPrice = storefrontPrice;
            const score = readWidget(states, 'webReviewProductScore');
            const widgetStatesScore = readWidget(states, 'webSingleProductScore');
            const queryUrl = encodeURIComponent(`/modal/otherOffersFromSellers?product_id=${original.id}&page_changed=true`);
            const requestUrl = `${domain}/api/entrypoint-api.bx/page/json/v2?url=${queryUrl}`;
            let str = widgetStatesScore?.text || '';
            const match = str.match(/([0-5](?:\.\d)?)[^0-9]*(\d[\d\s]*)/i);
            const rating = score.totalScore ?? (match ? match[1] : undefined);
            const reviewCountLabel = score.reviewsCount ?? (match ? match[2].replace(/\s/g, '') : undefined);
            const response = await this.windowService?.getSellingData(requestUrl);
            let sellers, sellerNumber, sellerNumber1, followMinPrice, followMinPrice1 = undefined;
            if (response?.success) {
                sellers = readWidget(response.data.widgetStates, 'webSellerList');
                sellerNumber = Array.isArray(sellers.sellers) ? sellers.sellers.length : goods.sellerNumber;
                const priceList = (sellers?.sellers || []).map((item) => parseOzonMoney(item?.price?.cardPrice?.price))
                    .filter((price) => price && price.currencyCode === storefrontPrice?.currencyCode
                        && Number(price.amount) < Number(storefrontPrice.amount));
                sellerNumber1 = sellerNumber;
                followMinPrice = priceList.sort((a, b) => Number(a.amount) - Number(b.amount))[0]?.amount || storefrontPrice?.amount;
                followMinPrice1 = followMinPrice;
            }
            else {
                log.error('获取跟卖数据失败');
            }
            return {
                ...original,
                // Market filters still consume goods.price, the Seller Analytics RUB statistic.
                storefrontPrice,
                rating: rating ?? goods.rating,
                reviewCountLabel: reviewCountLabel ?? goods.reviewCountLabel,
                sellers,
                sellerNumber,
                sellerNumber1,
                followMinPrice,
                followMinPrice1,
                followPriceCurrency: followMinPrice === undefined ? '' : storefrontPrice.currencyCode,
                cover: goods.cover || goods.photo,
                nameLabel: original.nameLabel || original.name,
            };
        }
        catch (error) {
            if (String(error?.code || '').startsWith('ZONGZI_') || error?.code === 'COLLECTION_CANCELLED' || error?.code === 'COLLECTION_WINDOW_CLOSED')
                throw error;
            log.error('解析数据失败~~~');
            return original;
        }
    }
    /**
     * 获取商品数量
     */
    getDataCount() {
        return this.ozonGoodsData.size;
    }
    /**
     * 销毁实例
     */
    destroy() {
        this.ozonGoodsData.clear();
        this.guessLikeList.clear();
        this.windowService = null;
    }
}
