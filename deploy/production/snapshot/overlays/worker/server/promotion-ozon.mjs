import { callOzonSellerApi, getOzonSellerApi } from './ozon-client.mjs';

const invalidResponse = () => Object.assign(new Error('Ozon 活动数据不完整，本次快照未完成'), { code: 'PROMOTION_ZONGZI_RESPONSE_INVALID', status: 502 });
const invalidInput = () => Object.assign(new Error('活动操作的商品、金额、币种或批次参数无效'), { code: 'PROMOTION_ZONGZI_INPUT_INVALID', status: 400 });
const unknownResult = cause => Object.assign(new Error('Ozon 操作结果不明，须回读确认，不能自动重发'), { code: 'PROMOTION_ZONGZI_RESULT_UNKNOWN', status: 502, uncertain: true, ...(cause ? { cause } : {}) });
const text = value => typeof value === 'string' && value.trim() ? value : null;
const boolean = value => typeof value === 'boolean' ? value : null;
const currency = value => typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null;
const iso = value => typeof value === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
const count = value => (typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value)) && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const mode = value => value === 'AUTO' || value === 'MANUAL' ? value : 'UNKNOWN';

function identifier(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  if (!['number', 'string'].includes(typeof value)) return null;
  const result = String(value);
  return /^[1-9]\d{0,19}$/.test(result) && BigInt(result) <= 18446744073709551615n ? result : null;
}
function requiredId(value, error = invalidResponse) {
  const result = identifier(value);
  if (!result) throw error();
  return result;
}
function numericId(value) {
  const result = Number(requiredId(value, invalidInput));
  if (!Number.isSafeInteger(result)) throw invalidInput();
  return result;
}

// No currency conversion, rounding or cost inference at this boundary.
function decimal(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    value = String(value);
    if (value.includes('e')) {
      const [mantissa, exponent] = value.split('e');
      const [whole, fraction = ''] = mantissa.split('.');
      const digits = whole + fraction, point = whole.length + Number(exponent);
      value = point <= 0 ? `0.${'0'.repeat(-point)}${digits}` : point >= digits.length ? digits + '0'.repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`;
    }
  }
  return typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? value : null;
}
function writePrice(value) {
  const result = decimal(value);
  if (!result || !/^\d+(?:\.\d{1,2})?$/.test(result) || Number(result) <= 0) throw invalidInput();
  const [whole, fraction = ''] = result.split('.');
  if (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')) > BigInt(Number.MAX_SAFE_INTEGER)) throw invalidInput();
  return result;
}
function array(value) {
  if (!Array.isArray(value)) throw invalidResponse();
  return value;
}

// These are product-info stocks, not /actions/products.stock (an allocation).
// Keep unknown inventories unknown; a missing reserve count is not zero.
function availableStock(product) {
  const stock = product?.stocks;
  if (!stock || !Array.isArray(stock.stocks)) return null;
  if (!stock.stocks.length) return stock.has_stock === false ? 0 : null;
  const seen = new Map();
  let total = 0;
  for (const row of stock.stocks) {
    const present = count(row?.present), reserved = count(row?.reserved);
    if (present === null || reserved === null || !text(row?.source) || !identifier(row?.sku)) return null;
    const key = [row.source, row.sku, row.warehouse_id ?? ''].join(':');
    const previous = seen.get(key);
    if (previous) {
      if (previous.present !== present || previous.reserved !== reserved) return null;
      continue;
    }
    seen.set(key, { present, reserved });
    total += Math.max(0, present - reserved);
  }
  return Number.isSafeInteger(total) ? total : null;
}

function productRow(productId, priceRow, info, future, timer) {
  const price = priceRow?.price;
  const primaryImage = Array.isArray(info?.primary_image) ? info.primary_image[0] : info?.primary_image;
  // A fallback is a complete alternative price source, never a way to attach
  // another response's currency to an incomplete /info/prices amount.
  const fallback = priceRow === undefined ? future : null;
  return {
    productId, offerId: text(info?.offer_id) ?? text(priceRow?.offer_id) ?? text(future?.offer_id),
    sku: identifier(info?.sku) ?? identifier(future?.sku), name: text(info?.name) ?? text(future?.name),
    imageUrl: text(primaryImage) ?? text(info?.images?.[0]),
    categoryId: identifier(info?.description_category_id), typeId: identifier(info?.type_id),
    currency: currency(price?.currency_code) ?? currency(fallback?.currency),
    basePrice: decimal(price?.price) ?? decimal(fallback?.price),
    currentPrice: decimal(price?.marketing_seller_price) ?? decimal(fallback?.marketplace_seller_price),
    minPrice: decimal(price?.min_price) ?? decimal(fallback?.min_seller_price), netPrice: decimal(price?.net_price),
    availableStock: availableStock(info), archived: boolean(info?.is_archived),
    status: text(info?.status) ?? text(info?.statuses?.status_name),
    autoAddEnabled: boolean(price?.auto_add_to_ozon_actions_list_enabled),
    minPriceEnabled: boolean(timer?.min_price_for_auto_actions_enabled), minPriceExpiresAt: iso(timer?.expired_at),
  };
}

function inputRows(rows, getId) {
  if (!Array.isArray(rows)) throw invalidInput();
  const seen = new Set();
  for (const row of rows) {
    const id = requiredId(getId(row), invalidInput);
    if (seen.has(id)) throw invalidInput();
    seen.add(id);
  }
  return rows;
}

function knownResult(ids, accepted, rejected) {
  if (!Array.isArray(accepted) || !Array.isArray(rejected)) throw unknownResult();
  const expected = new Set(ids), seen = new Set();
  const take = value => {
    const id = identifier(value);
    if (!id || !expected.has(id) || seen.has(id)) throw unknownResult();
    seen.add(id); return id;
  };
  const result = {
    acceptedIds: accepted.map(take),
    rejected: rejected.map(row => ({ productId: take(row?.productId), reason: text(row?.reason) || 'ZONGZI_REJECTED' })),
  };
  if (seen.size !== expected.size) throw unknownResult();
  return result;
}
function actionResult(response, ids, future = false) {
  const result = future ? response : response?.result;
  if (!result || !Array.isArray(result.product_ids) || result.rejected !== undefined && !Array.isArray(result.rejected)) throw unknownResult();
  return knownResult(ids, result.product_ids, (result.rejected || []).map(row => ({ productId: row?.product_id, reason: row?.reason })));
}
function priceResult(response, ids) {
  if (!Array.isArray(response?.result)) throw unknownResult();
  const accepted = [], rejected = [];
  for (const row of response.result) {
    if (row?.errors !== undefined && !Array.isArray(row.errors)) throw unknownResult();
    if (row?.updated === true && !(row.errors?.length)) accepted.push(row.product_id);
    else if (row?.updated === false) rejected.push({ productId: row.product_id, reason: (row.errors || []).map(error => [text(error?.code), text(error?.message)].filter(Boolean).join(': ')).filter(Boolean).join('; ') || 'PRICE_UPDATE_REJECTED' });
    else throw unknownResult();
  }
  return knownResult(ids, accepted, rejected);
}

export function createPromotionOzon({ call = callOzonSellerApi, get = getOzonSellerApi } = {}) {
  // Total governs completion: real final pages can still carry a cursor, and
  // short non-final pages must continue. Never publish a truncated snapshot.
  async function pages(credential, path, body, { field = 'products', cursor = 'last_id', nested = true, idField = 'id', limit = 100 } = {}) {
    const rows = [], seen = new Set(), cursors = new Set();
    let next = '', total = null;
    while (true) {
      const payload = { ...body, limit, ...(cursor === 'offset' ? { offset: rows.length } : next ? { [cursor]: next } : {}) };
      const response = await call(credential, path, payload);
      const page = nested ? response?.result : response;
      const items = array(page?.[field]), pageTotal = count(page?.total);
      if (pageTotal === null || total !== null && pageTotal !== total) throw invalidResponse();
      total = pageTotal;
      for (const item of items) {
        const id = requiredId(item?.[idField]);
        if (seen.has(id)) throw invalidResponse();
        seen.add(id); rows.push(item);
      }
      if (rows.length > total) throw invalidResponse();
      if (rows.length === total) return rows;
      if (!items.length) throw invalidResponse();
      if (cursor !== 'offset') {
        next = typeof page[cursor] === 'number' && Number.isSafeInteger(page[cursor]) ? String(page[cursor]) : text(page[cursor]);
        if (!next || cursors.has(next)) throw invalidResponse();
        cursors.add(next);
      }
    }
  }

  async function snapshot(credential) {
    const rawActions = array((await get(credential, '/v1/actions'))?.result);
    const prices = await pages(credential, '/v5/product/info/prices', { filter: { visibility: 'ALL' } }, { field: 'items', cursor: 'cursor', nested: false, idField: 'product_id', limit: 1000 });
    const priceMap = new Map(prices.map(row => [requiredId(row.product_id), row]));
    const productIds = new Set(priceMap.keys()), futures = new Map(), infoMap = new Map(), timers = new Map();
    const actions = [], memberships = [], actionIds = new Set();
    for (const raw of rawActions) {
      const id = requiredId(raw?.id);
      if (actionIds.has(id)) throw invalidResponse();
      actionIds.add(id);
      const autoAddDates = raw.auto_add_dates == null ? [] : array(raw.auto_add_dates);
      if (autoAddDates.some(date => !iso(date)) || new Set(autoAddDates).size !== autoAddDates.length) throw invalidResponse();
      const candidates = await pages(credential, '/v1/actions/candidates', { action_id: numericId(id) });
      actions.push({ id, title: text(raw.title), type: text(raw.action_type), startAt: iso(raw.date_start), endAt: iso(raw.date_end), freezeAt: iso(raw.freeze_date), autoAddDates, candidates: candidates.map(row => {
        const productId = requiredId(row.id); productIds.add(productId);
        return { productId, maxPrice: decimal(row.max_action_price), minQuantity: count(row.min_stock) };
      }) });
      const current = await pages(credential, '/v1/actions/products', { action_id: numericId(id) });
      for (const row of current) {
        const productId = requiredId(row.id); productIds.add(productId);
        memberships.push({ actionId: id, productId, batchAt: '', mode: mode(row.add_mode), price: decimal(row.action_price), quantity: count(row.stock), currency: null });
      }
      for (const batchAt of autoAddDates) {
        const futureRows = await pages(credential, '/v1/actions/auto-add/products/list', { action_id: id, auto_add_date: batchAt }, { cursor: 'offset', nested: false, idField: 'product_id' });
        for (const row of futureRows) {
          const productId = requiredId(row.product_id); productIds.add(productId);
          if (!futures.has(productId)) futures.set(productId, row);
          memberships.push({ actionId: id, productId, batchAt, mode: mode(row.add_mode), price: decimal(row.action_price_to_auto_add), quantity: count(row.quantity_to_auto_add), currency: currency(row.currency) });
        }
      }
    }
    const ids = [...productIds];
    for (let at = 0; at < ids.length; at += 1000) {
      const chunk = ids.slice(at, at + 1000), requested = new Set(chunk);
      const response = await call(credential, '/v3/product/info/list', { product_id: chunk });
      for (const info of array(response?.items ?? response?.result?.items)) {
        const id = requiredId(info?.id ?? info?.product_id);
        if (!requested.has(id) || infoMap.has(id)) throw invalidResponse();
        infoMap.set(id, info);
      }
      const timerResponse = await call(credential, '/v1/product/action/timer/status', { product_ids: chunk });
      for (const timer of array(timerResponse?.statuses)) {
        const id = requiredId(timer?.product_id);
        if (!requested.has(id) || timers.has(id)) throw invalidResponse();
        timers.set(id, timer);
      }
    }
    const products = ids.map(id => productRow(id, priceMap.get(id), infoMap.get(id), futures.get(id), timers.get(id)));
    const productMap = new Map(products.map(row => [row.productId, row]));
    for (const member of memberships) if (!member.batchAt) member.currency = productMap.get(member.productId).currency;
    return { actions, products, memberships, fetchedAt: new Date().toISOString() };
  }

  // An execution-time view of one action/batch and the requested products.
  // JOIN can include other actions' memberships without expanding candidates or products.
  // The caller must keep this partial view separate from the persisted snapshot.
  async function refreshTargets(credential, { operation, actionId, batchAt, productIds, includeAllMemberships = false } = {}) {
    if (!['JOIN', 'EXIT', 'CANCEL_FUTURE', 'SET_FLOOR', 'RENEW_FLOOR'].includes(operation)) throw invalidInput();
    const ids = inputRows(productIds, id => id).map(id => requiredId(id, invalidInput));
    const floors = operation === 'SET_FLOOR' || operation === 'RENEW_FLOOR';
    const allMemberships = operation === 'JOIN' && includeAllMemberships === true;
    const actionKey = floors ? null : requiredId(actionId, invalidInput);
    const actionNumber = operation === 'JOIN' || operation === 'EXIT' ? numericId(actionKey) : null;
    if (operation === 'CANCEL_FUTURE' && !iso(batchAt)) throw invalidInput();
    const targets = new Set(ids), actions = [], memberships = [];
    const priceMap = new Map(), infoMap = new Map(), timers = new Map(), futures = new Map();
    if (!ids.length) return { actions, products: [], memberships, fetchedAt: new Date().toISOString() };

    if (!floors) {
      const rawActions = array((await get(credential, '/v1/actions'))?.result);
      const matches = rawActions.filter(raw => requiredId(raw?.id) === actionKey);
      if (matches.length > 1) throw invalidResponse();
      const actionIds = new Set();
      for (const raw of allMemberships ? rawActions : matches) {
        const id = requiredId(raw.id);
        if (actionIds.has(id)) throw invalidResponse();
        actionIds.add(id);
        const autoAddDates = raw.auto_add_dates == null ? [] : array(raw.auto_add_dates);
        if (autoAddDates.some(date => !iso(date)) || new Set(autoAddDates).size !== autoAddDates.length) throw invalidResponse();
        if (id === actionKey) {
          const candidates = operation === 'JOIN'
            ? await pages(credential, '/v1/actions/candidates', { action_id: actionNumber }) : [];
          actions.push({
            id, title: text(raw.title), type: text(raw.action_type), startAt: iso(raw.date_start), endAt: iso(raw.date_end),
            freezeAt: iso(raw.freeze_date), autoAddDates,
            candidates: candidates.filter(row => targets.has(String(row.id))).map(row => ({ productId: String(row.id), maxPrice: decimal(row.max_action_price), minQuantity: count(row.min_stock) })),
          });
        }
        if (operation === 'JOIN' || operation === 'EXIT') {
          const rows = await pages(credential, '/v1/actions/products', { action_id: numericId(id) });
          for (const row of rows) {
            const productId = String(row.id);
            if (targets.has(productId)) memberships.push({ actionId: id, productId, batchAt: '', mode: mode(row.add_mode), price: decimal(row.action_price), quantity: count(row.stock), currency: null });
          }
        }
        const futureDates = allMemberships ? autoAddDates : [];
        if (operation === 'CANCEL_FUTURE') {
          const currentBatch = autoAddDates.find(date => Date.parse(date) === Date.parse(batchAt));
          // A removed batch is an observed absence; querying its old date can
          // return 404 and is unnecessary for deciding to skip cancellation.
          if (currentBatch) futureDates.push(currentBatch);
        }
        for (const date of futureDates) {
          const rows = await pages(credential, '/v1/actions/auto-add/products/list', { action_id: id, auto_add_date: date }, { cursor: 'offset', nested: false, idField: 'product_id' });
          for (const row of rows) {
            const productId = String(row.product_id);
            if (!targets.has(productId)) continue;
            if (operation === 'CANCEL_FUTURE') futures.set(productId, row);
            memberships.push({ actionId: id, productId, batchAt: date, mode: mode(row.add_mode), price: decimal(row.action_price_to_auto_add), quantity: count(row.quantity_to_auto_add), currency: currency(row.currency) });
          }
        }
      }
    }

    for (let at = 0; at < ids.length; at += 1000) {
      const chunk = ids.slice(at, at + 1000), requested = new Set(chunk);
      const prices = await pages(credential, '/v5/product/info/prices', { filter: { product_id: chunk, visibility: 'ALL' } }, { field: 'items', cursor: 'cursor', nested: false, idField: 'product_id', limit: 1000 });
      for (const row of prices) {
        const id = String(row.product_id);
        if (!requested.has(id)) throw invalidResponse();
        priceMap.set(id, row);
      }
      if (operation === 'JOIN') {
        const response = await call(credential, '/v3/product/info/list', { product_id: chunk });
        for (const info of array(response?.items ?? response?.result?.items)) {
          const id = requiredId(info?.id ?? info?.product_id);
          if (!requested.has(id) || infoMap.has(id)) throw invalidResponse();
          infoMap.set(id, info);
        }
      }
      if (floors) {
        const response = await call(credential, '/v1/product/action/timer/status', { product_ids: chunk });
        for (const timer of array(response?.statuses)) {
          const id = requiredId(timer?.product_id);
          if (!requested.has(id) || timers.has(id)) throw invalidResponse();
          timers.set(id, timer);
        }
      }
    }
    const products = ids.map(id => productRow(id, priceMap.get(id), infoMap.get(id), futures.get(id), timers.get(id)));
    const productsById = new Map(products.map(row => [row.productId, row]));
    for (const member of memberships) if (!member.batchAt) member.currency = productsById.get(member.productId).currency;
    return { actions, products, memberships, fetchedAt: new Date().toISOString() };
  }

  async function write(credential, path, payload) {
    try { return await call(credential, path, payload); }
    catch (error) {
      if (error?.status >= 400 && error.status < 500 && !error?.body?.network) throw error;
      throw unknownResult(error);
    }
  }
  async function batches(rows, run) {
    const result = { acceptedIds: [], rejected: [] };
    for (let at = 0; at < rows.length; at += 1000) {
      try {
        const next = await run(rows.slice(at, at + 1000));
        result.acceptedIds.push(...next.acceptedIds); result.rejected.push(...next.rejected);
      } catch (error) {
        if (result.acceptedIds.length || result.rejected.length) error.partialResult = result;
        throw error;
      }
    }
    return result;
  }

  async function activate(credential, { actionId, products } = {}) {
    const action_id = numericId(actionId);
    const rows = inputRows(products, row => row?.productId).map(row => {
      const price = writePrice(row.price), stock = row.quantity == null ? null : count(row.quantity);
      if (row.quantity != null && (stock === null || stock < 1)) throw invalidInput();
      const [whole, fraction = ''] = price.split('.');
      if (Number(price).toFixed(2) !== `${BigInt(whole)}.${fraction.padEnd(2, '0')}`) throw invalidInput();
      return { product_id: numericId(row.productId), action_price: Number(price), ...(stock === null ? {} : { stock }) };
    });
    return batches(rows, async chunk => actionResult(await write(credential, '/v1/actions/products/activate', { action_id, products: chunk }), chunk.map(row => String(row.product_id))));
  }
  async function deactivate(credential, { actionId, productIds } = {}) {
    const action_id = numericId(actionId), ids = inputRows(productIds, id => id).map(numericId);
    return batches(ids, async chunk => actionResult(await write(credential, '/v1/actions/products/deactivate', { action_id, product_ids: chunk }), chunk.map(String)));
  }
  async function cancelFuture(credential, { actionId, batchAt, productIds } = {}) {
    const action_id = requiredId(actionId, invalidInput), ids = inputRows(productIds, id => id).map(id => requiredId(id, invalidInput));
    if (!iso(batchAt)) throw invalidInput();
    return batches(ids, async chunk => actionResult(await write(credential, '/v1/actions/auto-add/products/delete', { action_id, auto_add_date: batchAt, product_ids: chunk }), chunk, true));
  }
  async function protectPrices(credential, { products } = {}) {
    const rows = inputRows(products, row => row?.productId).map(row => {
      const currency_code = currency(row.currency);
      if (!currency_code) throw invalidInput();
      return { product_id: numericId(row.productId), min_price: writePrice(row.minPrice), currency_code, min_price_for_auto_actions_enabled: true };
    });
    return batches(rows, async chunk => priceResult(await write(credential, '/v1/product/import/prices', { prices: chunk }), chunk.map(row => String(row.product_id))));
  }
  async function renewPrices(credential, { productIds } = {}) {
    const ids = inputRows(productIds, id => id).map(id => requiredId(id, invalidInput));
    return batches(ids, async chunk => {
      const started = Date.now();
      const response = await write(credential, '/v1/product/action/timer/update', { product_ids: chunk });
      // The documented 200 has no per-product result. Confirm the 30-day timer
      // with a read instead of inventing accepted IDs from an empty body.
      if (response != null && (typeof response !== 'object' || Array.isArray(response) || Object.keys(response).length)) throw unknownResult();
      let status;
      try { status = await call(credential, '/v1/product/action/timer/status', { product_ids: chunk }); }
      catch (error) { throw unknownResult(error); }
      if (!Array.isArray(status?.statuses)) throw unknownResult();
      const accepted = [];
      for (const row of status.statuses) {
        // One minute allows server clock/second precision differences, not an
        // old timer with days of validity remaining.
        if (row?.min_price_for_auto_actions_enabled !== true || !iso(row.expired_at) || Date.parse(row.expired_at) < started + 30 * 86400000 - 60000) throw unknownResult();
        accepted.push(row.product_id);
      }
      return knownResult(chunk, accepted, []);
    });
  }
  return { snapshot, refreshTargets, activate, deactivate, cancelFuture, protectPrices, renewPrices };
}
