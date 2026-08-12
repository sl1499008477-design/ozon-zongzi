# 自动上架类目交接与最新任务列表设计

日期：2026-08-12

## 目标

1. 创建自动上架任务时，复用已为当前店铺匹配并验证成功的 Ozon 目标类目，不再把已有类目误判为缺失。
2. 普通任务列表对同一“采集商品 + 上架店铺”只展示最新一条任务，同时继续保留数据库中的全部历史任务与审计记录。
3. 在任务表格中明确显示任务创建时间，帮助用户识别最新记录。

## 已确认根因

采集和类目解析链路已经保存了两类数据：

- 商品草稿中的源类目证据，例如源类目名称、属性和源 description category；
- `collect_category_resolutions` 中按账号、采集商品和目标店铺验证后的目标 Ozon 类目结果。

当前故障商品的类目解析状态为 `MATCHED`，目标 description category ID、type ID 和绑定店铺均已写入数据库。但自动上架 `loadCollectSources()` 只读取商品草稿和原始采集数据，没有读取已匹配的目标类目结果，因此商品草稿中的空 `descriptionCategoryId` / `typeId` 被当成真实缺失。

这是读取路径未接通，不是采集接口未取得类目，也不是类目结果未存数据库。

## 设计决策

### 1. 类目结果按当前店铺精确交接

创建采集箱自动上架任务时，服务层把已经校验过的 `targetStoreId` 传给来源仓储：

```js
loadCollectSources({ accountId, collectItemIds, targetStoreId })
```

仓储读取商品草稿时，同时读取当前默认 taxonomy scope 下的类目解析记录。只有同时满足以下条件才可交接：

- `resolution.account_id === accountId`；
- `resolution.collect_item_id === collectItem.id`；
- `resolution.status === "MATCHED"`；
- `resolution.credential_store_id === targetStoreId`；
- `target_description_category_id` 和 `target_type_id` 均为正整数；
- 记录属于允许的 Ozon taxonomy scope；
- 不接受跨账号、跨商品、跨店铺、待处理、失败或不完整记录。

仓储在返回给自动上架服务的 `collectItem.listingDraft` 副本中叠加本次任务所需的目标类目视图：

```js
{
  descriptionCategoryId,
  typeId,
  categoryResolution: {
    status: "MATCHED",
    method,
    taxonomyScope,
    target: {
      storeId: targetStoreId,
      descriptionCategoryId,
      typeId,
      ancestorCategoryIds,
    },
    displayPath,
    validatedAt,
  },
}
```

这个视图只进入本次不可变自动上架来源快照，不回写 `product_drafts`。这样不会把某一家店铺的目标类目写成所有店铺共用的商品事实。

### 2. 服务层先锁定目标店铺，再加载来源

当前服务先加载来源、后校验目标店铺。为了让来源读取安全绑定店铺，创建流程调整为：

1. 校验请求与幂等重放；
2. 加载并验证目标店铺；
3. 以 `accountId + collectItemIds + targetStoreId` 加载来源；
4. 继续执行现有仓库、策略、上传策略、RFBS 只读验证和原子建图。

目标店铺的账号、状态和币种校验仍由后端完成。来源仓储不会信任未经服务层验证的客户端店铺字段。

如果当前店铺没有精确、完整的 `MATCHED` 类目记录，仍创建可审计的阻断任务，稳定失败码继续是 `AUTO_LISTING_SOURCE_CATEGORY_REQUIRED`；用户可见文案改为“缺少当前店铺可用的 Ozon 类目资料”。

### 3. 最新任务仅是列表投影，不删除历史记录

数据库继续保存每次创建的任务、商品项、来源快照和事件。普通列表在安全 DTO 之后按以下键分组：

```text
sourceRecordId + targetStoreId
```

每组只返回最新一条商品任务。最新顺序使用：

1. `job.createdAt` 降序；
2. `job.jobId` 降序作为稳定平局规则；
3. 同一任务内继续使用现有商品项顺序。

不同店铺互不覆盖；同一商品上架到两个店铺时，每个店铺各显示自己的最新记录。

为避免“先取 50 条历史任务再去重”导致最新不同商品被旧历史挤出，去重应在 PostgreSQL 查询边界完成，再应用 `limit`。单条任务详情接口仍可按任务 ID 读取任意历史记录，审计和恢复链路不变。

### 4. 创建时间合同与页面展示

任务列表行需要同时携带：

- `jobId`；
- `jobCreatedAt`；
- 现有 `itemId`、`sourceRecordId`、`targetStoreId`、状态和安全失败码。

`jobCreatedAt` 必须来自任务表 `auto_listing_jobs.created_at`，不能用商品项更新时间冒充。

页面新增“创建时间”列，按当前本地时区格式化；无法解析时显示 `—`。任务编号不新增独立可见列，避免表格拥挤，但保留在行数据与详情接口中用于排查。

### 5. 安全错误映射

前端把 `AUTO_LISTING_SOURCE_CATEGORY_REQUIRED` 固定映射为：

```text
缺少当前店铺可用的 Ozon 类目资料
```

不得显示数据库字段、原始类目响应或任意后端异常文本。其他错误码合同不变。

## 数据与权限边界

- 所有类目读取必须同时带账号、采集商品和店铺边界。
- 不新增数据库迁移；复用已有 `collect_category_resolutions`。
- 不修改或删除历史任务、来源快照、类目解析记录和审计事件。
- 不在创建任务阶段调用 Ozon 写接口；RFBS 仍只允许现有只读仓库验证。
- 不启动付费 AI，不触发真实商品导入或库存修改。
- 金额、币种、仓库、幂等键和 correlation ID 现有合同不变。

## 测试与验收

### 类目交接

- 精确同账号、同商品、同店铺的 `MATCHED` 结果能生成完整自动上架来源快照。
- 跨账号、跨商品、跨店铺、非 `MATCHED`、缺 description category 或缺 type ID 的记录不能复用。
- 商品草稿原始 JSON 不被更新；自动上架新快照包含交接后的目标类目。
- 当前真实故障场景在一次性 PostgreSQL + fake Ozon 测试中可以创建非阻断任务。

### 最新列表

- 同一商品同一店铺存在多条历史任务时，只返回最新一条。
- 同一商品不同店铺时，每个店铺各返回最新一条。
- 多商品历史超过列表上限时，先按分组取最新、再应用 limit。
- 历史数据库行数不变，按任务 ID 仍可读取旧任务。

### 页面

- 表格显示任务实际创建时间。
- 列表只出现每个商品/店铺的最新记录。
- 类目缺失使用固定安全中文，不回显后端原始文本。

## 回滚与恢复

如需回滚，revert 应用代码和测试提交即可；不得删除历史任务或类目解析记录。该变更不新增迁移，不需要数据库回退。回滚后列表会恢复显示全部历史记录，自动上架也会恢复旧的草稿-only 类目读取行为。
