# Browser Agent 任务隔离设计

> **历史文档：** 本设计保留当时的业务背景、授权和方案时态；当前实现与验证结果以已提交代码、可复现测试和最终保护性基线报告为准。

**日期：** 2026-07-27
**状态：** 待书面确认
**目标目录：** `<repo>`
**风险等级：** R3（账号/店铺权限边界）
**用户批准范围：** 修复 Browser Agent 跨账号领取、读取和改写任务；不执行真实 Ozon 操作。

## 背景

当前 Browser Agent 接口只确认“请求已经登录”，随后直接访问全局
`state.browserAgents` 和 `state.jobs`。因此，一个账号的插件可能领取、查看或更新
另一个账号的任务；结果接口还会在任务不存在时凭空创建任务。

用户已明确授权清除本机旧店铺和关联业务数据。清理后 PostgreSQL 和
`server-data/local-state.json` 中的店铺、商品、订单、仓库、历史任务、报告和租约均为
0，所以本修复不需要迁移、猜测或兼容旧任务归属。

## 用户可见结果

- 每个新任务明确属于一个账号和一个经营店铺。
- 一个账号只能创建、领取、查看和更新自己的任务。
- 同一账号的两台电脑不会同时执行同一个任务。
- 执行设备断线后，安全的只读采集任务可以在超时后重新领取。
- 可能产生 Ozon 写入副作用的任务在执行设备失联后不会自动重试，而是进入待核对状态。
- 不存在的任务、其他账号的任务和非法状态跳转会被后端拒绝。

## 非目标

- 不新增或执行数据库迁移。
- 不绑定店铺，不调用真实 Ozon，不执行真实同步、上架、库存或价格修改。
- 不在本修复包内改造全部同步租约、全局业务缓存或旧上架管线；它们按审计顺序进入后续修复包。
- 不在本修复包内拆分整个 `server/index.mjs`。

## 方案选择

### 方案 A：在每个路由中分别补判断

改动最少，但账号、店铺、设备和状态规则会重复，后续新增路由容易再次漏检。

### 方案 B：统一任务访问策略（采用）

提取一组小而可测试的任务策略函数，所有 Browser Agent 创建、领取、查询和结果接口都通过
这些函数。路由仍保留在现有入口中，避免本修复同时进行大范围结构重构。

### 方案 C：立即迁移到独立任务表

长期边界更清晰，但需要数据库迁移、旧数据处理和多个消费者切换，超过本修复包范围。

## 数据契约

### Browser Agent

注册或心跳后的服务端记录至少包含：

```js
{
  id: "device-id",
  accountId: "account-id",
  status: "online",
  capabilities: [],
  registeredAt: "ISO-8601",
  lastHeartbeatAt: "ISO-8601"
}
```

`accountId` 只能取自后端认证会话，不能信任请求体。已属于其他账号的 `deviceId` 重新注册或
心跳时返回 404，不允许转移设备归属。

### Browser Agent Job

新任务至少包含：

```js
{
  id: "job-id",
  accountId: "account-id",
  storeId: "store-id",
  createdBy: "account-id",
  type: "ozon.collect_variant",
  status: "PENDING",
  claimedByDeviceId: "",
  claimExpiresAt: "",
  claimAttempt: 0,
  createdAt: "ISO-8601",
  updatedAt: "ISO-8601"
}
```

- `accountId` 和 `createdBy` 由认证会话写入。
- `storeId` 必须通过 `storeIdForAccountRequest` 验证属于当前账号。
- 请求体中的同名字段不能覆盖服务端确定的账号、店铺、认领设备和状态字段。

## 统一访问规则

新增纯策略模块 `server/browser-agent-policy.mjs`，负责：

- 判断设备是否属于当前账号。
- 判断任务是否属于当前账号和账号名下店铺。
- 从当前账号可访问的任务中选择下一个可领取任务。
- 校验认领设备和临时锁是否仍有效。
- 校验任务状态能否发生指定变化。
- 在测试中通过显式 `now` 参数控制超时，不依赖真实等待。

跨账号、错误设备和无权访问的任务统一返回 404，避免暴露对象是否存在。请求合法但状态不允许
变化时返回 409。

## 临时锁

任务被领取时：

```js
status = "PROCESSING"
claimedByDeviceId = 当前设备
claimExpiresAt = 当前时间 + 5 分钟
claimAttempt += 1
```

执行设备上报 `progress` 时，任务进入 `RUNNING` 并把锁续期 5 分钟。只有
`claimedByDeviceId` 对应的设备才能续期、成功或失败该任务。

领取下一任务前，服务端处理已过期锁：

- `collect.hot_products`、`collect.product_detail`、`ozon.collect_variant`、
  `ozon.market_data` 和 `listing.create_draft` 属于可安全重试任务，清除旧设备锁并回到
  `PENDING`。
- `listing.publish_draft` 可能已经对 Ozon 产生写入，过期后进入 `RECONCILING`，不自动重新
  派发，防止重复上架。

## 状态流转

允许的主要流转：

```text
PENDING -> PROCESSING
PROCESSING -> RUNNING
PROCESSING -> FAILED
RUNNING -> RUNNING
RUNNING -> SUCCESS
RUNNING -> FAILED
PROCESSING/RUNNING -> PENDING       仅安全任务且锁已过期
PROCESSING/RUNNING -> RECONCILING   外部写任务且锁已过期
```

`SUCCESS`、`FAILED` 和 `RECONCILING` 不允许被普通结果接口重新打开或覆盖。

## 路由行为

### 注册与心跳

- `POST /browser-agents/register`
- `POST /browser-agents/heartbeat`

后端写入并验证 `accountId`。心跳不能接管其他账号的设备。

### 创建和查询

- `POST /browser-agents/collection-jobs`
- `POST /browser-agents/market-data-jobs`
- 对应的 `GET /:jobId`
- `GET /ozon/sync/jobs/:jobId`

创建时验证店铺所有权并写入服务端归属字段；查询时验证任务所有权。任务不存在时返回 404，
不再返回伪造的 `PENDING` 对象。

### 领取和结果

- `GET /browser-agents/jobs/next?deviceId=...`
- `POST /browser-agents/jobs/:jobId/progress`
- `POST /browser-agents/jobs/:jobId/result`
- `POST /browser-agents/jobs/:jobId/fail`

领取前验证设备账号，且只搜索当前账号任务。结果接口要求任务真实存在、归属正确、设备锁匹配
且状态流转合法；请求体不能覆盖归属和锁字段。

## 错误处理

- 未登录：401。
- 店铺不属于当前账号：403，沿用现有 `STORE_ACCOUNT_FORBIDDEN`。
- 设备、任务不存在或不属于当前账号：404。
- 任务锁属于另一设备或状态流转非法：409。
- 参数缺少 `deviceId`、`storeId` 或任务类型不受支持：400。
- 保存状态发生版本冲突：沿用现有 409，不吞掉错误。

## 测试设计

新增 `server/tests/browser-agent-isolation.test.mjs`，使用临时 JSON 数据目录和真实 `handle`
路由，不连接 PostgreSQL，不调用 Ozon。测试建立账号 A/B、店铺 A/B、设备 A/B，覆盖：

1. A 创建的任务包含服务端写入的 `accountId`、`storeId` 和 `createdBy`。
2. B 不能查询、领取或更新 A 的任务。
3. A 的设备 A1 领取后，设备 A2 不能更新或重复领取同一任务。
4. 设备 A1 可以按合法顺序上报进度并完成任务。
5. 不存在的任务返回 404，且不会被结果接口创建。
6. 非法状态跳转返回 409，终态不会被覆盖。
7. 安全采集任务锁过期后可以重新领取。
8. `listing.publish_draft` 锁过期后进入 `RECONCILING`，不会重新领取。
9. 同一 `deviceId` 不能被另一账号注册或心跳接管。
10. 请求体不能伪造 `accountId`、`storeId`、状态或认领设备。

扩展端保留现有 `deviceId` 上报协议，并补充客户端契约测试，确保 progress/result/fail
请求始终携带当前执行设备 ID。

## 预计改动边界

- 新建：`server/browser-agent-policy.mjs`
- 新建：`server/tests/browser-agent-isolation.test.mjs`
- 修改：`server/index.mjs`
- 修改：`extension/background/sync/backend-client.js`（仅在现有调用缺少设备字段时）
- 修改：`extension/background/agent/agent-runtime.js`（仅补齐结果请求的 `deviceId`）
- 修改：`scripts/verify.mjs`，把权限负向测试加入统一门禁

不修改数据库迁移、Docker、Ozon 客户端、算价模块、前端页面和依赖锁文件。

## 验证与回滚

验证顺序：

1. 新策略模块单元测试和 Browser Agent HTTP 隔离测试。
2. 账号/店铺现有隔离与多会话回归测试。
3. 扩展 Browser Agent smoke。
4. 服务端语法检查、应用构建和完整 `pnpm verify`。
5. 按用户提供的 `AGENTS.md` 重新检查权限、状态、幂等、追溯和交付门禁。

回滚仅恢复上述代码和测试文件。没有数据库迁移、依赖变化或真实外部调用。用户已明确放弃本机
旧业务数据备份；这些已删除数据只能通过后续重新绑定店铺和重新同步恢复。
