# 自动上架来源快照合同版本设计

## 目标

修复店铺原生币种升级后，同一采集商品因沿用旧 `sourceVersion` 而触发 `AUTO_LISTING_SOURCE_VERSION_CONFLICT` 的问题。

验收标准：

- 旧 RUB 失败任务和来源快照保持原样，仍可追溯。
- 同一采集商品可使用新版币种合同创建新的不可变来源快照。
- CNY 店铺缺少显式来源币种时，新快照记录 `CNY` 与 `TARGET_STORE`。
- 明确 RUB 来源与 CNY 店铺不一致时，新任务生成可审计的 `AUTO_LISTING_SOURCE_CURRENCY_MISMATCH` 阻断项。
- 相同新版请求重试继续复用同一来源版本和业务幂等标识，不产生重复任务或外部副作用。
- 修复过程不调用真实 Ozon、付费 AI 或生产外部服务。

## 根因

`sourceVersion` 当前由 product draft 版本和原始 payload 身份组成，例如 `draft:7:payload-hash`。币种升级改变了来源快照的规范化内容和失败码语义，却没有把“来源快照合同版本”纳入该版本身份。

数据库唯一约束 `(account_id, source_type, source_record_id, source_version)` 正确地禁止“同一来源版本对应不同快照内容”。因此新版 CNY 快照与已存在的旧 RUB 快照发生冲突并回滚整个任务事务。

## 方案

在来源读取边界引入稳定的快照合同版本，例如 `AUTO_LISTING_SOURCE_SNAPSHOT_V2`。来源版本由“底层业务版本 + 原始 payload 身份 + 快照合同版本”共同组成，而不是只表达底层业务身份。

示意：

```text
旧版本：draft:7:payload-hash
新版本：draft:7:payload-hash:AUTO_LISTING_SOURCE_SNAPSHOT_V2
```

合同版本只在规范化输出语义发生不兼容变化时升级。相同底稿和相同合同版本始终得到相同 `sourceVersion`，保持重试确定性。

## 组件边界

### 来源仓储

- Collect Box 与 Excel 来源读取统一生成版本化 `sourceVersion`。
- product draft 版本、payload hash、`productDraftId`、`productDraftVersion` 和原始响应证据继续保留；合同后缀只补充规范化语义身份，不替代业务来源身份。
- 不修改历史来源快照，不迁移或删除旧行。

### 来源快照与任务服务

- 继续把 `sourceVersion` 当作不透明、稳定的来源身份。
- 快照哈希仍覆盖完整规范化内容。
- 业务失败项、成功项、事件与审计继续引用同一个新版 `sourceVersion`。

### PostgreSQL

- 保留现有唯一约束与冲突检测，不新增破坏性迁移。
- 旧版本和新版合同版本可作为两个不同的不可变来源版本并存。
- 相同新版版本但内容不同仍返回 `AUTO_LISTING_SOURCE_VERSION_CONFLICT`。

### 前端错误信息

- 根因修复后，正常重试不再产生版本冲突。
- 同时把 `AUTO_LISTING_SOURCE_VERSION_CONFLICT` 加入稳定安全错误映射，若未来再次出现，页面明确提示“来源资料版本已变化，请刷新后重试”，而不是通用内部错误。
- 错误响应不包含原始快照、凭据或数据库内容。

## 数据流

1. 后端按账号和采集商品读取当前 product draft。
2. 仓储用 product draft 身份和固定快照合同版本生成新版 `sourceVersion`。
3. 服务按目标店铺币种构造来源快照或阻断证据。
4. 仓储在同一事务中写入新版来源快照、任务、任务项、事件和定价底稿。
5. 若已有完全相同的新版来源快照则安全复用；若同版本内容不同则继续失败关闭。

## 测试策略

- 单元 RED：Collect Box 与 Excel 当前仍返回未版本化 `sourceVersion`。
- 仓储 RED：预置同商品旧 RUB 快照后，新版 CNY 任务应创建新快照，而不是版本冲突或覆盖旧行。
- 服务回归：CNY 成功、RUB/CNY 不一致阻断、unsupported currency 拒绝、同新版重试幂等。
- 路由回归：来源版本冲突返回固定 409、安全中文信息和 correlation ID。
- 真实临时 PostgreSQL：旧行与新版行并存，旧哈希不变，新 CNY 任务事务完整提交。
- 页面验收：刷新后创建任务不再显示通用错误；不启动真实商品导入、库存写入或付费 AI。

## 回滚与恢复

- 应用回滚时可恢复旧来源版本生成逻辑，但这会再次阻止相同历史商品创建新币种任务，因此只作为临时止血。
- 已写入的新版来源快照和任务必须保留，不删除、不降级、不改写。
- 恢复时重新发布版本化来源身份逻辑，使用原业务幂等键重试。

## 不采用的方案

- 删除或覆盖旧快照：破坏审计和可追溯性。
- 放宽唯一约束：允许同一来源版本对应不同业务事实，破坏幂等与证据完整性。
- 用快照哈希直接组成 `sourceVersion`：快照本身包含 `sourceVersion`，会形成循环身份，并把合同升级责任隐藏在内容哈希中。
