# Ozon 类目查询拆分与真实数据门禁设计

日期：2026-07-28
状态：已确认，待实施计划
目标项目：`/Users/songliang/Documents/sonli ozon3.0`

## 目标

把 Ozon 类目树、类目属性和属性字典值查询从 `server/index.mjs` 中拆出，
形成独立、可测试的类目查询边界。

同时删除“从本地已同步商品推断类目或 description_category_id”的兜底。
只有 Ozon 成功返回并通过结构校验的数据才能用于类目选择、AI 判类目、
商品预检和正式上架。

## 已确认的业务决定

1. 类目数据必须来自 Ozon，不能从本地商品、其他店铺或历史业务数据推断。
2. 可以缓存 Ozon 成功返回的真实数据，最长有效期为 6 小时。
3. 缓存过期后必须重新请求 Ozon；请求失败时不得继续使用过期缓存。
4. 类目树、类目属性或字典值获取失败时必须明确报错，不能返回伪装成功的空列表。
5. 失败时必须停止 AI 自动选类目、商品预检和正式上架。
6. 后端是最终门禁；前端隐藏或禁用按钮只能改善体验，不能代替后端校验。

## 证据和适用边界

### 已检查

- `server/index.mjs` 中现有类目缓存、Ozon 查询函数和三个 HTTP 路由。
- `server/ozon-import-normalizer.mjs` 中商品预检、属性过滤和字典值解析消费者。
- `app/src/App.jsx` 中商品编辑页的类目树、属性和字典值加载流程。
- 扩展 `getCategoryTree`、`getCategoryAttributes` 和 1688 AI 向导消费流程。
- 账号/店铺隔离、模块边界和上架外部写保护测试。
- 用户在 2026-07-28 明确确认“只接受 Ozon 真实类目”和 6 小时真实数据缓存方案。

### 未执行

- 不使用真实店铺凭据调用 Ozon。
- 不执行真实商品预检、上架、库存或价格写入。
- 不在本轮升级或猜测 Ozon API 版本；沿用项目当前
  `/v1/description-category/*` contract。真实环境启用前应另行对照当时的
  Ozon 官方文档验证版本和权限。

## 非目标

本轮不处理：

- 商品、订单、店铺资料、仓库和促销同步。
- 采集流程本身以及采集数据模型。
- 上架任务状态机、重试、对账和外部写入实现。
- AI 模型、提示词或自动分类算法。
- 数据库、迁移、依赖、环境变量和部署配置。
- 持久化类目快照或跨进程共享缓存。

## 当前问题

现有类目逻辑混在 `server/index.mjs` 中，并存在以下风险：

1. 类目树请求失败后，会从当前店铺已同步商品中拼出一个不完整的平面列表。
2. 类目属性请求失败后，会用 HTTP 200 返回空列表，调用方可能误认为该类目没有属性。
3. 字典值请求失败后，会用 HTTP 200 返回空列表和错误文字，调用方可能忽略错误。
4. 缺少 `description_category_id` 时，会从本地商品的 `type_id` 推断类目 ID。
5. 类目查询同时服务商品编辑、插件向导、预检和上架，但没有稳定的独立 contract。

## 模块边界

### `server/ozon-category-service.mjs`

单一职责：获取、校验和短期缓存真实 Ozon 类目数据。

建议工厂 contract：

```js
createOzonCategoryService({
  callOzonSellerApi,
  now,
  cacheTtlMs,
})
```

公开方法：

```js
getCategoryTree({ accountId, store, language })
getCategoryAttributes({ accountId, store, descriptionCategoryId, typeId, language })
getCategoryAttributeValues({
  accountId,
  store,
  descriptionCategoryId,
  typeId,
  attributeId,
  language,
  limit,
})
resolveDescriptionCategoryId({ accountId, store, typeId, language })
```

服务负责：

- 调用唯一的 `ozon-client.mjs`。
- 校验账号和店铺缓存作用域参数。
- 校验数字 ID、语言和分页上限。
- 校验类目树和属性响应存在预期 `result` 数组；字典值兼容项目当前已支持的
  `result` 数组或 `result.values` 数组形态。
- 字典值分页、去重、终止条件和重复游标保护。
- 返回真实数据及来源元信息。
- 把底层异常转换为稳定、脱敏的类目错误。

服务不负责：

- 读取业务 `state.caches.products`。
- 选择当前账号或当前店铺。
- 发送 HTTP 响应。
- 创建预检或上架任务。

### `server/ozon-category-routes.mjs`

单一职责：处理三个现有 HTTP 查询 contract。

建议 handler contract：

```js
createOzonCategoryRouteHandler({
  categoryService,
  requireAuth,
  storeIdForAccountRequest,
  activeStore,
  sendJson,
  sendError,
})
```

入口只调用：

```js
const handled = await handleOzonCategoryRoute({ req, res, url, state });
if (handled) return;
```

路由负责：

- 后端认证。
- 根据当前账号选择明确店铺。
- 拒绝不存在、未启用或不属于当前账号的店铺。
- 解析 URL 和查询参数。
- 输出现有 `data`、`items`、`total` 字段以及新增的来源元信息。
- 将类目服务错误转换为非 2xx、安全、稳定的错误响应。

路由不读取本地商品缓存，也不实现类目查找算法。

### 直接消费者

商品预检和最终上架校验直接依赖 `ozon-category-service.mjs` 的稳定方法，
不通过 HTTP 回调自身接口：

```js
getCategoryTree
getCategoryAttributes
getCategoryAttributeValues
```

任一必要查询失败时，错误必须向上传播；不能创建预检成功结果或上架任务。

## 缓存 contract

### 可写入条件

只有以下条件全部满足才能写入缓存：

- Ozon HTTP 调用成功。
- 响应可以解析。
- 类目树和属性的 `result` 具有数组结构；字典值为 `result` 数组或
  `result.values` 数组。
- 类目树结果非空。
- 字典值分页未出现重复非空游标或异常终止。

失败响应、结构错误、局部分页结果和本地商品数据都不能进入缓存。

### 隔离键

缓存键必须至少包含：

```text
accountId
store.id
language
resource type
descriptionCategoryId
typeId
attributeId
limit
```

不允许只使用 `clientId`，也不允许在不同账号或店铺间共享缓存。

### 有效期

- 默认 TTL：6 小时。
- TTL 可作为工厂测试参数注入，不新增运行时环境变量。
- 过期项按未命中处理。
- 重新获取失败时删除或忽略过期项，不允许 stale-on-error。
- 服务重启后内存缓存自然清空。

### 来源元信息

成功的 HTTP 响应增加兼容性字段：

```json
{
  "meta": {
    "source": "OZON_API",
    "fetchedAt": "ISO-8601",
    "expiresAt": "ISO-8601"
  }
}
```

命中缓存时 `source` 为 `OZON_CACHE`，但 `fetchedAt` 保留原始 Ozon 获取时间。
现有 `data`、`items` 和 `total` 字段保持不变。

## 数据获取和失败流程

### 类目树

1. 后端校验账号和店铺归属。
2. 查询当前作用域内未过期的真实 Ozon 缓存。
3. 未命中时调用 Ozon。
4. 校验非空树形结果后原子写入缓存。
5. 返回真实数据和来源元信息。
6. 任一步失败时返回非 2xx；不读取 `state.caches.products`。

### 类目属性

1. 必须具有有效的 `typeId`。
2. 请求已提供 `descriptionCategoryId` 时直接使用。
3. 未提供时，只允许从本次或有效缓存中的真实 Ozon 类目树按 `typeId` 解析。
4. 不允许从本地商品推断 ID。
5. Ozon 查询失败或类型不存在时返回非 2xx。

### 字典值

1. 必须具有有效的类目、类型和属性 ID。
2. 按 Ozon 游标分页请求，限制总量。
3. 每页成功后先暂存在本次调用内。
4. 全部分页完成并校验后，才整体写入缓存。
5. 中途失败、重复非空游标或结构错误时丢弃本次结果并返回非 2xx。

## 错误 contract

统一使用当前 `sendError` 基本结构：

```json
{
  "ok": false,
  "message": "未能从 Ozon 获取真实类目数据，请重试",
  "code": "OZON_CATEGORY_TREE_UNAVAILABLE"
}
```

稳定错误 code：

- `OZON_CATEGORY_TREE_UNAVAILABLE`
- `OZON_CATEGORY_ATTRIBUTES_UNAVAILABLE`
- `OZON_CATEGORY_VALUES_UNAVAILABLE`
- `OZON_CATEGORY_DATA_INVALID`
- `OZON_CATEGORY_TYPE_NOT_FOUND`

状态码约定：

- Ozon 超时：504。
- Ozon 限流或暂时不可用：503。
- Ozon 响应错误或结构错误：502。
- 输入 ID 不合法：400。
- 真实类目树中不存在指定类型：422。
- 店铺归属或权限错误：沿用现有后端认证/店铺错误 contract。

错误中不得包含：

- Client ID、API Key 或请求头。
- Ozon 原始响应体。
- 商品、账号或店铺敏感信息。
- 原始 `cause` 链中的敏感文字。

## 页面和插件行为

### 商品编辑页

- 类目加载和就绪判断放在可直接执行测试的小模块中，页面消费该行为 contract，
  不使用只搜索源码文字的伪行为测试。
- 类目树加载失败时显示明确错误，不再静默变成空树。
- 类目属性或字典值失败时显示对应错误，不显示“无属性”的假状态。
- 当前类目真实数据未就绪时，禁止 AI 自动类目、预检和正式上架。
- 用户可以点击重试；成功取得真实 Ozon 数据后恢复操作。

### 1688 AI 向导

- 类目失败状态转换放在扩展可直接执行测试的小模块中，由向导实际调用。
- 类目树失败时保留错误状态，不执行自动匹配。
- 类目属性失败时不生成伪造的空属性表单。
- 不使用历史商品类目进行本地 fuzzy match。
- 店铺切换后必须使用新店铺隔离的查询和缓存。

### 后端最终门禁

即使前端状态被绕过，预检和正式上架仍必须重新通过服务端类目 contract。
必要类目、属性或字典值查询失败时：

- 预检返回失败。
- 不创建上架快照或上架任务。
- 不调用真实 Ozon 商品、库存或价格写接口。

`COLLECT_EDIT_AUTO_CATEGORY` 不再允许用“未解析的必填字典值”通过预检。

## API 兼容性

保留三个路径和成功响应主体：

```text
GET /ozon/categories/tree
GET /ozon/description-category/:typeId/attributes
GET /ozon/description-category/:typeId/attributes/:attributeId/values
```

成功时继续返回 `data`、`items`、`total` 以及原有 ID 字段。
新增 `meta` 为兼容性字段，现有消费者可以忽略。

有意改变的行为：

- Ozon 失败时由 `200 + 推断/空数据` 改为非 2xx 明确错误。
- 删除成功响应中的 `inferred: true` 分支。
- 删除本地商品类目与 `type_id` 推断。

## 测试设计

### 类目服务单元测试

- Ozon 类目树、属性和字典值成功返回。
- 同一作用域 6 小时内命中缓存且不重复调用 Ozon。
- TTL 到期后重新调用 Ozon。
- 过期后 Ozon 失败，不使用旧缓存。
- 失败或畸形响应不写缓存。
- 树、属性和值缓存按账号、店铺、语言和 ID 隔离。
- 字典值多页合并、去重、上限和终止正确。
- 重复非空游标立即失败，且不提交半批结果。
- 错误消息、body 和 cause 不泄露凭据或原始响应。

### 路由和权限测试

- 未登录请求被拒绝。
- 跨账号、跨店铺请求被拒绝。
- 类目树 Ozon 失败时，不读取本地商品缓存。
- 属性和值查询缺少类目 ID 时，只从真实 Ozon 树解析。
- Ozon 失败返回稳定非 2xx 和错误 code。
- 成功响应保留旧字段并增加正确来源元信息。

### 消费者回归

- 商品编辑页显示错误和重试状态。
- AI 向导不使用失败或空数据自动选类目。
- 商品预检在必要类目数据失败时不通过。
- 最终上架不创建任务、不触发外部写。
- 现有导入货币、预检、上架失败保护和账号/店铺隔离测试通过。

### 工程门禁

- `server/index.mjs` 不再定义类目查询、缓存或本地推断函数。
- 下调入口行数门禁，不允许类目逻辑回流。
- Ozon Seller API 网络请求仍只存在于 `ozon-client.mjs`。
- 定向测试、前端构建、扩展测试和 `scripts/verify.mjs` 全部通过。
- `git diff --check` 和凭据扫描通过。

## 影响范围

### 预计新增

- `server/ozon-category-service.mjs`
- `server/ozon-category-routes.mjs`
- `server/tests/ozon-category-service.test.mjs`
- `server/tests/ozon-category-routes.test.mjs`
- `app/src/category-readiness.js`
- `app/tests/category-readiness.test.mjs`
- `extension/lib/category-readiness.js`
- `extension/tests/category-readiness.test.js`

### 预计修改

- `server/index.mjs`
- `server/ozon-import-normalizer.mjs` 或其调用参数
- `server/tests/module-boundaries.test.mjs`
- 商品编辑页及其 contract 测试
- 1688 AI 向导相关 contract 测试（仅在现有失败行为不足时修改实现）
- 扩展 manifest、源码差异门禁和打包产物（用于加载新增扩展 helper）
- `scripts/verify.mjs` 或测试清单（仅注册新增测试）
- `docs/architecture/module-boundaries.md`

### 不影响

- 数据库表和迁移。
- 运行时依赖和锁文件。
- 环境变量与部署配置。
- 已完成的 Ozon 同步服务 contract。

## 风险和控制

风险等级：R2，共享且有意改变失败 contract。

主要风险：

- 旧调用方把非 2xx 当作未处理异常。
- 商品编辑或插件在 Ozon 短暂不可用时无法继续。
- 严格门禁会暴露以前被空列表掩盖的凭据、权限或 API 版本问题。

控制方式：

- 保留成功响应字段，只改变失败语义。
- 前端和插件增加明确错误及重试。
- 后端最终门禁阻止绕过。
- 使用 mock Ozon 响应测试，不接触真实凭据。
- 完整回归商品编辑、预检、上架保护和账号/店铺隔离。

## 验收标准

1. 代码中不存在从本地商品缓存生成类目树或推断类目 ID 的路径。
2. 只有 Ozon 成功、结构合法的数据能写入类目缓存。
3. 缓存最长 6 小时，隔离键包含账号、店铺、语言和资源 ID。
4. 过期缓存不会在 Ozon 失败时继续使用。
5. 三个类目接口失败时返回明确非 2xx，而不是成功空列表。
6. 商品编辑和 AI 向导在真实类目不可用时停止并显示可重试错误。
7. 预检和正式上架在必要类目数据不可用时失败，且无外部写副作用。
8. 类目服务、路由、消费者和模块边界测试通过。
9. 完整工程门禁通过，未引入新的失败。
10. 未调用真实 Ozon、未修改数据库、配置、依赖或部署。

## 回滚

若出现问题，只反向恢复：

- 两个新类目模块。
- `server/index.mjs` 的导入、路由委托和预检 service wiring。
- 页面/插件失败提示改动。
- 新增测试与模块边界门禁。

不得使用 `git reset --hard`，不得覆盖工作区中其他已有改动。
本轮无数据库迁移、持久化缓存或真实外部副作用，因此不需要数据回滚。
