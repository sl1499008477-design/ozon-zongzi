# Ozon 同步服务拆分设计

> **历史文档：** 本设计保留当时的业务背景、授权和方案时态；当前实现与验证结果以已提交代码、可复现测试和最终保护性基线报告为准。

日期：2026-07-28
状态：已实施并通过完整验证
目标项目：`<repo>`

## 目标

把 Ozon HTTP 访问以及店铺资料、商品、订单、仓库、促销同步从
`server/index.mjs` 中拆出，形成可独立理解、测试和替换的业务边界。

本轮以结构迁移为主，不改变 API、数据结构、权限规则、数据库、页面或插件 contract。
唯一明确的行为修正是同步原子性：包括 FBO 在内的任一必需分页读取失败时，整次同步失败，
不再把其他已拉取的半批数据当作成功结果提交。

## 非目标

本轮不拆：

- 类目树、类目属性和字典值查询。
- 商品采集、采集店铺、商品草稿和草稿版本。
- 商品上架、库存写入、上架任务状态机和结果对账。
- 前端页面。
- 数据库结构、依赖、环境配置和部署配置。

后续按“类目查询 → 采集流程 → 上架编排”的顺序分别处理。

## 模块边界

### `server/ozon-client.mjs`

职责：

- Ozon Seller API 的 GET、POST 请求。
- Client-Id、Api-Key 请求头。
- AbortController 超时。
- 网络错误、读取响应错误和 HTTP 错误标准化。
- JSON 与非 JSON 响应解析。

不负责：

- 账号和店铺归属。
- 同步类型、分页策略和缓存更新。
- 数据库或本地状态。
- 重试任务、审计或 HTTP 路由响应。

保留现有 `callOzonSellerApi(store, apiPath, body, timeoutMs)` 接口，并新增对称的
`getOzonSellerApi(store, apiPath, timeoutMs)` 接口。现有上架工作进程继续使用同一个客户端，
不能再在入口中复制 HTTP 实现。

### `server/ozon-sync-service.mjs`

职责：

- 店铺资料同步。
- 商品、订单、仓库和促销同步。
- Ozon 分页读取。
- Ozon 响应向现有本地缓存 contract 的转换。
- 同步任务的 RUNNING、SUCCESS、FAILED 状态闭环。
- 本地状态版本冲突的有限重试。
- 同步期间店铺被删除或转移时停止提交。

公开接口：

```js
createOzonSyncService({
  loadState,
  saveState,
  now,
  createJobId,
  logger,
})
```

返回：

```js
{
  syncStoreProfile(state, store),
  refreshStoreProfiles(state, { accountId, storeId }),
  runLocalSync(state, {
    accountId,
    storeId,
    type,
    jobId,
    deviceId,
    source,
    postingsSinceDays,
  }),
}
```

`loadState` 和 `saveState` 是状态 Port。服务不知道数据来自 JSON 还是 PostgreSQL；测试可以提供
内存实现。`now` 和 `createJobId` 允许测试稳定验证时间与任务 ID。未传入时使用系统时间和
`crypto.randomUUID()`。

### `server/index.mjs`

入口只负责：

1. 认证账号。
2. 从请求读取同步参数。
3. 调用账号/店铺归属校验。
4. 调用 `OzonSyncService`。
5. 将稳定的同步报告返回给页面或插件。

入口不得再定义：

- `ozonCall`
- `ozonGet`
- `syncStoreProfile`
- `refreshStoreProfiles`
- `syncProducts`
- `syncPostings`
- `syncWarehouses`
- `syncPromotions`
- `runLocalSync`

## 数据流

```text
HTTP 请求
→ 后端认证
→ 账号与店铺归属校验
→ 创建 RUNNING 报告并保存
→ OzonSyncService 分页读取只读接口
→ 在工作状态副本中标准化和组装缓存
→ 重新读取最新状态并再次验证店铺归属
→ 提交完整缓存快照和 SUCCESS 报告
→ 返回现有 API contract
```

同步服务只能替换目标账号、目标店铺、目标同步类型对应的数据。其他账号、其他店铺及其他缓存
必须保持不变。

## 失败处理

- 缺少 Ozon 凭据：400，错误码 `OZON_CREDENTIALS_MISSING`。
- 网络错误：502，错误码 `OZON_NETWORK_ERROR` 或底层网络错误码。
- 超时：504，错误码 `OZON_TIMEOUT`。
- HTTP 非成功响应：保留 Ozon 状态码和脱敏后的响应摘要。
- 响应读取失败：作为 Ozon 网络阶段失败处理。
- 分页中途失败：整次同步失败，不提交半批缓存。
- 不支持的同步类型：拒绝执行并保存 FAILED 报告。
- 本地状态版本冲突：使用现有有限次数重试；耗尽后失败。
- 同步期间店铺删除或归属变化：409，不提交同步结果。
- FAILED 报告保存失败：记录脱敏警告，不覆盖原始业务错误。

旧缓存只有在完整同步成功并通过最终店铺归属校验后才会被替换。

## 权限与副作用

- 账号认证和店铺归属继续由后端执行。
- 管理员在普通同步接口中也只能操作自己名下店铺。
- Ozon 调用均为资料、商品、订单、仓库和促销读取。
- 本轮不执行商品创建、库存更新、价格更新、上下架等 Ozon 写操作。
- 测试只使用模拟 Ozon 响应，不连接真实店铺。

## API 与数据 contract

保持以下现有行为：

- `/local/stores/refresh-profile`
- `/local/sync/:type`
- 页面和插件使用的同步任务 ID、状态、数量、错误字段。
- 商品、订单、仓库、促销缓存字段。
- `local_state` 与正式表持久化方式。
- 同步租约和账号/设备边界。

本轮不新增或修改数据库迁移。

## 测试设计

### 客户端测试

- POST 请求头、请求体和成功响应解析。
- GET 请求头和成功响应解析。
- 缺少凭据。
- 超时。
- 网络失败。
- 非 JSON 错误响应。
- HTTP 非成功响应。

### 同步服务测试

- 店铺资料字段映射。
- 商品多页读取与目标店铺缓存替换。
- 商品详情、价格和仓库库存合并。
- FBS 与 FBO 订单分页读取。
- 仓库和促销同步。
- 分页中途失败不覆盖旧缓存。
- 另一个账号和店铺的数据保持不变。
- 店铺在同步期间删除或转移时返回 409。
- RUNNING → SUCCESS 和 RUNNING → FAILED 状态闭环。
- 状态版本冲突的有限重试。

### 边界门禁

`server/tests/module-boundaries.test.mjs` 增加：

- 入口不得重新定义上述客户端与同步函数。
- `server/index.mjs` 行数上限从当前门禁下调至少 800 行。

### 完整回归

运行 `scripts/verify.mjs`，要求现有构建、扩展包一致性、数据库集成和全部自动测试通过。

## 验收标准

- `server/index.mjs` 至少减少约 800 行。
- Ozon HTTP 逻辑只有一个实现。
- 店铺资料、商品、订单、仓库和促销同步全部位于独立服务。
- 原有 API 路径、请求字段、响应结构和缓存 contract 不变。
- 跨账号、跨店铺负向测试通过。
- 任何分页失败都不提交半批缓存。
- 不修改数据库、依赖和环境配置。
- 不执行真实 Ozon 写操作。
- 完整门禁通过。

## 风险与回滚

主要风险是迁移时遗漏入口中的隐式依赖，或让缓存替换时机发生变化。控制方式是先写边界和行为
测试，再移动实现，每次只迁移一个同步类型。

本轮不创建 Git 提交。若需要回滚，只反向恢复本设计涉及的客户端、同步服务、入口导入和测试
文件；不得对当前包含用户修改的脏工作区执行 `git reset --hard`。
