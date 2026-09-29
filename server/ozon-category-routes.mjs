function requestContext(dependencies, req, state, url) {
  if (typeof dependencies.resolveContext === "function") return dependencies.resolveContext(req, state, url);
  const account = dependencies.requireAuth(req, state);
  const storeId = dependencies.storeIdForAccountRequest(
    state,
    account,
    url.searchParams.get("storeId") || req.headers["x-ozon-store-id"] || "",
  );
  const store = dependencies.activeStore(state, storeId, account.id);
  if (!store) {
    const error = new Error("店铺不存在或不属于当前账号");
    error.status = 404;
    error.code = "STORE_NOT_FOUND";
    throw error;
  }
  return { account, store };
}

function requiredPositiveIdOf(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    const error = new Error(CATEGORY_ERROR_MESSAGE);
    error.status = 400;
    error.code = "ZONGZI_CATEGORY_DATA_INVALID";
    error.body = { operation: "INPUT" };
    error.cause = null;
    throw error;
  }
  return id;
}

async function respondCategory(dependencies, res, operation) {
  try {
    await operation();
  } catch (error) {
    if (STABLE_CATEGORY_ERROR_CODES.has(error?.code)) {
      const status = Number(error.status);
      if (error.diagnostic && typeof dependencies.reportError === "function") {
        dependencies.reportError(error.diagnostic);
      }
      dependencies.sendError(
        res,
        CATEGORY_ERROR_STATUSES.has(status) ? status : 502,
        CATEGORY_ERROR_MESSAGE,
        error.code,
      );
      return;
    }
    throw error;
  }
}

export function createOzonCategoryRouteHandler(dependencies) {
  return async function handleOzonCategoryRoute({ req, res, url, state }) {
    if (req.method === "GET" && url.pathname === "/ozon/categories/tree") {
      await respondCategory(dependencies, res, async () => {
        const { account, store } = await requestContext(dependencies, req, state, url);
        const language = url.searchParams.get("language") || "DEFAULT";
        const result = await dependencies.categoryService.getCategoryTree({
          accountId: account.id,
          store,
          language,
        });
        dependencies.sendJson(res, 200, {
          data: result.items,
          items: result.items,
          total: result.items.length,
          language,
          meta: result.meta,
        });
      });
      return true;
    }

    const attributesMatch = url.pathname.match(
      /^\/ozon\/description-category\/([^/]+)\/attributes$/,
    );
    if (req.method === "GET" && attributesMatch) {
      await respondCategory(dependencies, res, async () => {
        const { account, store } = await requestContext(dependencies, req, state, url);
        const typeId = requiredPositiveIdOf(decodeURIComponent(attributesMatch[1]));
        const requestedCategoryId =
          url.searchParams.get("descriptionCategoryId")
          || url.searchParams.get("description_category_id")
          || "";
        if (requestedCategoryId) requiredPositiveIdOf(requestedCategoryId);
        const descriptionCategoryId = requiredPositiveIdOf(
          await dependencies.categoryService.resolveDescriptionCategoryId({
            accountId: account.id,
            store,
            typeId,
            language: "DEFAULT",
          }),
        );
        const verifiedContext = await requestContext(dependencies, req, state, url);
        const result = await dependencies.categoryService.getCategoryAttributes({
          accountId: verifiedContext.account.id,
          store: verifiedContext.store,
          descriptionCategoryId,
          typeId,
          language: "DEFAULT",
        });
        dependencies.sendJson(res, 200, {
          data: result.items,
          items: result.items,
          total: result.items.length,
          typeId,
          categoryId: descriptionCategoryId,
          meta: result.meta,
        });
      });
      return true;
    }

    const valuesMatch = url.pathname.match(
      /^\/ozon\/description-category\/([^/]+)\/attributes\/([^/]+)\/values$/,
    );
    if (req.method === "GET" && valuesMatch) {
      await respondCategory(dependencies, res, async () => {
        const { account, store } = await requestContext(dependencies, req, state, url);
        const typeId = requiredPositiveIdOf(decodeURIComponent(valuesMatch[1]));
        const attributeId = requiredPositiveIdOf(decodeURIComponent(valuesMatch[2]));
        const requestedCategoryId =
          url.searchParams.get("descriptionCategoryId")
          || url.searchParams.get("description_category_id")
          || "";
        if (requestedCategoryId) requiredPositiveIdOf(requestedCategoryId);
        const descriptionCategoryId = requiredPositiveIdOf(
          await dependencies.categoryService.resolveDescriptionCategoryId({
            accountId: account.id,
            store,
            typeId,
            language: "DEFAULT",
          }),
        );
        const verifiedContext = await requestContext(dependencies, req, state, url);
        const result = await dependencies.categoryService.getCategoryAttributeValues({
          accountId: verifiedContext.account.id,
          store: verifiedContext.store,
          descriptionCategoryId,
          typeId,
          attributeId,
          language: "DEFAULT",
          limit: url.searchParams.get("limit") || 1000,
        });
        dependencies.sendJson(res, 200, {
          data: result.items,
          items: result.items,
          total: result.items.length,
          typeId,
          categoryId: descriptionCategoryId,
          attributeId,
          meta: result.meta,
        });
      });
      return true;
    }

    return false;
  };
}
const STABLE_CATEGORY_ERROR_CODES = new Set([
  "ZONGZI_CATEGORY_TREE_UNAVAILABLE",
  "ZONGZI_CATEGORY_ATTRIBUTES_UNAVAILABLE",
  "ZONGZI_CATEGORY_VALUES_UNAVAILABLE",
  "ZONGZI_CATEGORY_DATA_INVALID",
  "ZONGZI_CATEGORY_TYPE_NOT_FOUND",
]);
const CATEGORY_ERROR_MESSAGE = "未能从 Ozon 获取真实类目数据，请重试";
const CATEGORY_ERROR_STATUSES = new Set([400, 422, 502, 503, 504]);
