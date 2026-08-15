# Task 9 brief — 创建任务前的精确类目策略门禁与继续创建

## 业务目标

- 当账号模式为 `REQUIRE_EXACT_STRATEGY` 时，创建自动上架任务必须先读取当前来源类目身份、授权当前来源版本、读取账号模式，并命中当前已发布账号策略中的同账号精确规则。
- 缺少精确规则时固定返回 `AUTO_LISTING_CATEGORY_STRATEGY_REQUIRED`（409），且类目租约、商品底稿准备、任务图、AI/outbox、对象存储和商品写入全部为零。
- 管理员发布策略后，原表单可以用新的 idempotency key 再次提交；后端重新读取当前来源、策略、店铺、仓库、币种和图片数量配置，不信任旧弹窗状态。
- 正式任务冻结当次通过复核的 `strategyVersionId` 与每项 `ruleId`；发布、来源类目或店铺/仓库事实竞态只能原子成功或零任务失败。

## 精确规则

- 精确身份固定为 `accountId + OZON:DEFAULT + descriptionCategoryId + typeId`。
- `EXACT_CATEGORY_TYPE_V2` 必须三字段完全一致。
- 既有 `EXACT_CATEGORY` V1 只有在持久规则本身还保存了完全一致的 taxonomy/type 身份时才可满足门禁；仅 categoryId 的旧规则、ancestor、product-style 与 default 均不能满足。
- `LEGACY_FALLBACK` 保持旧解析顺序与 `BALANCED_DEFAULT` 行为。
- 同账号不同店铺共享策略，但每次任务仍冻结自己的店铺、仓库、币种、库存、价格调整和 requested image counts。

## 安全公共错误

- public details 只允许 `{ scope, status, canManage, draftId? }`。
- `scope` 只含 taxonomy/category/type；`draftId` 只在当前账号存在该 exact 草稿且 actor 拥有 `AI_CONTENT_MANAGE` 时返回。
- 不返回 accountId、URL、object key、actor/admin、raw response、内部规则或发布证据。
- 请求、依赖结果和错误投影继续执行 proxy-first、descriptor-safe、exact-key、bounded closed DTO；跨账号载体在任何策略/任务副作用前拒绝。

## 文件范围

计划中的六个文件：

- `server/auto-listing-service.mjs`
- `server/auto-listing-runtime.mjs`
- `server/auto-listing-routes.mjs`
- `server/tests/auto-listing-service.test.mjs`
- `server/tests/auto-listing-runtime-worker.test.mjs`
- `server/tests/auto-listing-routes.test.mjs`

必要邻接修订：

- `server/auto-listing-repository.mjs`：增加账号模式/同账号草稿只读契约，完整投影 V2 与具备 exact type identity 的 V1，并在既有 `createJobGraph` 事务内复核模式、发布版本和精确规则。没有迁移、没有新增表、没有外部 API。
- 邻接仓储证明优先放入计划已有的 `server/tests/auto-listing-service.test.mjs`，避免扩大测试文件集合；若真实 PostgreSQL 证明不能在该文件安全表达，再单独记录最小测试边界。

## TDD / 验收矩阵

1. RED：strict + missing exact 返回稳定 409；preparer/category lease/create graph/paid AI/object/outbox/product write 全为零。
2. flag off/legacy 继续创建并保持 `BALANCED_DEFAULT`。
3. strict + V2 exact 成功；strict + 具备完整 type identity 的 V1 exact 成功。
4. ancestor/default/category-only V1 均返回 required。
5. 发布后用新 key 继续创建，重新读取并冻结当前发布 version/rule；后续发布不改变已建任务。
6. source/category/publish/store/warehouse/currency/requestedCounts 变化在最终复核时零任务失败。
7. 同账号两店共享策略，但 graph 的 store/warehouse/currency/config 不串。
8. 相同 create key replay 仍只创建一个 job；缺策略失败不占用 job idempotency key。
9. 普通用户不见 draftId；管理员只见同账号 exact draftId；hostile/extra/proxy/accessor 数据零执行、零泄漏。
10. 路由只投影固定安全 details；runtime 未提前启动 AI worker 或外部服务。

## 外部边界

- 不调用真实 Ozon、真实/付费 AI、真实对象存储、生产数据库或平台写接口。
- 本任务无数据库迁移；回滚为撤销本任务应用代码，保留 Task 1–8 的不可变策略、样本与分析证据。
