// Desktop Seller capture boundary. Only product fields cross the Collector API.
const SEARCH_PATH = '/api/v1/search';
const BUNDLE_PATH = '/api/site/seller-prototype/create-bundle-by-variant-id';
const CACHE_MS = 24 * 60 * 60 * 1000;
const fail = (code, message) => Object.assign(new Error(message), { code });
const positive = (...values) => values.map(Number).find(value => Number.isFinite(value) && value > 0) ?? null;
const integer = (...values) => values.map(Number).find(value => Number.isSafeInteger(value) && value > 0) ?? null;
const scalar = value => typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));

function attributeValues(attribute) {
    const raw = Array.isArray(attribute.values) ? attribute.values
        : Array.isArray(attribute.collection) ? attribute.collection
        : [attribute];
    const values = raw.map(entry => {
        if (scalar(entry)) return { value: entry };
        const value = {};
        if (scalar(entry?.value)) value.value = entry.value;
        const id = integer(entry?.dictionary_value_id ?? entry?.dictionaryValueId);
        if (id) value.dictionary_value_id = id;
        return value;
    }).filter(value => Object.keys(value).length);
    const rootId = integer(attribute.dictionary_value_id ?? attribute.dictionaryValueId);
    if (!Array.isArray(attribute.values) && values.length === 1 && rootId && !values[0].dictionary_value_id) values[0].dictionary_value_id = rootId;
    return values;
}

function sellerComplexAttributes(product) {
    const project = (attribute, groupId) => {
        const id = integer(attribute.id, attribute.attribute_id, attribute.key);
        const complex_id = integer(attribute.complex_id, groupId);
        if (!id || !complex_id) return null;
        return { id, complex_id, values: attributeValues(attribute) };
    };
    // Keep already grouped instances separate, even when they share complex_id.
    const groups = (product.complex_attributes || []).map(group => ({
        attributes: (group.attributes || []).map(attribute => project(attribute, group.complex_id)).filter(Boolean),
    })).filter(group => group.attributes.length);
    const groupedIds = new Set(groups.flatMap(group => group.attributes.map(attribute => attribute.complex_id)));
    const flat = new Map();
    for (const raw of product.attributes || []) {
        const attribute = project(raw);
        if (!attribute || groupedIds.has(attribute.complex_id)) continue;
        if (!flat.has(attribute.complex_id)) flat.set(attribute.complex_id, []);
        flat.get(attribute.complex_id).push(attribute);
    }
    return [...groups, ...[...flat.values()].map(attributes => ({ attributes }))];
}

export function projectSellerProduct(search, bundle) {
    const attributes = new Map();
    const authoritative = new Set((search.attributes || []).filter(attr => !integer(attr.complex_id) && Array.isArray(attr.values)).map(attr => String(attr.key ?? attr.attribute_id)));
    const put = (key, values) => {
        if (/^\d{1,20}$/.test(String(key))) attributes.set(String(key), { key: String(key), values });
    };
    const add = (key, value, dictionaryId) => {
        const entry = {};
        if (scalar(value) && value !== '') entry.value = value;
        if (integer(dictionaryId)) entry.dictionary_value_id = integer(dictionaryId);
        if (Object.keys(entry).length && !attributes.has(String(key))) put(key, [entry]);
    };
    for (const attr of search.attributes || []) {
        if (!integer(attr.complex_id)) put(attr.key ?? attr.attribute_id, attributeValues(attr));
    }
    add(8229, search.description_type_name, search.description_type_dict_value);
    add(85, search.brand_name);
    add(4180, search.variant_name || search.title || search.name);
    add(4191, search.description);
    add(4194, search.main_image);
    if (Array.isArray(search.secondary_images) && !attributes.has('4195'))
        put(4195, search.secondary_images.filter(scalar).map(value => ({ value })));
    add(7822, bundle.barcode || (bundle.barcodes || search.barcodes || [])[0]);
    for (const attr of bundle.attributes || []) {
        if (Number(attr.complex_id) > 0 || !Array.isArray(attr.values) || !attr.values.length) continue;
        const key = String(attr.attribute_id);
        const incoming = attributeValues(attr);
        const knownIds = attributes.get(key)?.values.some(value => value.dictionary_value_id);
        if (!authoritative.has(key) && !(knownIds && !incoming.some(value => value.dictionary_value_id))) put(key, incoming);
    }
    const complexAttributes = sellerComplexAttributes(search);
    const sourceGroups = new Map();
    for (const group of complexAttributes) {
        const id = group.attributes[0].complex_id;
        if (!sourceGroups.has(id)) sourceGroups.set(id, []);
        sourceGroups.get(id).push(group);
    }
    const bundlePositions = new Map();
    for (const group of sellerComplexAttributes(bundle)) {
        const id = group.attributes[0].complex_id;
        const position = bundlePositions.get(id) || 0;
        bundlePositions.set(id, position + 1);
        const existing = sourceGroups.get(id)?.[position];
        if (!existing) complexAttributes.push(group);
        else {
            const known = new Set(existing.attributes.map(attribute => attribute.id));
            existing.attributes.push(...group.attributes.filter(attribute => !known.has(attribute.id)));
        }
    }
    const physical = [['weight', '4497'], ['depth', '9454'], ['width', '9455'], ['height', '9456']];
    const fromAttributes = Object.fromEntries(physical.map(([field, key]) => [field, positive(attributes.get(key)?.values?.[0]?.value)]));
    if (!fromAttributes.weight) fromAttributes.weight = positive(Number(attributes.get('4383')?.values?.[0]?.value) * 1000);
    const fromBundle = Object.fromEntries(physical.map(([field]) => [field, positive(bundle[field])]));
    const values = Object.fromEntries(physical.map(([field, key]) => {
        const value = positive(fromBundle[field], fromAttributes[field], search[field]);
        if (value) add(key, value);
        return [field, value];
    }));
    const categories = [...(search.categories || [])].sort((a, b) => Number(b.level || 0) - Number(a.level || 0));
    const category = integer(bundle.description_category_id, search.description_category_id, categories[0]?.id);
    if (!category) throw fail('ZONGZI_ENRICH_INCOMPLETE', 'Seller 未提供商品类目，请在采集箱查看并补填');
    const typeId = integer(bundle.type_id, search.type_id);
    const conflict = physical.some(([field]) => fromBundle[field] && fromAttributes[field] && fromBundle[field] !== fromAttributes[field]);
    const candidate = v => ({ weightG: v.weight, lengthMm: v.depth, widthMm: v.width, heightMm: v.height });
    return {
        description_category_id: category,
        ...(typeId ? { type_id: typeId } : {}),
        ...values,
        attributes: [...attributes.values()],
        ...(complexAttributes.length ? { complex_attributes: complexAttributes } : {}),
        ...(conflict ? { packagingCandidates: [candidate(fromBundle), candidate(fromAttributes)] } : {}),
    };
}

export async function captureSellerProduct({ sku, verification, request, cache, signal, clock = Date.now }) {
    signal?.throwIfAborted();
    const companyId = String(verification.sellerCompanyId);
    const result = await request(SEARCH_PATH, {
        company_id: companyId, need_total: true,
        filter: { children_nodes: { children_nodes: [{ input_leaf: { sku: { values: [String(sku)] } } }], operator: 'AND' } },
        pagination: { limit: '50' }, is_copy_allowed: false,
    });
    signal?.throwIfAborted();
    const rows = result?.variants || result?.items || result?.products || (Array.isArray(result) ? result : []);
    const source = rows.find(row => Array.isArray(row.skus) && row.skus.some(value => String(value?.sku ?? value) === String(sku)));
    if (!source?.variant_id) throw fail('ZONGZI_ENRICH_NOT_FOUND', `Seller 未找到 SKU ${sku} 的完整资料`);
    const variantId = String(source.variant_id);
    const key = JSON.stringify([verification.accountId, companyId, variantId, 'ru']);
    const saved = await cache.get(key);
    if (saved?.state === 'ready' && clock() - saved.createdAt < CACHE_MS)
        return projectSellerProduct(source, saved.item);
    if (saved?.state === 'pending') throw fail('ZONGZI_ENRICH_BUNDLE_UNCERTAIN', '上次商品包创建结果未确认，请在采集箱查看；已停止重复创建');
    // This endpoint creates a Seller draft. Persist BEFORE sending; never retry
    // the write after timeout/window close/process exit without a confirmed reply.
    signal?.throwIfAborted();
    await cache.set(key, { state: 'pending', createdAt: clock() });
    let item;
    try {
        const response = await request(BUNDLE_PATH, { company_id: companyId, variant_id: variantId, source: 'SOURCE_UI_COPY_APPAREL' });
        item = response?.item;
        if (!item || String(item.origin_variant_id) !== variantId) throw new Error('variant mismatch');
        // Store only product evidence, not Seller actions or session metadata.
        const product = Object.fromEntries(['origin_variant_id', 'description_category_id', 'type_id', 'weight', 'depth', 'width', 'height', 'attributes', 'complex_attributes', 'barcodes', 'barcode']
            .filter(field => item[field] !== undefined).map(field => [field, item[field]]));
        await cache.set(key, { state: 'ready', createdAt: clock(), item: product });
    } catch (error) {
        if (error?.requestSent === false || error?.confirmedRejected === true) {
            await cache.delete(key);
            throw error;
        }
        throw fail('ZONGZI_ENRICH_BUNDLE_UNCERTAIN', '商品包请求未取得可确认的结果，已停止重复创建；请在采集箱查看');
    }
    signal?.throwIfAborted();
    return projectSellerProduct(source, item);
}
