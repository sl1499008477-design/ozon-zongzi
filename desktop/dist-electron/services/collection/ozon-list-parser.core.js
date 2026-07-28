import * as cheerio from 'cheerio';

function parsePrice(value) {
    const normalized = String(value || '')
        .replace(/\u00a0|\u2009|\u202f/g, '')
        .replace(',', '.')
        .replace(/[^\d.]/g, '');
    return Number(normalized) || 0;
}

function productIdFromHref(href) {
    return href?.match(/\/product\/(?:[^/?#]*-)?(\d+)(?=\/|\?|#|$)/)?.[1];
}

export function parseOzonProductCards(html, domain) {
    if (!html)
        return [];

    const $ = cheerio.load(html);
    let productLinks = $('#contentScrollPaginator a[href*="/product/"]');
    if (!productLinks.length) {
        productLinks = $('[data-widget="searchResultsV2"] a[href*="/product/"], [data-widget="skuGrid"] a[href*="/product/"]');
    }
    if (!productLinks.length)
        productLinks = $('a[href*="/product/"]');

    const data = [];
    const seenIds = new Set();
    productLinks.each((_index, element) => {
        const href = $(element).attr('href');
        const id = productIdFromHref(href);
        if (!id || seenIds.has(id))
            return;

        seenIds.add(id);
        const card = $(element).closest('[data-index], .tile-root').first();
        const scope = card.length ? card : $(element).parent();
        const price = parsePrice(scope.find('.tsHeadline500Medium').first().text());
        const originalPriceText = scope.find('.tsBodyControl400Small').first().text();
        const originalPrice = parsePrice(originalPriceText) || undefined;
        const names = scope
            .find('a[href*="/product/"]')
            .map((_nameIndex, link) => $(link).text().trim())
            .get()
            .filter(Boolean)
            .sort((left, right) => right.length - left.length);
        const cover = $(element).find('img').first().attr('src')
            || scope.find('img').first().attr('src');
        const nameLabel = names[0] || scope.find('img').first().attr('alt') || '';
        let scoreText = scope.find('.tsBodyMBold').first().text().replace(/\u202f/g, ' ');
        if (!scoreText) {
            scoreText = scope.find('.tsBodyControl300XSmall').first().text().replace(/\u202f/g, ' ');
        }
        const scoreMatch = scoreText.match(/\s*([0-5](?:[.,]\d)?)\s*(\d[\d\s]*)\s*/i);
        const rating = scoreMatch ? scoreMatch[1].replace(',', '.') : 0;
        const reviewCountLabel = scoreMatch ? scoreMatch[2].replace(/\s/g, '') : 0;
        const queryUrl = encodeURIComponent(`/modal/otherOffersFromSellers?product_id=${id}&page_changed=true`);
        const requestUrl = `${domain}/api/entrypoint-api.bx/page/json/v2?url=${queryUrl}`;
        const link = `https://www.ozon.ru/product/${id}`;

        data.push({
            href,
            price,
            price1: price,
            oPrice: originalPrice,
            oPrice1: originalPrice,
            link,
            cover,
            cover3: cover,
            nameLabel,
            id,
            rating,
            sku: id,
            requestUrl,
            reviewCountLabel,
        });
    });

    return data;
}
