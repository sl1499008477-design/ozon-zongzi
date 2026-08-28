# 自动上架独立 AI 通道池实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让自动上架按健康独立 Sub2API 通道数并行处理商品；同一商品内部严格串行，通道故障自动切换，无空闲通道无限期安全等待，Ozon 上传仍按批次顺序执行。

**Architecture:** 保留唯一主模型配置和现有 PostgreSQL Outbox。新增账号/主配置版本范围内的通道成员表；AI Outbox 领取事务同时完成商品固定通道分配、当前执行租约和派发代次。新 `auto-listing-ai-v3` 队列携带不含密钥的执行信封，Worker 接管并心跳 Outbox 与通道租约，业务结果与租约释放在同一事务完成。旧 `auto-listing-ai-v2` 队列继续排空部署前消息，并承载无法写入通道表的环境变量式旧配置；连接版本式配置不得绕过 v3 通道池。单次模型调用使用“无有效响应 5 分钟”看门狗，不设置任务或排队总时限。

**Tech Stack:** Node.js ESM、PostgreSQL/`pg`、`pg-boss`、React 19、Ant Design 6、Vite、Node test runner。

**Spec:** [2026-08-28-auto-listing-ai-channel-pool-design.md](../specs/2026-08-28-auto-listing-ai-channel-pool-design.md)

## 全局约束

- 当前工作区包含用户尚未提交的其他改动。每个任务只暂存本任务列出的文件；不得使用 `git add .`、`git reset --hard` 或覆盖无关改动。
- 使用下一迁移号 `098`；不得改写已经存在的迁移，也不得修改未跟踪的 `097_category_strategy_auditable_archive.sql`。
- 完整 Key、Authorization、解密连接、上游原始响应和不安全错误文本不得进入数据库审计、日志、队列信封或前端 DTO。
- 通道引用确切的主配置版本和确切的连接版本；模型、协议、提示 contract 继续来自任务冻结的唯一主配置。
- `category-strategy` 及其他 AI 工具继续走主配置原连接，不申请自动上架通道租约。
- “等待可用通道”不得增加 Outbox 尝试次数，不得变成失败，也不得设置总等待时间。
- 只有单次外部模型调用使用默认 5 分钟无有效响应看门狗；数据库事务、发布请求和管理员连接测试仍保留各自的短超时。
- 任何真实 Sub2API 调用会产生费用；自动测试使用假网关。真实双通道和真实 Ozon 写入必须在用户另行确认范围后执行。
- 每完成一个任务，先运行该任务列出的测试，再只提交该任务文件。若执行时目标文件已经包含其他未提交改动，先用 `git diff -- <file>` 区分所有权，并用 `git add -p <file>` 只暂存本任务 hunk；本计划中的整文件 `git add` 命令仅适用于该文件在任务开始前干净的情况。

---

## 任务 1：增加通道、亲和、派发与调用来源数据库 contract

**文件：**

- 新建：`server/db/migrations/098_auto_listing_ai_channel_pool.sql`
- 新建：`server/tests/auto-listing-ai-channel-pool-migration.test.mjs`
- 新建：`server/tests/auto-listing-ai-channel-pool-migration-postgres.integration.test.mjs`
- 修改：`server/tests/auto-listing-ai-runtime-postgres-fixture.mjs`

- [ ] **步骤 1：先写静态迁移测试**

在 `auto-listing-ai-channel-pool-migration.test.mjs` 中读取迁移文本并断言：

```js
test("098 creates account-scoped profile channels and exact-version evidence", async () => {
  const sql = await readFile(migrationPath, "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS auto_listing_ai_profile_channels/);
  assert.match(sql, /FOREIGN KEY \(account_id, profile_id, profile_version\)/);
  assert.match(sql, /FOREIGN KEY \(account_id, connection_id, connection_version\)/);
  assert.match(sql, /dispatch_generation INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /uncertain_result_count INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /gateway_connection_id/);
  assert.match(sql, /checker_connection_id/);
});
```

运行：

```bash
node --test server/tests/auto-listing-ai-channel-pool-migration.test.mjs
```

预期：失败，提示迁移文件不存在。

- [ ] **步骤 2：写 PostgreSQL 约束集成测试**

覆盖以下事实：

1. 当前连接型启用主配置被确定性回填为 `channel_order=1`；
2. 同一通道不能同时分配两个商品；同一 `account_id + job_id + item_id + assigned_status_version` 不能占用两个通道；
3. 通道、主配置、连接、商品跨账号或版本不一致时插入失败；
4. 分配字段和执行租约字段必须全空或全有；
5. `dispatch_generation >= 0`，`uncertain_result_count BETWEEN 0 AND 2`；
6. 历史 Outbox `COMPLETED + publication_id=dedupe_key` 仍合法；新派发 contract 允许 `PROCESSING` 持有 `publication_id`；
7. 主通道可引用 `ACTIVE` 连接，附加通道只能引用 `VALIDATED` 连接；
8. 删除被任务版本引用的通道/连接仍被外键阻止。

运行：

```bash
node --test server/tests/auto-listing-ai-channel-pool-migration-postgres.integration.test.mjs
```

预期：失败，提示表或列不存在。

- [ ] **步骤 3：实现迁移**

表结构使用以下单一权威 contract：

```sql
CREATE TABLE IF NOT EXISTS auto_listing_ai_profile_channels (
  account_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL CHECK (profile_version > 0),
  channel_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  connection_version INTEGER NOT NULL CHECK (connection_version > 0),
  channel_order INTEGER NOT NULL CHECK (channel_order > 0),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  cooldown_until TIMESTAMPTZ,
  requires_revalidation BOOLEAN NOT NULL DEFAULT FALSE,
  last_error_code TEXT,
  consecutive_failure_count INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failure_count >= 0),
  assigned_job_id TEXT,
  assigned_item_id TEXT,
  assigned_status_version INTEGER,
  assigned_at TIMESTAMPTZ,
  execution_lease_owner TEXT,
  execution_lease_token TEXT,
  execution_lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, profile_id, profile_version, channel_id),
  UNIQUE (account_id, profile_id, profile_version, channel_order),
  UNIQUE (account_id, profile_id, profile_version, connection_id, connection_version),
  FOREIGN KEY (account_id, profile_id, profile_version)
    REFERENCES ai_gateway_profiles(account_id, id, config_version) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, connection_id, connection_version)
    REFERENCES ai_gateway_connection_versions(account_id, connection_id, version) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, assigned_job_id, assigned_item_id)
    REFERENCES auto_listing_job_items(account_id, job_id, id) ON DELETE RESTRICT
);
```

再增加：

- 部分唯一索引：已分配商品在同一账号只能出现一次；
- 分配四字段、执行租约三字段的 all-or-null `CHECK`；执行租约存在时必须已有商品分配；
- `cooldown_until` 必须有限；安全错误码格式与现有约束一致；
- `auto_listing_job_items.last_ai_connection_id`、`last_ai_connection_version`、`last_ai_channel_assigned_at` 及账号范围复合外键；
- `auto_listing_ai_outbox.dispatch_contract_version`、`dispatch_generation`、`uncertain_result_count`、`dispatch_queued_at`；
- `auto_listing_content_plan_attempts.gateway_connection_id/version`；
- `ai_generation_assets.gateway_connection_id/version` 和 `checker_connection_id/version`；
- `ai_rich_content_results.gateway_connection_id/version`；
- 每组连接字段均 all-or-null，并引用确切连接版本。

新派发 Outbox 生命周期：

```text
PENDING: publication_id/published_at/dispatch_queued_at 为空
PROCESSING + dispatch_contract_version='CHANNEL_WORK_V1':
  publication_id = dedupe_key || ':' || dispatch_generation
  dispatch_queued_at 非空；published_at 在发布成功后写入
COMPLETED: 新 contract 保留最后 publication_id/published_at；历史 contract 仍要求 publication_id=dedupe_key
```

修改终态保护函数时只允许 `PENDING/PROCESSING` 的派发与租约字段变化；`COMPLETED/DEAD` 继续不可更新、不可删除。

回填使用 `INSERT ... SELECT ... ON CONFLICT DO NOTHING`，仅为“当前启用、连接型、连接版本仍为 `ACTIVE`”的主配置加入通道 1；环境变量式旧配置不伪造通道。

- [ ] **步骤 4：运行迁移测试**

```bash
node --test \
  server/tests/auto-listing-ai-channel-pool-migration.test.mjs \
  server/tests/auto-listing-ai-channel-pool-migration-postgres.integration.test.mjs \
  server/tests/auto-listing-ai-runtime-migration.test.mjs \
  server/tests/auto-listing-ai-admin-migration.test.mjs
```

预期：全部通过；无 PostgreSQL 环境时集成测试必须明确 skip，而不是假通过。

- [ ] **步骤 5：提交**

```bash
git add server/db/migrations/098_auto_listing_ai_channel_pool.sql \
  server/tests/auto-listing-ai-channel-pool-migration.test.mjs \
  server/tests/auto-listing-ai-channel-pool-migration-postgres.integration.test.mjs \
  server/tests/auto-listing-ai-runtime-postgres-fixture.mjs
git commit -m "feat: add auto-listing AI channel pool schema"
```

---

## 任务 2：在现有 AI 设置边界管理通道成员

**文件：**

- 修改：`server/auto-listing-ai-settings-postgres.mjs`
- 修改：`server/auto-listing-ai-settings-service.mjs`
- 修改：`server/auto-listing-ai-settings-routes.mjs`
- 修改：`server/auto-listing-ai-settings-runtime.mjs`
- 修改：`server/tests/auto-listing-ai-settings-postgres.test.mjs`
- 修改：`server/tests/auto-listing-ai-settings-postgres.integration.test.mjs`
- 修改：`server/tests/auto-listing-ai-settings-service.test.mjs`
- 修改：`server/tests/auto-listing-ai-settings-routes.test.mjs`
- 修改：`server/tests/auto-listing-ai-settings-runtime.test.mjs`

- [ ] **步骤 1：写服务与路由失败测试**

服务仓储 contract 增加且只增加：

```js
listProfileChannels({ accountId, profileId, profileVersion })
addProfileChannel({ accountId, profileId, profileVersion, connectionId, connectionVersion, displayName, actorAccountId })
setProfileChannelEnabled({ accountId, profileId, profileVersion, channelId, enabled, actorAccountId })
```

断言：

- `getOverview()` 返回 `channels`，每项只有 `channelId/displayName/channelOrder/enabled/status/connectionDisplayName/connectionId/connectionVersion/assignedItemId/cooldownUntil/requiresRevalidation/lastErrorCode`；
- 不返回 `apiKey`、密文、IV、认证标签或完整内部错误；
- 添加通道必须引用当前账号、当前启用主配置版本和已验证兼容连接；
- 发布新的主配置版本时，在同一事务把该版本绑定的主连接建立为 `channel_order=1`；不得把旧版本附加通道未经新能力验证自动复制到新版本；
- 发布新版本后，旧任务仍按自己冻结的旧 profile version 和旧 channel membership 运行；不得改绑到当前启用版本；
- 忙碌通道停用只阻止新分配，不清除当前商品或执行租约；
- 重新启用 `requiresRevalidation=true` 的通道被拒绝，必须先通过既有连接验证；
- 路由继续要求 `AI_CONTENT_MANAGE`。

新增路由：

```text
POST /admin/auto-listing/ai-settings/profiles/:profileId/versions/:profileVersion/channels
POST /admin/auto-listing/ai-settings/profiles/:profileId/versions/:profileVersion/channels/:channelId/status
```

运行：

```bash
node --test \
  server/tests/auto-listing-ai-settings-service.test.mjs \
  server/tests/auto-listing-ai-settings-routes.test.mjs
```

预期：失败，提示方法或路由不存在。

- [ ] **步骤 2：实现 PostgreSQL 查询和写入**

`listProfileChannels` 直接关联确切连接版本，不依赖概览中最多 10 条的连接分页；overview 另返回安全的 `channelCandidates`，供页面选择已验证且与当前 profile contract 兼容的连接：

```sql
SELECT channel.*, connection.display_name AS connection_display_name,
       CASE
         WHEN channel.requires_revalidation THEN 'REQUIRES_REVALIDATION'
         WHEN NOT channel.enabled THEN 'DISABLED'
         WHEN channel.cooldown_until > NOW() THEN 'COOLDOWN'
         WHEN channel.assigned_item_id IS NOT NULL THEN 'BUSY'
         ELSE 'AVAILABLE'
       END AS status
  FROM auto_listing_ai_profile_channels AS channel
  JOIN ai_gateway_connections AS connection
    ON connection.account_id=channel.account_id AND connection.id=channel.connection_id
 WHERE channel.account_id=$1 AND channel.profile_id=$2 AND channel.profile_version=$3
 ORDER BY channel.channel_order;
```

添加通道在一个事务中锁定主配置和连接版本，复用现有 capability evidence 判断文本模型、图片模型与协议兼容。`channel_order` 使用同一配置版本当前最大值加一。`publishProfile` 的既有事务同时为新版本插入主通道 1；旧版本附加通道不复制。主通道不得从成员列表删除；本次只实现启用/停用，不增加删除接口。

- [ ] **步骤 3：实现服务、路由和运行时装配**

输入继续用项目现有 closed-object、安全 ID、账号权限和安全错误码约束。启停返回更新后的安全通道 DTO。审计事件记录连接 ID/版本、通道 ID、操作人和启停结果，不记录连接地址或 Key。

- [ ] **步骤 4：运行设置回归**

```bash
node --test \
  server/tests/auto-listing-ai-settings-postgres.test.mjs \
  server/tests/auto-listing-ai-settings-postgres.integration.test.mjs \
  server/tests/auto-listing-ai-settings-service.test.mjs \
  server/tests/auto-listing-ai-settings-routes.test.mjs \
  server/tests/auto-listing-ai-settings-runtime.test.mjs \
  server/tests/auto-listing-ai-settings-e2e.test.mjs \
  server/tests/auto-listing-ai-settings-overview-bounds.test.mjs
```

预期：全部通过。

- [ ] **步骤 5：提交**

```bash
git add server/auto-listing-ai-settings-postgres.mjs \
  server/auto-listing-ai-settings-service.mjs \
  server/auto-listing-ai-settings-routes.mjs \
  server/auto-listing-ai-settings-runtime.mjs \
  server/tests/auto-listing-ai-settings-postgres.test.mjs \
  server/tests/auto-listing-ai-settings-postgres.integration.test.mjs \
  server/tests/auto-listing-ai-settings-service.test.mjs \
  server/tests/auto-listing-ai-settings-routes.test.mjs \
  server/tests/auto-listing-ai-settings-runtime.test.mjs
git commit -m "feat: manage auto-listing AI channels"
```

---

## 任务 3：在 AI 设置页展示和启停独立通道

**文件：**

- 修改：`app/src/auto-listing-ai-settings-client.js`
- 修改：`app/src/auto-listing-ai-settings-view.js`
- 修改：`app/src/AiModelSettingsPage.jsx`
- 修改：`app/src/auto-listing-ai-settings.css`
- 修改：`app/tests/auto-listing-ai-settings-client.test.mjs`
- 修改：`app/tests/auto-listing-ai-settings-view.test.mjs`
- 修改：`app/tests/auto-listing-ai-settings-page-contract.test.mjs`
- 修改：`app/tests/auto-listing-ai-settings-overview-bounds.test.mjs`

- [ ] **步骤 1：写前端 client 和 view 失败测试**

client 新增：

```js
addAutoListingAiChannel(http, { profileId, profileVersion, connectionId, connectionVersion, displayName })
setAutoListingAiChannelEnabled(http, { profileId, profileVersion, channelId, enabled })
```

view model 将状态映射为：`可用 / 使用中 / 冷却中 / 需要重新验证 / 已停用`，并严格拒绝未知字段、非法时间或含敏感字段的响应。

页面 contract 断言模型/协议区域只有一套，通道列表位于其下；页面不得为每个通道增加模型选择器。

运行：

```bash
node --test \
  app/tests/auto-listing-ai-settings-client.test.mjs \
  app/tests/auto-listing-ai-settings-view.test.mjs \
  app/tests/auto-listing-ai-settings-page-contract.test.mjs
```

预期：失败，提示导出或“自动上架独立通道”区域不存在。

- [ ] **步骤 2：实现 client 与视图模型**

继续复用现有 `requestJson` 和 secret scrub；不要增加第二套 HTTP helper。通道显示对象冻结为：

```js
Object.freeze({
  channelId,
  displayName,
  channelOrder,
  enabled,
  status,
  statusLabel,
  connectionDisplayName,
  connectionId,
  connectionVersion,
  assignedItemId,
  cooldownUntil,
  requiresRevalidation,
  lastErrorCode,
});
```

- [ ] **步骤 3：实现页面区域**

在主模型与协议卡片下增加 `AutoListingChannelSection`：

- 通道名、连接名、安全状态、当前占用商品（只有安全 ID）、启停按钮；
- “添加通道”只允许从已经验证且兼容的连接中选择；
- Key 仍只在现有“新增连接”表单输入，通道列表不显示也不回填；
- 停用忙碌通道时提示“当前商品完成后停用生效”；
- 所有通道不可用时显示配置级警告，但不把任务标成失败。

- [ ] **步骤 4：运行前端设置测试和构建**

```bash
node --test \
  app/tests/auto-listing-ai-settings-client.test.mjs \
  app/tests/auto-listing-ai-settings-view.test.mjs \
  app/tests/auto-listing-ai-settings-page-contract.test.mjs \
  app/tests/auto-listing-ai-settings-overview-bounds.test.mjs
pnpm run build
```

预期：全部通过，Vite 构建成功。

- [ ] **步骤 5：提交**

```bash
git add app/src/auto-listing-ai-settings-client.js \
  app/src/auto-listing-ai-settings-view.js \
  app/src/AiModelSettingsPage.jsx \
  app/src/auto-listing-ai-settings.css \
  app/tests/auto-listing-ai-settings-client.test.mjs \
  app/tests/auto-listing-ai-settings-view.test.mjs \
  app/tests/auto-listing-ai-settings-page-contract.test.mjs \
  app/tests/auto-listing-ai-settings-overview-bounds.test.mjs
git commit -m "feat: show auto-listing AI channel controls"
```

---

## 任务 4：定义 v3 执行信封并把 Outbox 发布改为可接管派发

**文件：**

- 新建：`server/auto-listing-ai-work-message.mjs`
- 新建：`server/tests/auto-listing-ai-work-message.test.mjs`
- 修改：`server/auto-listing-ai-queue.mjs`
- 修改：`server/auto-listing-ai-outbox-postgres.mjs`
- 修改：`server/auto-listing-ai-runtime-composition.mjs`
- 修改：`server/tests/auto-listing-ai-queue.test.mjs`
- 修改：`server/tests/auto-listing-ai-outbox-postgres.test.mjs`
- 修改：`server/tests/auto-listing-ai-runtime-composition.test.mjs`

- [ ] **步骤 1：写执行信封 closed-contract 测试**

新 contract：

```js
{
  workContractVersion: "CHANNEL_WORK_V1",
  message: { /* 现有 V1 业务消息，原样嵌套 */ },
  execution: {
    outboxId,
    dispatchGeneration,
    channelId,
    connectionId,
    connectionVersion,
    leaseOwner,
    leaseToken,
    leaseExpiresAt,
  },
}
```

`normalizeAutoListingAiWorkMessage()` 必须拒绝未知字段、过期/非法租约值、跨消息账号信息、敏感字段和不安全 ID。`autoListingAiWorkSingletonKey()` 返回：

```js
`${autoListingAiMessageDedupeKey(message)}:${dispatchGeneration}`
```

运行：

```bash
node --test server/tests/auto-listing-ai-work-message.test.mjs
```

预期：失败，模块不存在。

- [ ] **步骤 2：实现执行信封模块**

只复用 `normalizeAutoListingAiMessage()` 和现有安全 ID；信封中不放 `baseUrl`、Key、profile secrets 或上游错误。`leaseExpiresAt` 规范化为有限 ISO 时间字符串，版本均为正整数。

- [ ] **步骤 3：写发布生命周期失败测试**

断言：

- 新队列名为 `auto-listing-ai-v3`，旧 `auto-listing-ai-v2` 常量仍导出用于排空；
- v3 queue options 不包含 `expireInSeconds`；v2 也移除该总运行时限，保留 retry/retention/heartbeat 等基础设施保护；
- publisher 调用 `claimAutoListingAiWork()`，发布执行信封；
- 发布成功只调用 `markAutoListingAiWorkPublished()`，不调用 `completeAutoListingAiMessage()`；
- 队列 singleton 使用 `dedupe + dispatchGeneration`；同一代重复发布被去重，新一代可以发布；
- 明确发布失败调用 `releaseUnpublishedAutoListingAiWork()`，清除当前执行租约但保留商品固定通道；
- 发布超时结果不确定时也由 lease fencing 保证旧消息不能获得模型调用权。
- 连接版本式任务只允许进入 v3；环境变量式旧 profile 使用受限的 legacy claim 进入 v2，不能伪造通道成员。

运行：

```bash
node --test \
  server/tests/auto-listing-ai-queue.test.mjs \
  server/tests/auto-listing-ai-outbox-postgres.test.mjs
```

预期：失败，方法和 v3 队列不存在。

- [ ] **步骤 4：实现 publisher 与运行时装配**

`claimAutoListingAiWork()` 暂时只要求返回已准备好的执行信封；原子通道选择在任务 5 完成。生产 publisher 同时保留 `claimLegacyAutoListingAiMessages()`，但 SQL 必须限定任务冻结 profile 没有 connection ID。publisher 的 v3 成功路径为：

```js
const evidence = await queueAdapter.publish(row.workMessage);
await outboxRepository.markAutoListingAiWorkPublished({
  accountId: row.accountId,
  itemId: row.itemId,
  id: row.id,
  workerId: row.leaseOwner,
  leaseToken: row.leaseToken,
  publicationId: row.publicationId,
});
```

不要在此终结 Outbox；终结与业务 outcome 在任务 6 的 workflow 事务中完成。

- [ ] **步骤 5：运行队列/装配测试**

```bash
node --test \
  server/tests/auto-listing-ai-work-message.test.mjs \
  server/tests/auto-listing-ai-queue.test.mjs \
  server/tests/auto-listing-ai-outbox-postgres.test.mjs \
  server/tests/auto-listing-ai-runtime-composition.test.mjs
```

预期：全部通过。

- [ ] **步骤 6：提交**

```bash
git add server/auto-listing-ai-work-message.mjs \
  server/auto-listing-ai-queue.mjs \
  server/auto-listing-ai-outbox-postgres.mjs \
  server/auto-listing-ai-runtime-composition.mjs \
  server/tests/auto-listing-ai-work-message.test.mjs \
  server/tests/auto-listing-ai-queue.test.mjs \
  server/tests/auto-listing-ai-outbox-postgres.test.mjs \
  server/tests/auto-listing-ai-runtime-composition.test.mjs
git commit -m "feat: publish fenced auto-listing AI work"
```

---

## 任务 5：在 Outbox 领取事务原子分配固定通道和执行租约

**文件：**

- 修改：`server/auto-listing-ai-outbox-postgres.mjs`
- 修改：`server/tests/auto-listing-ai-outbox-postgres.test.mjs`
- 新建：`server/tests/auto-listing-ai-channel-allocation-postgres.integration.test.mjs`

- [ ] **步骤 1：写通道容量失败测试**

使用真实 PostgreSQL 覆盖：

1. 一通道、两商品：只领取第一件，第二件保留 `PENDING` 且 `attempts=0`；
2. 两通道、三商品：前两件得到不同通道，第三件等待；
3. 已固定商品的后续 phase 优先于未分配商品，并继续使用原通道；
4. 同一商品多个图片槽位只能领取一个；
5. 过期 execution lease 被回收并由新 Worker 接管同一固定商品，不清除商品分配；
6. 已离开 `PLANNING/GENERATING`、取消或没有可恢复 Outbox 的陈旧分配被清理；
7. `enabled=false`、冷却未结束、`requires_revalidation=true` 的通道不参与选择；
8. 选择顺序为 `next_retry_at/available_at → job.created_at → item.source_order → outbox.created_at → outbox.id`；
9. 一个账号无可用通道不影响另一个账号领取。
10. v3 即使经历 6 次以上发布失败、lease 过期或确定未发送的通道故障也不会因旧 `maxAttempts=5` 进入 DEAD；结果不确定次数仍由独立列严格限制。
11. 发布新 profile 后，旧任务继续使用其冻结 profile version 的旧通道；领取 SQL 不以 `profile.enabled=true` 过滤历史任务，旧连接版本由现有 resolver 的 `RETIRED` 只读兼容规则解析。

运行：

```bash
node --test server/tests/auto-listing-ai-channel-allocation-postgres.integration.test.mjs
```

预期：失败，现有领取仍使用批次前序稳定门禁。

- [ ] **步骤 2：实现单事务领取**

在 `BEGIN ISOLATION LEVEL READ COMMITTED` 中按以下顺序执行：

```text
清除过期 execution lease（保留仍在 AI 阶段的 assigned item）
清除已离开 AI 阶段的陈旧 assigned item
锁定最早可运行 Outbox 行
若商品已有固定通道，锁定该通道
否则先尝试 item.last_ai_connection_id/version，再按 channel_order 锁定空闲健康通道
写入 assigned job/item/status version 与 item 亲和字段
dispatch_generation += 1
写入 Outbox PROCESSING lease 和通道 execution lease（同 token、同 expiry）
设置 publication_id = dedupe_key || ':' || dispatch_generation
返回 CHANNEL_WORK_V1 信封
```

删除 AI 领取 SQL 中两处旧逻辑：前序商品稳定状态 `NOT EXISTS` 和同一批次任一 live Outbox 门禁。替换成通道容量与“同一商品只有一个 live execution lease”。

现有 `claimAutoListingAiMessages()` 收窄并命名为 legacy claim，只选择任务冻结 profile 没有 connection ID 的环境变量式记录；连接版本式任务必须经过 `claimAutoListingAiWork()`，不能从旧门禁旁路。

v3 的 `attempts` 只作为派发审计计数，不受旧 `maxAttempts` 终止门槛约束；旧 v2 记录继续使用原有最多 5 次发布保护。修改 runnable account discovery、expired reconcile 和 DEAD recovery 时按 `dispatch_contract_version` 区分两种语义。

没有可用通道时直接返回空数组；不得更新 Outbox、attempts、item 或事件。

- [ ] **步骤 3：实现发布标记、释放和双租约续期**

仓储增加：

```js
markAutoListingAiWorkPublished(command)
adoptAutoListingAiWork(command)
renewAutoListingAiWorkLease(command)
releaseUnpublishedAutoListingAiWork(command)
```

`adopt` 用信封中的 relay owner/token 同时更新 Outbox 与通道 execution owner/token；任一不匹配则整笔拒绝。`renew` 在一个事务中续期两处，不能只续一处。心跳失去 fencing 后 Worker 不得继续调用模型。

- [ ] **步骤 4：运行领取与旧 Outbox 回归**

```bash
node --test \
  server/tests/auto-listing-ai-outbox-postgres.test.mjs \
  server/tests/auto-listing-ai-channel-allocation-postgres.integration.test.mjs \
  server/tests/auto-listing-ai-recovery-postgres.integration.test.mjs \
  server/tests/auto-listing-ai-retry-postgres.integration.test.mjs
```

预期：全部通过；历史 v2 Outbox 查询与恢复测试保持通过。

- [ ] **步骤 5：提交**

```bash
git add server/auto-listing-ai-outbox-postgres.mjs \
  server/tests/auto-listing-ai-outbox-postgres.test.mjs \
  server/tests/auto-listing-ai-channel-allocation-postgres.integration.test.mjs
git commit -m "feat: allocate auto-listing AI channels atomically"
```

---

## 任务 6：让 Worker 接管租约、串行执行、切换通道并受控处理不确定结果

**文件：**

- 修改：`server/auto-listing-ai-worker.mjs`
- 修改：`server/auto-listing-ai-orchestrator.mjs`
- 修改：`server/auto-listing-ai-workflow-postgres.mjs`
- 修改：`server/auto-listing-ai-runtime-composition.mjs`
- 修改：`server/tests/auto-listing-ai-worker.test.mjs`
- 修改：`server/tests/auto-listing-ai-orchestrator.test.mjs`
- 修改：`server/tests/auto-listing-ai-workflow-postgres.test.mjs`
- 修改：`server/tests/auto-listing-ai-workflow-postgres.integration.test.mjs`
- 修改：`server/tests/auto-listing-ai-workflow-journey.test.mjs`

- [ ] **步骤 1：写 Worker 生命周期失败测试**

Worker factory 增加一个专一依赖 `executionRepository`，公开方法为 `adopt/renew/requeueChannelFailure`；workflow 的 `applyOutcome` 改为：

```js
applyOutcome({ message, outcome, execution })
```

覆盖：

- v3 job 未成功 adopt 时不调用 `loadContext` 或模型；
- 心跳间隔不超过 `leaseMs / 3`，同时续 Outbox 和通道 lease；
- 同一 phase 内部 retry 不绕过固定通道；
- 网络失败、429、无响应、意外 EOF、异常结果进入 channel failure 路径，不直接把商品标错；
- 429、401、403、模型不存在这类明确拒绝响应视为 `NOT_SENT`，不消耗结果不确定重试次数；
- 鉴权/模型不存在把通道设为 `requires_revalidation`；
- 业务内容校验失败不冷却通道，仍走现有 item failure；
- 忙碌通道被管理员停用时允许当前调用结束；成功落库后释放 fixed assignment，下一 phase 不再使用已停用通道；
- v3 不对通道错误执行 Worker 内联重复调用，而是先持久化 requeue/cooldown，再由新派发代次恢复；
- Worker 结束时总会停止心跳；失去租约只返回 stale，不保存结果；
- v2 plain message 仍由 legacy handler 处理，用于排空部署前队列和环境变量式旧 profile；连接版本式任务不进入旧 publisher。

运行：

```bash
node --test server/tests/auto-listing-ai-worker.test.mjs
```

预期：失败，Worker 仍只接受旧业务消息。

- [ ] **步骤 2：实现安全故障分类**

在 Worker/现有 orchestrator 边界使用小型、显式集合，不建立通用策略框架。orchestrator outcome 增加三个安全字段 `failureScope`、`deliveryState`、`retryAfterMs`；ACK 时三者均为 `null`，业务失败为 `failureScope="BUSINESS"`，通道错误只能是 `CHANNEL_TRANSIENT` 或 `CHANNEL_REVALIDATION`：

```js
const CHANNEL_TRANSIENT_CODES = new Set([
  "AI_GATEWAY_NETWORK_FAILED",
  "AI_GATEWAY_RATE_LIMITED",
  "AI_GATEWAY_IDLE_TIMEOUT",
  "AI_GATEWAY_UNEXPECTED_EOF",
  "INVALID_GATEWAY_RESPONSE",
]);
const CHANNEL_REVALIDATION_CODES = new Set([
  "AI_GATEWAY_UNAUTHORIZED",
  "AI_GATEWAY_MODEL_NOT_FOUND",
  "AI_GATEWAY_CAPABILITY_INVALID",
]);
```

实际集合必须与 `sub2api-ai-adapter.mjs` 当前安全错误码对齐；测试锁定每一个受支持码。调用者取消和商品取消不归为通道故障。

- [ ] **步骤 3：实现同事务 outcome 与租约释放**

`applyOutcome({ message, outcome, execution })` 首先锁定确切 Outbox、item 和 channel，并校验 owner/token/status version。然后：

- ACK 后执行现有业务状态变化和下一个 Outbox 入队；
- ACK 成功把当前通道的 `consecutive_failure_count` 归零，并清除已经过期的 `cooldown_until/last_error_code`；
- 商品仍在 `PLANNING/GENERATING`：完成当前 Outbox、清 execution lease、保留固定 assigned item；
- 若当前通道已被停用，即使商品仍在 AI 阶段也在完成当前 Outbox 后清 fixed assignment；下一 Outbox 等待或选择其他健康通道；
- 商品进入 `READY_FOR_REVIEW/UPLOAD_QUEUED/RETRYABLE_ERROR/BLOCKED/CANCELLED/SUCCEEDED`：完成当前 Outbox、清 execution lease 和 fixed assignment；
- 任何 fencing 不匹配：不写业务结果，返回 stale。

`requeueChannelFailure` 同事务：

```text
校验 outbox + channel execution token
根据 Retry-After 或默认 60 秒设置 cooldown_until
配置错误设置 requires_revalidation=true
清 assigned item 与 execution lease
Outbox 回到 PENDING，清 publication 字段，next_retry_at=NOW()
保留已接受 plan/asset/rich result
```

结果不确定按 `(item_id, expected_status_version, phase, phase_target_id)` 对应 Outbox 的 `uncertain_result_count`：第一次从 0 变 1 并重新排队；第二次从 1 变 2 后调用现有 retryable failure transition，提示安全错误码 `AUTO_LISTING_AI_RESULT_UNCERTAIN`。新人工重试会产生新 `status_version` 和新 Outbox，因此重新获得一次受控恢复机会。

- [ ] **步骤 4：注册 v2 排空和 v3 主 Worker**

同一 boss 实例：

- `auto-listing-ai-v2`：只接受 plain V1，排空部署前消息并处理环境变量式旧 profile；
- `auto-listing-ai-v3`：只接受 `CHANNEL_WORK_V1`；
- 新 publisher 只写 v3；
- v2 队列排空后保留兼容消费一个发布周期，后续删除需单独迁移，不在本次删除。

- [ ] **步骤 5：运行 Worker/workflow 回归**

```bash
node --test \
  server/tests/auto-listing-ai-worker.test.mjs \
  server/tests/auto-listing-ai-workflow-postgres.test.mjs \
  server/tests/auto-listing-ai-workflow-postgres.integration.test.mjs \
  server/tests/auto-listing-ai-workflow-journey.test.mjs \
  server/tests/auto-listing-ai-runtime-composition.test.mjs
```

预期：全部通过。

- [ ] **步骤 6：提交**

```bash
git add server/auto-listing-ai-worker.mjs \
  server/auto-listing-ai-orchestrator.mjs \
  server/auto-listing-ai-workflow-postgres.mjs \
  server/auto-listing-ai-runtime-composition.mjs \
  server/tests/auto-listing-ai-worker.test.mjs \
  server/tests/auto-listing-ai-orchestrator.test.mjs \
  server/tests/auto-listing-ai-workflow-postgres.test.mjs \
  server/tests/auto-listing-ai-workflow-postgres.integration.test.mjs \
  server/tests/auto-listing-ai-workflow-journey.test.mjs
git commit -m "feat: recover auto-listing AI work across channels"
```

---

## 任务 7：把确切租用连接路由到各 AI 阶段并记录费用来源

**文件：**

- 修改：`server/auto-listing-ai-phase-context-postgres.mjs`
- 修改：`server/auto-listing-ai-credential-resolver.mjs`
- 修改：`server/auto-listing-content-planner.mjs`
- 修改：`server/auto-listing-image-generator.mjs`
- 修改：`server/auto-listing-rich-content.mjs`
- 修改：`server/auto-listing-result-checker.mjs`
- 修改：`server/auto-listing-content-plan-evidence-postgres.mjs`
- 修改：`server/auto-listing-generation-attempt-postgres.mjs`
- 修改：`server/auto-listing-rich-content-repository.mjs`
- 修改：`server/tests/auto-listing-ai-phase-context-postgres.test.mjs`
- 修改：`server/tests/auto-listing-ai-phase-context-postgres.integration.test.mjs`
- 修改：`server/tests/auto-listing-ai-credential-resolver.test.mjs`
- 修改：`server/tests/auto-listing-ai-orchestrator.test.mjs`

- [ ] **步骤 1：写确切路由失败测试**

`loadContext` 接收 `{ message, execution }`。测试冻结 profile 的模型/协议来自任务版本，但 `phaseInput.gatewayProfile.connectionId/connectionVersion/baseUrl` 来自 `execution` 指定连接。任何账号、profile 版本、连接版本或通道分配不一致都返回安全 context error，不能回退默认连接。

运行：

```bash
node --test \
  server/tests/auto-listing-ai-phase-context-postgres.test.mjs \
  server/tests/auto-listing-ai-credential-resolver.test.mjs
```

预期：失败，context 仍使用 profile 主连接。

- [ ] **步骤 2：实现 exact-version context**

在现有 phase context SQL 中关联 channel row 和 `ai_gateway_connection_versions`，只投影安全连接配置。credential resolver 继续用既有：

```js
resolve({ accountId, connectionId, connectionVersion })
```

不增加“选择任意可用连接”的 resolver；选择权只在 Outbox 领取事务。

- [ ] **步骤 3：把连接来源写入证据**

planner 开始 attempt 时保存 `gateway_connection_id/version`；image generation 保存生成连接，checker 保存 `checker_connection_id/version`；rich content 保存其 gateway 连接。仓储所有完成/失败更新都校验原 attempt 所属账号、item、status version 和连接版本，避免重试把新通道结果写到旧 attempt。

phase input 对四个模型调用统一提供：

```js
gatewayExecution: Object.freeze({
  channelId,
  connectionId,
  connectionVersion,
  idleTimeoutMs: 300_000,
})
```

- [ ] **步骤 4：运行路由与证据回归**

```bash
node --test \
  server/tests/auto-listing-ai-phase-context-postgres.test.mjs \
  server/tests/auto-listing-ai-phase-context-postgres.integration.test.mjs \
  server/tests/auto-listing-ai-credential-resolver.test.mjs \
  server/tests/auto-listing-ai-orchestrator.test.mjs \
  server/tests/auto-listing-ai-plan-evidence-migration.test.mjs \
  server/tests/auto-listing-ai-generation-evidence-migration.test.mjs
```

预期：全部通过。

- [ ] **步骤 5：提交**

```bash
git add server/auto-listing-ai-phase-context-postgres.mjs \
  server/auto-listing-ai-credential-resolver.mjs \
  server/auto-listing-content-planner.mjs \
  server/auto-listing-image-generator.mjs \
  server/auto-listing-rich-content.mjs \
  server/auto-listing-result-checker.mjs \
  server/auto-listing-content-plan-evidence-postgres.mjs \
  server/auto-listing-generation-attempt-postgres.mjs \
  server/auto-listing-rich-content-repository.mjs \
  server/tests/auto-listing-ai-phase-context-postgres.test.mjs \
  server/tests/auto-listing-ai-phase-context-postgres.integration.test.mjs \
  server/tests/auto-listing-ai-credential-resolver.test.mjs \
  server/tests/auto-listing-ai-orchestrator.test.mjs
git commit -m "feat: route auto-listing phases through leased channels"
```

---

## 任务 8：把固定总超时改成自动上架调用的无响应看门狗

**文件：**

- 修改：`server/sub2api-ai-adapter.mjs`
- 修改：`server/tests/sub2api-ai-adapter.test.mjs`
- 修改：`server/tests/sub2api-gateway-boundary.test.mjs`
- 修改：`server/auto-listing-content-planner.mjs`
- 修改：`server/auto-listing-image-generator.mjs`
- 修改：`server/auto-listing-rich-content.mjs`
- 修改：`server/auto-listing-result-checker.mjs`

- [ ] **步骤 1：写看门狗和错误来源失败测试**

覆盖：

1. `idleTimeoutMs=300000` 时，连续收到可解析进度事件超过 5 分钟仍不终止；
2. 5 分钟没有完整、可解析响应事件时中止并抛 `AI_GATEWAY_IDLE_TIMEOUT`；
3. 普通 JSON 响应在收到完整 body 后重置/结束 watchdog；
4. SSE 只有字节噪声、半截 frame 或 keep-alive 注释不算业务进度；完整合法 frame 才重置；
5. caller abort 仍优先并保留取消语义；
6. 管理员 sync/test 继续使用现有 `timeoutMs` 总时限；
7. 429 解析安全 `Retry-After`，限制到 24 小时，并标记为明确拒绝的 `NOT_SENT`；
8. 错误带只读安全字段 `deliveryState: "NOT_SENT" | "POSSIBLY_SENT"` 和 `retryAfterMs`，不暴露 header/body。

运行：

```bash
node --test \
  server/tests/sub2api-ai-adapter.test.mjs \
  server/tests/sub2api-gateway-boundary.test.mjs
```

预期：失败，适配器仍使用一次性总 timeout。

- [ ] **步骤 2：实现调用级 watchdog**

把当前 `abortContext(callerSignal, timeoutMs)` 拆为仍兼容管理员调用的 context：

```js
createAbortContext({ callerSignal, timeoutMs, idleTimeoutMs, timers })
```

规则：

- `timeoutMs` 和 `idleTimeoutMs` 互斥；自动上架只传 `idleTimeoutMs`；
- 每次成功解析一个完整 JSON 响应或一个完整 SSE data frame 后重新安排 idle timer；
- response 结束立即清 timer；
- reader/iterator、fetch、解析和 caller abort 所有退出路径都清理 timer/listener；
- 不因任意字节到达而续时，避免上游用无效噪声永久占用通道。

SSE 解析改为增量 frame buffer；不要先无界收完整响应再解析。保留现有 body size 上限。

- [ ] **步骤 3：实现发送不确定性标记**

fetch 尚未开始时错误为 `NOT_SENT`；一旦调用 fetch 后发生网络断开、EOF、5xx 后异常结束或成功状态解析失败则为 `POSSIBLY_SENT`。明确拒绝生成的 401、403、404/模型不存在和 429 为 `NOT_SENT`。Worker 用此字段决定是否增加 `uncertain_result_count`。错误 message 保持固定中文安全文案。

- [ ] **步骤 4：运行 adapter 与调用方测试**

```bash
node --test \
  server/tests/sub2api-ai-adapter.test.mjs \
  server/tests/sub2api-gateway-boundary.test.mjs \
  server/tests/auto-listing-ai-orchestrator.test.mjs \
  server/tests/auto-listing-ai-worker.test.mjs
```

预期：全部通过。

- [ ] **步骤 5：提交**

```bash
git add server/sub2api-ai-adapter.mjs \
  server/auto-listing-content-planner.mjs \
  server/auto-listing-image-generator.mjs \
  server/auto-listing-rich-content.mjs \
  server/auto-listing-result-checker.mjs \
  server/tests/sub2api-ai-adapter.test.mjs \
  server/tests/sub2api-gateway-boundary.test.mjs
git commit -m "fix: fence idle auto-listing AI calls"
```

---

## 任务 9：恢复 Ozon 上传批次顺序门禁

**文件：**

- 修改：`server/auto-listing-upload-task-postgres.mjs`
- 修改：`server/tests/auto-listing-upload-task-postgres.integration.test.mjs`
- 修改：`server/tests/auto-listing-upload-task-worker.test.mjs`

- [ ] **步骤 1：写上传顺序失败测试**

构造同一 job：item 1 为 `READY_FOR_REVIEW`、`UPLOADING` 或 `UPLOAD_QUEUED`，item 2 已完成 AI 且有 `PENDING` upload task。断言 item 2 不被领取。item 1 进入 `SUCCEEDED/RETRYABLE_ERROR/BLOCKED/CANCELLED` 后 item 2 可以领取。不同 job 不互相阻塞。

另测：一个通道时 item 1 已进入上传、item 2 可以开始 AI，但 item 2 不能先提交 Ozon。

运行：

```bash
node --test server/tests/auto-listing-upload-task-postgres.integration.test.mjs
```

预期：失败，现有 `leaseNext` 只按 task 时间排序。

- [ ] **步骤 2：在唯一上传领取边界增加前序门禁**

给 `leaseNext` candidate 增加：

```sql
AND NOT EXISTS (
  SELECT 1
    FROM auto_listing_job_items AS predecessor
   WHERE predecessor.account_id=item.account_id
     AND predecessor.job_id=item.job_id
     AND predecessor.source_order < item.source_order
     AND predecessor.status NOT IN (
       'SUCCEEDED','RETRYABLE_ERROR','BLOCKED','CANCELLED'
     )
)
```

`READY_FOR_REVIEW` 只表示 AI 阶段稳定，不表示已经完成 Ozon 顺序位；如果用户先批准后序商品，它仍必须等待前序商品被批准并成功/失败，或被取消。实际 Ozon upload task 按可领取 task 的 `source_order` 排序：

```sql
ORDER BY task.next_run_at, item.source_order, task.created_at, task.id
```

不要把此门禁复制到 upload worker 或 service。

- [ ] **步骤 3：运行上传回归**

```bash
node --test \
  server/tests/auto-listing-upload-task-postgres.integration.test.mjs \
  server/tests/auto-listing-upload-task-worker.test.mjs \
  server/tests/auto-listing-upload-postgres.integration.test.mjs \
  server/tests/auto-listing-upload-service.test.mjs
```

预期：全部通过。

- [ ] **步骤 4：提交**

```bash
git add server/auto-listing-upload-task-postgres.mjs \
  server/tests/auto-listing-upload-task-postgres.integration.test.mjs \
  server/tests/auto-listing-upload-task-worker.test.mjs
git commit -m "fix: preserve batch order at Ozon upload"
```

---

## 任务 10：投影等待、调用和故障切换状态到任务中心

**文件：**

- 修改：`server/auto-listing-repository.mjs`
- 修改：`server/auto-listing-service.mjs`
- 修改：`server/tests/auto-listing-repository.test.mjs`
- 修改：`server/tests/auto-listing-service.test.mjs`
- 修改：`app/src/AutoListingPage.jsx`
- 修改：`app/tests/auto-listing-task-polling.browser.test.mjs`
- 修改：`app/tests/auto-listing-task-center.browser.test.mjs`

- [ ] **步骤 1：写任务 DTO 失败测试**

在 item 顶层增加，不改变现有 exact `workflowProgress` contract：

```js
aiQueueState: "WAITING_FOR_AI_CHANNEL" | "CALLING_AI" | "SWITCHING_AI_CHANNEL" | null,
aiChannelDisplayName: string | null,
aiChannelSwitching: boolean,
aiChannelWaitStartedAt: string | null,
```

投影规则：

- 有当前 execution lease：`CALLING_AI`；
- 有 fixed assignment、无 execution lease、存在可运行 Outbox：等待同通道接管，不误报正在规划；
- 最近 channel failure 后 Outbox `PENDING` 且无 assignment：`SWITCHING_AI_CHANNEL`；
- 无 assignment 且存在可运行 AI Outbox，但没有可用通道：`WAITING_FOR_AI_CHANNEL`；
- 非 AI 阶段：四字段回到 null/false；
- `aiChannelWaitStartedAt` 使用当前 Outbox 的 `next_retry_at/available_at` 或本次故障重排时间，不新增第二套状态字段。

运行：

```bash
node --test \
  server/tests/auto-listing-repository.test.mjs \
  server/tests/auto-listing-service.test.mjs
```

预期：失败，DTO 没有新字段。

- [ ] **步骤 2：实现单查询安全投影**

扩展任务列表已有 lateral join，一次取得最新可运行 Outbox 和当前 profile channel；避免逐 item N+1 查询。服务 closed DTO 白名单加入四字段，通道显示名使用管理员配置名，错误仅使用安全码映射。

- [ ] **步骤 3：实现任务中心文案**

任务进度优先显示：

```text
WAITING_FOR_AI_CHANNEL -> 等待可用 AI 通道
CALLING_AI             -> 正在使用「{通道名}」生成
SWITCHING_AI_CHANNEL   -> 原通道暂不可用，正在等待其他通道
```

保持最后完成阶段的百分比；等待状态不伪造 30%/60% 进度增长。页面不显示连接 ID、版本、租约或原始错误。

- [ ] **步骤 4：运行任务中心测试和构建**

```bash
node --test \
  server/tests/auto-listing-repository.test.mjs \
  server/tests/auto-listing-service.test.mjs \
  app/tests/auto-listing-task-polling.browser.test.mjs \
  app/tests/auto-listing-task-center.browser.test.mjs
pnpm run build
```

预期：全部通过，构建成功。

- [ ] **步骤 5：提交**

```bash
git add server/auto-listing-repository.mjs \
  server/auto-listing-service.mjs \
  server/tests/auto-listing-repository.test.mjs \
  server/tests/auto-listing-service.test.mjs \
  app/src/AutoListingPage.jsx \
  app/tests/auto-listing-task-polling.browser.test.mjs \
  app/tests/auto-listing-task-center.browser.test.mjs
git commit -m "feat: show auto-listing AI channel queue state"
```

---

## 任务 11：端到端容量、恢复和回归验收

**文件：**

- 新建：`server/tests/auto-listing-ai-channel-pool-journey.test.mjs`
- 新建：`server/tests/auto-listing-ai-channel-pool-postgres.integration.test.mjs`
- 修改：`server/tests/auto-listing-ai-runtime-composition.test.mjs`
- 修改：`server/tests/auto-listing-ai-workflow-journey.test.mjs`
- 修改：`app/tests/auto-listing-task-center.browser.test.mjs`
- 新建：`docs/superpowers/verification/2026-08-28-auto-listing-ai-channel-pool.md`

- [ ] **步骤 1：写完整 journey 测试**

假网关使用两个真正独立的受控 handler，记录每个通道同时调用数、阶段、request id 和释放时间。覆盖：

1. 一通道两商品：最大并发 1，第二件显示等待；第一件 AI 完成后第二件开始，不等待第一件 Ozon upload 完成；
2. 两通道三商品：最大并发 2，前两件不同通道，第三件等待；
3. 同一商品 plan、rich、各 image/checker 任何时刻最多一个收费请求；
4. 第一通道确定性连接失败，第二通道空闲时自动切换；已接受的图片不重新生成；
5. 两通道都忙/冷却时持续等待，释放后自动继续，Outbox attempts 不因等待增加；
6. 第一次 `POSSIBLY_SENT` 自动重试，第二次进入 `AUTO_LISTING_AI_RESULT_UNCERTAIN`；
7. 5 分钟无有效事件触发 idle watchdog；持续合法事件不触发；
8. Worker 在调用中断，lease 过期后另一 Worker 接管相同 fixed product；
9. 后序商品 AI 可完成，但上传领取不能越过前序商品；
10. v2 legacy job 能排空；所有连接版本式新 job 只进入 v3，环境变量式旧 profile 继续进入受限 v2 路径。

运行：

```bash
node --test \
  server/tests/auto-listing-ai-channel-pool-journey.test.mjs \
  server/tests/auto-listing-ai-channel-pool-postgres.integration.test.mjs
```

预期：在实现完整前失败；完成后全部通过。

- [ ] **步骤 2：回归非目标功能**

```bash
node --test \
  server/tests/auto-listing-ai-settings-e2e.test.mjs \
  server/tests/auto-listing-ai-workflow-journey.test.mjs \
  server/tests/auto-listing-category-strategy-service.test.mjs \
  server/tests/auto-listing-category-strategy-routes.test.mjs \
  server/tests/auto-listing-upload-task-worker.test.mjs \
  server/tests/auto-listing-upload-service.test.mjs \
  app/tests/auto-listing-task-center.browser.test.mjs
```

预期：全部通过，尤其类目策略仍调用主配置且不申请 channel lease。

- [ ] **步骤 3：运行项目级验证**

```bash
pnpm run db:migrate
pnpm run build
pnpm run verify
git diff --check
```

预期：迁移、构建和验证通过；`git diff --check` 无空白错误。若 `verify` 因缺少真实外部凭据跳过外部测试，验证记录必须逐项列出跳过范围。

- [ ] **步骤 4：用本地页面做无真实副作用验收**

启动现有本地服务，以测试连接和安全上传模式验证：

```text
AI 模型配置 -> 看到主通道 1 -> 增加/启停测试通道
自动上架创建两商品 -> 一通道时第二件显示等待
启用第二测试通道 -> 第二件自动开始
模拟第一通道无响应 -> 显示切换并恢复
任务进入 upload queue -> 后序不越过前序提交
```

不点击或触发真实 Ozon 外部写入。记录页面截图、测试数据 ID、数据库迁移号和未执行的真实调用范围到验证文档。

- [ ] **步骤 5：写验证记录**

`docs/superpowers/verification/2026-08-28-auto-listing-ai-channel-pool.md` 必须列出：

- 实际执行命令与退出码；
- 一通道和两测试通道的最大观测并发；
- 故障切换、无通道等待、lease 接管、上传顺序的证据；
- 类目策略、人工审核、主配置读取的回归结果；
- 未执行的真实 Sub2API 双 Key 和真实 Ozon 写入，以及原因；
- 回滚：停用附加通道恢复单通道容量；代码回滚但不删除迁移/证据数据。

- [ ] **步骤 6：提交验收测试与记录**

```bash
git add server/tests/auto-listing-ai-channel-pool-journey.test.mjs \
  server/tests/auto-listing-ai-channel-pool-postgres.integration.test.mjs \
  server/tests/auto-listing-ai-runtime-composition.test.mjs \
  server/tests/auto-listing-ai-workflow-journey.test.mjs \
  app/tests/auto-listing-task-center.browser.test.mjs \
  docs/superpowers/verification/2026-08-28-auto-listing-ai-channel-pool.md
git commit -m "test: verify auto-listing AI channel capacity"
```

---

## 最终完成标准

- 一个健康通道下两件商品严格一件占用 AI 容量，第二件稳定显示等待并自动续跑。
- 两个独立测试通道下最多同时两件商品；第三件不失败、不增加等待尝试数。
- 同一商品所有收费阶段串行且优先固定通道；故障切换后不重复已接受资产。
- 无有效响应 5 分钟会释放执行权；持续有效事件不受总时长限制。
- `POSSIBLY_SENT` 只自动恢复一次，第二次给出准确可人工重试错误。
- Worker/relay 崩溃通过持久租约恢复，不产生双重有效执行者。
- AI 生成并行后，Ozon 上传仍按 `source_order`，且上传不占 AI 通道。
- 页面只展示安全通道名和业务状态；数据库、日志、队列、DTO 不泄露 Key。
- 类目策略、主配置、人工审核、定价、库存、幂等上传和账号隔离回归通过。
- 缺少第二个真实独立 Key 时，只能声明双通道测试网关通过，不能声明真实上游双通道已验收。
