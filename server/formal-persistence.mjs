import crypto from "node:crypto";
import { encryptSecret } from "./crypto-secrets.mjs";
import { runMigrations } from "./db/migrate.mjs";

let formalSchemaReady = false;

function json(value) {
  return JSON.stringify(value || {});
}

function text(value, max = 1000) {
  return String(value ?? "").trim().slice(0, max);
}

function dateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function bool(value, fallback = false) {
  if (value === true || value === false) return value;
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (["true", "1", "yes", "active"].includes(normalized)) return true;
    if (["false", "0", "no", "archived", "disabled"].includes(normalized)) return false;
  }
  return fallback;
}

function num(value) {
  if (value && typeof value === "object") return num(value.price || value.value);
  const parsed = Number(String(value ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function int(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}

function stableId(prefix, parts) {
  const raw = parts.map((part) => String(part ?? "")).join("|");
  return `${prefix}_${crypto.createHash("sha256").update(raw).digest("hex").slice(0, 24)}`;
}

function urlString(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return /^https?:\/\//i.test(raw) || raw.startsWith("/") ? raw : "";
}

function keyValue(value = {}, keys = []) {
  for (const key of keys) {
    const found = value?.[key];
    if (found !== undefined && found !== null && found !== "") return found;
  }
  return "";
}

const videoExtensionPattern = /\.(mp4|m4v|mov|webm|avi|mpeg|mpg|m3u8)(?:[?#].*)?$/i;
const imageExtensionPattern = /\.(png|jpe?g|webp|gif|bmp|avif|heic|tiff?)(?:[?#].*)?$/i;

function isVideoUrl(value) {
  const url = urlString(value);
  if (!url) return false;
  try {
    return videoExtensionPattern.test(new URL(url, "http://local.invalid").pathname);
  } catch {
    return videoExtensionPattern.test(url);
  }
}

function isImageUrl(value) {
  const url = urlString(value);
  if (!url || isVideoUrl(url)) return false;
  try {
    const pathname = new URL(url, "http://local.invalid").pathname;
    return imageExtensionPattern.test(pathname) || !/\.[a-z0-9]{2,5}$/i.test(pathname);
  } catch {
    return imageExtensionPattern.test(url) || !/\.[a-z0-9]{2,5}(?:[?#].*)?$/i.test(url);
  }
}

function mediaToken(value = {}) {
  return [
    value.type,
    value.kind,
    value.media_type,
    value.mediaType,
    value.content_type,
    value.contentType,
    value.mime_type,
    value.mimeType,
    value.asset_type,
    value.assetType,
    value.name,
    value.title,
  ].map((part) => String(part || "").toLowerCase()).join(" ");
}

function objectLooksVideo(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const token = mediaToken(value);
  if (token.includes("video") || token.includes("видео")) return true;
  return [
    value.video,
    value.video_url,
    value.videoUrl,
    value.video_urls,
    value.videoUrls,
    value.file_url,
    value.fileUrl,
    value.url,
    value.src,
    value.link,
    value.href,
    value.value,
  ].some(isVideoUrl);
}

function objectLooksImage(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const token = mediaToken(value);
  if (token.includes("image") || token.includes("picture") || token.includes("photo")) return true;
  return [
    value.image,
    value.image_url,
    value.imageUrl,
    value.picture,
    value.picture_url,
    value.url,
    value.src,
    value.file_name,
  ].some(isImageUrl);
}

function guessVideoMimeType(value) {
  const url = String(value || "").toLowerCase();
  if (url.includes(".webm")) return "video/webm";
  if (url.includes(".mov")) return "video/quicktime";
  if (url.includes(".m3u8")) return "application/vnd.apple.mpegurl";
  if (url.includes(".avi")) return "video/x-msvideo";
  if (url.includes(".mpeg") || url.includes(".mpg")) return "video/mpeg";
  if (url.includes(".mp4") || url.includes(".m4v")) return "video/mp4";
  return "";
}

function intOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

function numOrNull(value) {
  const parsed = num(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function collectImageUrls(value, urls = []) {
  if (!value) return urls;
  if (typeof value === "string") {
    if (isImageUrl(value)) urls.push(urlString(value));
    return urls;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectImageUrls(item, urls);
    return urls;
  }
  if (typeof value === "object") {
    if (objectLooksVideo(value) && !objectLooksImage(value)) return urls;
    collectImageUrls(
      keyValue(value, [
        "primary_image",
        "primaryImage",
        "image",
        "image_url",
        "imageUrl",
        "picture",
        "picture_url",
        "pictureUrl",
        "photo",
        "photo_url",
        "thumbnail",
        "thumbnail_url",
        "preview",
        "preview_url",
        "cover",
        "cover_url",
        "url",
        "src",
        "file_name",
        "fileName",
        "file_url",
        "fileUrl",
      ]),
      urls,
    );
  }
  return urls;
}

function productImageUrls(product = {}) {
  const urls = [];
  collectImageUrls(product.primary_image, urls);
  collectImageUrls(product.primaryImage, urls);
  collectImageUrls(product.image, urls);
  collectImageUrls(product.image_url, urls);
  collectImageUrls(product.imageUrl, urls);
  collectImageUrls(product.images, urls);
  collectImageUrls(product.images360, urls);
  collectImageUrls(product.pictures, urls);
  collectImageUrls(product.media, urls);
  return [...new Set(urls)].slice(0, 80);
}

function imageCoverUrl(value = {}) {
  if (!value || typeof value !== "object") return "";
  const candidates = [
    value.cover,
    value.cover_url,
    value.coverUrl,
    value.thumbnail,
    value.thumbnail_url,
    value.thumbnailUrl,
    value.preview,
    value.preview_url,
    value.previewUrl,
    value.image,
    value.image_url,
    value.imageUrl,
    value.picture,
    value.picture_url,
    value.pictureUrl,
  ];
  return candidates.map(urlString).find((candidate) => candidate && !isVideoUrl(candidate)) || "";
}

function collectVideoAssets(value, assets = [], forceVideo = false) {
  if (!value) return assets;
  if (typeof value === "string") {
    if (isVideoUrl(value) || (forceVideo && urlString(value))) {
      const url = urlString(value);
      assets.push({
        url,
        mimeType: guessVideoMimeType(url),
        raw: { value: url },
      });
    }
    return assets;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectVideoAssets(item, assets, forceVideo);
    return assets;
  }
  if (typeof value !== "object") return assets;

  const directUrl = [
    value.video,
    value.video_url,
    value.videoUrl,
    value.video_urls,
    value.videoUrls,
    value.file_url,
    value.fileUrl,
    value.url,
    value.src,
    value.link,
    value.href,
    value.value,
  ].map(urlString).find((candidate) => candidate && (objectLooksVideo(value) || isVideoUrl(candidate) || forceVideo));

  if (directUrl && (objectLooksVideo(value) || isVideoUrl(directUrl) || forceVideo)) {
    assets.push({
      url: directUrl,
      coverUrl: imageCoverUrl(value),
      mimeType: text(
        value.mime_type ||
          value.mimeType ||
          value.content_type ||
          value.contentType ||
          guessVideoMimeType(directUrl),
        120,
      ),
      width: intOrNull(value.width || value.video_width || value.videoWidth),
      height: intOrNull(value.height || value.video_height || value.videoHeight),
      durationSeconds: numOrNull(value.duration_seconds || value.durationSeconds || value.duration || value.length),
      externalId: text(value.id || value.video_id || value.videoId || value.external_id || value.externalId, 180),
      raw: value,
    });
  }

  for (const [key, explicitVideo] of [
    ["video", true],
    ["video_url", true],
    ["videoUrl", true],
    ["video_urls", true],
    ["videoUrls", true],
    ["videos", true],
    ["video_links", true],
    ["videoLinks", true],
    ["media", false],
    ["values", forceVideo || objectLooksVideo(value)],
    ["attributes", false],
    ["complex_attributes", false],
    ["complexAttributes", false],
  ]) {
    if (value[key] !== undefined) collectVideoAssets(value[key], assets, explicitVideo);
  }
  return assets;
}

function productVideoAssets(product = {}) {
  const assets = [];
  collectVideoAssets(product.video, assets, true);
  collectVideoAssets(product.video_url, assets, true);
  collectVideoAssets(product.videoUrl, assets, true);
  collectVideoAssets(product.video_urls, assets, true);
  collectVideoAssets(product.videoUrls, assets, true);
  collectVideoAssets(product.videos, assets, true);
  collectVideoAssets(product.video_links, assets, true);
  collectVideoAssets(product.videoLinks, assets, true);
  collectVideoAssets(product.media, assets);
  collectVideoAssets(product.attributes, assets);
  collectVideoAssets(product.complex_attributes, assets);
  collectVideoAssets(product.complexAttributes, assets);

  const unique = new Map();
  for (const asset of assets) {
    const url = urlString(asset.url);
    if (!url || unique.has(url)) continue;
    unique.set(url, {
      url,
      coverUrl: text(asset.coverUrl, 1200),
      mimeType: text(asset.mimeType || guessVideoMimeType(url), 120),
      width: intOrNull(asset.width),
      height: intOrNull(asset.height),
      durationSeconds: numOrNull(asset.durationSeconds),
      externalId: text(asset.externalId, 180),
      raw: asset.raw || { originUrl: url },
    });
  }
  return Array.from(unique.values()).slice(0, 40);
}

function firstImage(product = {}) {
  return productImageUrls(product)[0] || "";
}

function productName(product = {}) {
  return text(product.name || product.title || product.product_name || product.offer_name || product.marketing_name, 800);
}

function productStatus(product = {}) {
  return text(
    product.status ||
      product.state ||
      product.visible ||
      product.visibility ||
      product.listVisibility ||
      product.price_info?.visibility ||
      "",
    120,
  );
}

function productCurrency(product = {}, store = {}) {
  return text(
    product.currency_code ||
      product.currencyCode ||
      product.price?.currency_code ||
      product.price_info?.price?.currency_code ||
      product.marketing_price_currency ||
      store.currencyCode ||
      store.currency ||
      "RUB",
    12,
  ).toUpperCase();
}

function currentProductPrice(product = {}) {
  const candidates = [
    product.price_info?.price?.marketing_price,
    product.price_info?.marketing_price,
    product.marketing_price,
    product.price_info?.price?.price,
    product.price_info?.price,
    product.price,
  ];
  return candidates.map(num).find((value) => value !== null) ?? null;
}

function originalProductPrice(product = {}) {
  return [
    product.price_info?.price?.old_price,
    product.price_info?.old_price,
    product.old_price,
    product.price_info?.price?.retail_price,
    product.retail_price,
  ].map(num).find((value) => value !== null) ?? null;
}

function marketingProductPrice(product = {}) {
  return [
    product.price_info?.price?.marketing_price,
    product.price_info?.marketing_price,
    product.marketing_price,
  ].map(num).find((value) => value !== null) ?? null;
}

function stockRows(product = {}) {
  const explicit = Array.isArray(product.warehouse_stocks) ? product.warehouse_stocks : [];
  const nested = Array.isArray(product.stocks?.stocks) ? product.stocks.stocks : [];
  return [...explicit, ...nested];
}

function stockPresent(row = {}) {
  return int(row.present ?? row.stock ?? row.available ?? row.quantity ?? row.free_to_sell ?? row.free_to_sell_amount, 0);
}

function productStockTotal(product = {}) {
  const rows = stockRows(product);
  if (rows.length) return rows.reduce((sum, row) => sum + stockPresent(row), 0);
  return int(product.stocks?.present ?? product.stock ?? product.available_stock ?? product.quantity, 0);
}

function productStoreId(product = {}, state = {}) {
  return text(product.storeId || product.store_id || product.ozonStoreId || product.localStoreId || state.currentStoreId, 160);
}

function storeById(state = {}) {
  return new Map((state.stores || []).map((store) => [String(store.id), store]));
}

function productIdentity(product = {}, state = {}) {
  const storeId = productStoreId(product, state);
  const productId = text(product.product_id || product.productId || product.id, 160);
  const sku = text(product.sku || product.ozon_sku, 160);
  const offerId = text(product.offer_id || product.offerId || product.item_code, 240);
  return {
    id: stableId("prod", [storeId, productId, sku, offerId]),
    storeId,
    productId,
    sku,
    offerId,
  };
}

function warehouseIdentity(row = {}, storeId = "") {
  const warehouseId = text(row.warehouse_id || row.warehouseId || row.id, 160);
  const name = text(row.name || row.warehouse_name || row.warehouseName || row.delivery_method_name || row.source || "未命名仓库", 240);
  return {
    id: stableId("wh", [storeId, warehouseId || name]),
    warehouseId,
    name,
  };
}

function productPriceRows(product = {}, productDbId = "", storeId = "", currencyCode = "") {
  const rows = [];
  const current = currentProductPrice(product);
  if (current !== null) {
    rows.push({
      id: stableId("price", [productDbId, "current"]),
      productDbId,
      storeId,
      priceType: "current",
      actionId: "",
      actionName: "前台真实销售价",
      price: current,
      currencyCode,
      raw: { source: "current" },
    });
  }
  const original = originalProductPrice(product);
  if (original !== null) {
    rows.push({
      id: stableId("price", [productDbId, "original"]),
      productDbId,
      storeId,
      priceType: "original",
      actionId: "",
      actionName: "商品原售价",
      price: original,
      currencyCode,
      raw: { source: "original" },
    });
  }
  const actions = [
    ...(Array.isArray(product.marketing_actions) ? product.marketing_actions : []),
    ...(Array.isArray(product.price_info?.marketing_actions) ? product.price_info.marketing_actions : []),
  ];
  for (const action of actions) {
    const price = num(action.price ?? action.action_price ?? action.marketing_price ?? action.discount_price);
    if (price === null) continue;
    const actionId = text(action.id || action.action_id || action.actionId || "", 120);
    const actionName = text(action.title || action.name || action.action_name || "活动价", 240);
    rows.push({
      id: stableId("price", [productDbId, "action", actionId, actionName]),
      productDbId,
      storeId,
      priceType: "action",
      actionId,
      actionName,
      price,
      currencyCode,
      startedAt: dateOrNull(action.date_start || action.started_at || action.start_date),
      endedAt: dateOrNull(action.date_end || action.ended_at || action.end_date),
      raw: action,
    });
  }
  return rows;
}

export async function ensureFormalSchema(pool) {
  if (formalSchemaReady) return;
  await runMigrations(pool);
  formalSchemaReady = true;
}

async function mirrorAccounts(client, state = {}) {
  for (const account of state.accounts || []) {
    await client.query(
      `
        INSERT INTO accounts (
          id, username, display_name, role, status, expires_at, password_salt,
          password_hash, password_algorithm, created_at, updated_at, last_login_at, raw
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          username = EXCLUDED.username,
          display_name = EXCLUDED.display_name,
          role = EXCLUDED.role,
          status = EXCLUDED.status,
          expires_at = EXCLUDED.expires_at,
          password_salt = EXCLUDED.password_salt,
          password_hash = EXCLUDED.password_hash,
          password_algorithm = EXCLUDED.password_algorithm,
          updated_at = EXCLUDED.updated_at,
          last_login_at = EXCLUDED.last_login_at,
          raw = EXCLUDED.raw
      `,
      [
        account.id,
        text(account.username, 160),
        text(account.displayName || account.username, 160),
        account.role === "admin" ? "admin" : "user",
        account.status === "disabled" ? "disabled" : "active",
        dateOrNull(account.expiresAt),
        text(account.passwordSalt, 240),
        text(account.passwordHash, 240),
        text(account.passwordAlgorithm || "scrypt", 40),
        dateOrNull(account.createdAt),
        dateOrNull(account.updatedAt),
        dateOrNull(account.lastLoginAt),
        json(account),
      ],
    );
  }
  if (state.token && state.currentAccountId) {
    await client.query(
      `
        INSERT INTO sessions (token, account_id, issued_at, last_seen_at, raw)
        VALUES ($1,$2,$3,NOW(),$4::jsonb)
        ON CONFLICT (token) DO UPDATE SET
          account_id = EXCLUDED.account_id,
          issued_at = EXCLUDED.issued_at,
          last_seen_at = NOW(),
          raw = EXCLUDED.raw
      `,
      [state.token, state.currentAccountId, dateOrNull(state.sessionIssuedAt), json({ current: true })],
    );
  }
}

async function mirrorStores(client, state = {}) {
  for (const store of state.stores || []) {
    const currency = text(store.currencyCode || store.currency || store.companyCurrency || "RUB", 12).toUpperCase();
    await client.query(
      `
        INSERT INTO stores (
          id, label, company_name, legal_name, client_id, inn, tax_id, currency_code,
          is_premium, status, is_current, seller_company_id, saved_at, updated_at,
          profile_synced_at, raw
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          label = EXCLUDED.label,
          company_name = EXCLUDED.company_name,
          legal_name = EXCLUDED.legal_name,
          client_id = EXCLUDED.client_id,
          inn = EXCLUDED.inn,
          tax_id = EXCLUDED.tax_id,
          currency_code = EXCLUDED.currency_code,
          is_premium = EXCLUDED.is_premium,
          status = EXCLUDED.status,
          is_current = EXCLUDED.is_current,
          seller_company_id = EXCLUDED.seller_company_id,
          updated_at = EXCLUDED.updated_at,
          profile_synced_at = EXCLUDED.profile_synced_at,
          raw = EXCLUDED.raw
      `,
      [
        store.id,
        text(store.label, 240),
        text(store.companyName || store.label, 240),
        text(store.legalName || store.companyName || store.label, 240),
        text(store.clientId, 80),
        text(store.inn || store.taxId, 120),
        text(store.taxId || store.inn, 120),
        currency,
        store.isPremium === true,
        text(store.status, 80),
        String(state.currentStoreId || "") === String(store.id),
        text(store.sellerCompanyId, 160),
        dateOrNull(store.savedAt),
        dateOrNull(store.updatedAt || store.savedAt),
        dateOrNull(store.profileSyncedAt),
        json({ ...store, apiKey: store.apiKey ? "__encrypted__" : "" }),
      ],
    );
    if (store.apiKey) {
      const encrypted = encryptSecret(store.apiKey);
      await client.query(
        `
          INSERT INTO store_credentials (
            store_id, client_id, encrypted_api_key, iv, auth_tag, algorithm, key_version, updated_at
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
          ON CONFLICT (store_id) DO UPDATE SET
            client_id = EXCLUDED.client_id,
            encrypted_api_key = EXCLUDED.encrypted_api_key,
            iv = EXCLUDED.iv,
            auth_tag = EXCLUDED.auth_tag,
            algorithm = EXCLUDED.algorithm,
            key_version = EXCLUDED.key_version,
            updated_at = NOW()
        `,
        [
          store.id,
          text(store.clientId, 80),
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.authTag,
          encrypted.algorithm,
          encrypted.keyVersion,
        ],
      );
    }
  }
}

async function mirrorFiles(client, state = {}) {
  for (const file of state.caches?.files || []) {
    await client.query(
      `
        INSERT INTO files (id, bucket, object_key, name, content_type, size, sha256, storage, created_by, created_at, raw)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          bucket = EXCLUDED.bucket,
          object_key = EXCLUDED.object_key,
          name = EXCLUDED.name,
          content_type = EXCLUDED.content_type,
          size = EXCLUDED.size,
          sha256 = EXCLUDED.sha256,
          storage = EXCLUDED.storage,
          raw = EXCLUDED.raw
      `,
      [
        file.id,
        text(file.bucket, 160),
        text(file.key || file.objectKey, 1000),
        text(file.name, 300),
        text(file.contentType, 120),
        int(file.size, 0),
        text(file.sha256, 128),
        text(file.storage || "minio", 40),
        file.createdBy || null,
        dateOrNull(file.createdAt),
        json(file),
      ],
    );
  }
}

async function upsertWarehouse(client, storeId, row = {}) {
  const identity = warehouseIdentity(row, storeId);
  await client.query(
    `
      INSERT INTO warehouses (
        id, store_id, warehouse_id, name, warehouse_type, status, is_active,
        is_archived, synced_at, updated_at, raw
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),$10::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        store_id = EXCLUDED.store_id,
        warehouse_id = EXCLUDED.warehouse_id,
        name = EXCLUDED.name,
        warehouse_type = EXCLUDED.warehouse_type,
        status = EXCLUDED.status,
        is_active = EXCLUDED.is_active,
        is_archived = EXCLUDED.is_archived,
        synced_at = EXCLUDED.synced_at,
        updated_at = NOW(),
        raw = EXCLUDED.raw
    `,
    [
      identity.id,
      storeId || null,
      identity.warehouseId,
      identity.name,
      text(row.warehouse_type || row.type || row.source, 80),
      text(row.status || row.state, 80),
      !bool(row.is_archived || row.archived, false) && row.status !== "ARCHIVED",
      bool(row.is_archived || row.archived, false),
      dateOrNull(row.syncedAt || row.updated_at),
      json(row),
    ],
  );
  return identity;
}

async function mirrorWarehouses(client, state = {}) {
  for (const warehouse of state.caches?.warehouses || []) {
    await upsertWarehouse(client, text(warehouse.storeId || warehouse.store_id || state.currentStoreId, 160), warehouse);
  }
}

async function mirrorProducts(client, state = {}) {
  const stores = storeById(state);
  for (const product of state.caches?.products || []) {
    const identity = productIdentity(product, state);
    const store = stores.get(identity.storeId) || {};
    const currencyCode = productCurrency(product, store);
    await client.query(
      `
        INSERT INTO products (
          id, store_id, product_id, sku, offer_id, name, status, visibility,
          is_archived, currency_code, current_price, original_price, marketing_price,
          stock_total, image_url, synced_at, updated_at, raw
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW(),$17::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          store_id = EXCLUDED.store_id,
          product_id = EXCLUDED.product_id,
          sku = EXCLUDED.sku,
          offer_id = EXCLUDED.offer_id,
          name = EXCLUDED.name,
          status = EXCLUDED.status,
          visibility = EXCLUDED.visibility,
          is_archived = EXCLUDED.is_archived,
          currency_code = EXCLUDED.currency_code,
          current_price = EXCLUDED.current_price,
          original_price = EXCLUDED.original_price,
          marketing_price = EXCLUDED.marketing_price,
          stock_total = EXCLUDED.stock_total,
          image_url = EXCLUDED.image_url,
          synced_at = EXCLUDED.synced_at,
          updated_at = NOW(),
          raw = EXCLUDED.raw
      `,
      [
        identity.id,
        identity.storeId || null,
        identity.productId,
        identity.sku,
        identity.offerId,
        productName(product),
        productStatus(product),
        text(product.visibilityFilter || product.listVisibility || product.visibility, 80),
        product.is_archived === true || product.archived === true || product.visibilityFilter === "ARCHIVED",
        currencyCode,
        currentProductPrice(product),
        originalProductPrice(product),
        marketingProductPrice(product),
        productStockTotal(product),
        text(firstImage(product), 1200),
        dateOrNull(product.syncedAt),
        json(product),
      ],
    );
    for (const price of productPriceRows(product, identity.id, identity.storeId, currencyCode)) {
      await client.query(
        `
          INSERT INTO product_prices (
            id, product_id, store_id, price_type, action_id, action_name, price,
            currency_code, started_at, ended_at, updated_at, raw
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),$11::jsonb)
          ON CONFLICT (id) DO UPDATE SET
            price = EXCLUDED.price,
            currency_code = EXCLUDED.currency_code,
            started_at = EXCLUDED.started_at,
            ended_at = EXCLUDED.ended_at,
            updated_at = NOW(),
            raw = EXCLUDED.raw
        `,
        [
          price.id,
          price.productDbId,
          price.storeId || null,
          price.priceType,
          price.actionId,
          price.actionName,
          price.price,
          price.currencyCode,
          price.startedAt || null,
          price.endedAt || null,
          json(price.raw),
        ],
      );
    }
    const imageUrls = productImageUrls(product);
    for (const [index, imageUrl] of imageUrls.entries()) {
      await client.query(
        `
          INSERT INTO product_assets (
            id, product_id, file_id, asset_type, sort_order, source, origin_url,
            mime_type, width, height, duration_seconds, cover_url, external_id, raw
          )
          VALUES ($1,$2,NULL,$3,$4,'ozon',$5,'',NULL,NULL,NULL,'','',$6::jsonb)
          ON CONFLICT (id) DO UPDATE SET
            asset_type = EXCLUDED.asset_type,
            sort_order = EXCLUDED.sort_order,
            origin_url = EXCLUDED.origin_url,
            mime_type = EXCLUDED.mime_type,
            width = EXCLUDED.width,
            height = EXCLUDED.height,
            duration_seconds = EXCLUDED.duration_seconds,
            cover_url = EXCLUDED.cover_url,
            external_id = EXCLUDED.external_id,
            raw = EXCLUDED.raw
        `,
        [
          stableId("asset", [identity.id, imageUrl, index]),
          identity.id,
          index === 0 ? "main_image" : "gallery_image",
          index,
          text(imageUrl, 1200),
          json({ originUrl: imageUrl }),
        ],
      );
    }
    const videoAssets = productVideoAssets(product);
    for (const [index, asset] of videoAssets.entries()) {
      await client.query(
        `
          INSERT INTO product_assets (
            id, product_id, file_id, asset_type, sort_order, source, origin_url,
            mime_type, width, height, duration_seconds, cover_url, external_id, raw
          )
          VALUES ($1,$2,NULL,'video',$3,'ozon',$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
          ON CONFLICT (id) DO UPDATE SET
            asset_type = EXCLUDED.asset_type,
            sort_order = EXCLUDED.sort_order,
            origin_url = EXCLUDED.origin_url,
            mime_type = EXCLUDED.mime_type,
            width = EXCLUDED.width,
            height = EXCLUDED.height,
            duration_seconds = EXCLUDED.duration_seconds,
            cover_url = EXCLUDED.cover_url,
            external_id = EXCLUDED.external_id,
            raw = EXCLUDED.raw
        `,
        [
          stableId("asset", [identity.id, "video", asset.url, index]),
          identity.id,
          index,
          text(asset.url, 1200),
          text(asset.mimeType, 120),
          asset.width,
          asset.height,
          asset.durationSeconds,
          text(asset.coverUrl, 1200),
          text(asset.externalId, 180),
          json({ ...asset.raw, originUrl: asset.url, coverUrl: asset.coverUrl }),
        ],
      );
    }
    for (const row of stockRows(product)) {
      const warehouse = await upsertWarehouse(client, identity.storeId, row);
      await client.query(
        `
          INSERT INTO product_stocks (
            product_id, warehouse_id, store_id, sku, offer_id, source, present, reserved, updated_at, raw
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9::jsonb)
          ON CONFLICT (product_id, warehouse_id, source) DO UPDATE SET
            sku = EXCLUDED.sku,
            offer_id = EXCLUDED.offer_id,
            present = EXCLUDED.present,
            reserved = EXCLUDED.reserved,
            updated_at = NOW(),
            raw = EXCLUDED.raw
        `,
        [
          identity.id,
          warehouse.id,
          identity.storeId || null,
          text(row.sku || identity.sku, 160),
          text(row.offer_id || row.offerId || identity.offerId, 240),
          text(row.source || row.type || "", 80),
          stockPresent(row),
          int(row.reserved ?? row.reserved_stock, 0),
          json(row),
        ],
      );
    }
  }
}

async function mirrorOrders(client, state = {}) {
  for (const order of state.caches?.postings || []) {
    const storeId = text(order.storeId || order.store_id || state.currentStoreId, 160);
    const postingNumber = text(order.posting_number || order.postingNumber || order.id, 200);
    const orderId = text(order.order_id || order.orderId || "", 200);
    const id = stableId("order", [storeId, postingNumber || orderId || order.id]);
    await client.query(
      `
        INSERT INTO orders (
          id, store_id, posting_number, order_id, status, shipment_type,
          in_process_at, created_at, updated_at, raw
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          shipment_type = EXCLUDED.shipment_type,
          in_process_at = EXCLUDED.in_process_at,
          updated_at = NOW(),
          raw = EXCLUDED.raw
      `,
      [
        id,
        storeId || null,
        postingNumber,
        orderId,
        text(order.status, 120),
        text(order.shipment_type || order.shipmentType, 80),
        dateOrNull(order.in_process_at || order.inProcessAt),
        dateOrNull(order.created_at || order.createdAt),
        json(order),
      ],
    );
    const products = Array.isArray(order.products)
      ? order.products
      : Array.isArray(order.financial_data?.products)
        ? order.financial_data.products
        : [];
    for (const [index, item] of products.entries()) {
      await client.query(
        `
          INSERT INTO order_items (id, order_id, sku, offer_id, name, quantity, price, currency_code, raw)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            quantity = EXCLUDED.quantity,
            price = EXCLUDED.price,
            currency_code = EXCLUDED.currency_code,
            raw = EXCLUDED.raw
        `,
        [
          stableId("order_item", [id, item.sku || item.offer_id || index]),
          id,
          text(item.sku, 160),
          text(item.offer_id || item.offerId, 240),
          text(item.name || item.product_name, 800),
          int(item.quantity, 0),
          num(item.price),
          text(item.currency_code || item.currencyCode, 12),
          json(item),
        ],
      );
    }
  }
}

async function mirrorJobs(client, state = {}) {
  for (const job of Object.values(state.jobs || {})) {
    await client.query(
      `
        INSERT INTO sync_jobs (id, store_id, type, status, fetched_count, error, created_at, updated_at, raw)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          store_id = EXCLUDED.store_id,
          type = EXCLUDED.type,
          status = EXCLUDED.status,
          fetched_count = EXCLUDED.fetched_count,
          error = EXCLUDED.error,
          updated_at = EXCLUDED.updated_at,
          raw = EXCLUDED.raw
      `,
      [
        job.id,
        job.storeId || null,
        text(job.type, 120),
        text(job.status, 80),
        int(job.fetchedCount, 0),
        text(job.error || job.errorMessage, 1000),
        dateOrNull(job.createdAt),
        dateOrNull(job.updatedAt),
        json(job),
      ],
    );
  }
}

export async function mirrorStateToRelationalTables(pool, state = {}) {
  await ensureFormalSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await mirrorAccounts(client, state);
    await mirrorStores(client, state);
    await mirrorFiles(client, state);
    await mirrorWarehouses(client, state);
    await mirrorProducts(client, state);
    await mirrorOrders(client, state);
    await mirrorJobs(client, state);
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original mirror failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function formalPersistenceHealth(pool) {
  await ensureFormalSchema(pool);
  const result = await pool.query(`
    SELECT
      (SELECT COUNT(*)::INT FROM accounts) AS accounts,
      (SELECT COUNT(*)::INT FROM stores) AS stores,
      (SELECT COUNT(*)::INT FROM products) AS products,
      (SELECT COUNT(*)::INT FROM warehouses) AS warehouses,
      (SELECT COUNT(*)::INT FROM product_stocks) AS product_stocks,
      (SELECT COUNT(*)::INT FROM orders) AS orders,
      (SELECT COUNT(*)::INT FROM files) AS files,
      (SELECT COUNT(*)::INT FROM product_assets) AS product_assets,
      (SELECT COUNT(*)::INT FROM product_assets WHERE asset_type IN ('main_image', 'gallery_image')) AS product_image_assets,
      (SELECT COUNT(*)::INT FROM product_assets WHERE asset_type = 'video') AS product_video_assets
  `);
  return {
    ok: true,
    schema: "formal",
    counts: result.rows[0] || {},
  };
}
