# 自动上架校验边界精简实施计划

> **For agentic workers:** Execute each task with test-driven development and verify the affected end-to-end path before completion.

**Goal:** 修复会误伤正常自动上架任务的冲突、重复和过严校验，让可信内部数据只在正确边界验证一次。

**Architecture:** 不新增服务、框架或通用策略层。沿用现有工作流、图片检查器、富内容服务和仓储，只调整规则归属与汇总条件。安全与 Ozon 外部写入边界保持不变。

**Tech Stack:** Node.js ESM、`node:test`、PostgreSQL JSONB、现有自动上架工作流。

**Spec:** `docs/superpowers/specs/2026-08-27-auto-listing-validation-boundary-design.md`

## Global Constraints

- 保留用户现有未提交修改，不重置、不覆盖无关文件。
- 先写失败测试并确认失败原因，再最小修改生产代码。
- 不降低账号/店铺隔离、金额/库存、哈希/对象键、主图/最低图数、违禁内容、Ozon contract 与幂等检查。
- 不为没有真实故障证据的理论场景增加新规则或抽象。

## Task 1：统一可选图片跳过与最低可用图片规则

**Files:**

- Modify: `server/tests/auto-listing-ai-workflow-postgres.test.mjs`
- Modify: `server/auto-listing-ai-workflow-postgres.mjs`

- [x] 将“8 个槽位中 2 个可选槽位跳过、仍有主图和 6 张合格图”的测试改为期望继续进入富内容。
- [x] 运行该测试并确认旧汇总条件导致失败。
- [x] 删除“所有槽位必须全部 ACCEPTED”的冲突条件，保留全部槽位终态、每组 6–13 张和主图要求。
- [x] 增加少于 6 张或缺少主图仍阻断的回归断言。

## Task 2：统一 V6 表现类人工复核证据

**Files:**

- Modify: `server/tests/auto-listing-rich-content-repository.test.mjs`
- Modify: `server/auto-listing-rich-content-repository.mjs`

- [x] 让第 1 次尝试的 V6 已验收软警告测试期望可预约富内容。
- [x] 确认旧的 `attemptNo === 3` 条件导致测试失败。
- [x] 删除尝试次数限制；旧模板或硬失败仍拒绝。
- [x] 验证内存与 PostgreSQL 仓储前置 contract 一致。

## Task 3：让富内容策略识别冻结事实

**Files:**

- Modify: `server/tests/auto-listing-rich-content.test.mjs`
- Modify: `server/auto-listing-rich-content.mjs`

- [x] 新增有事实依据的“包装内包含”与拉丁商品词通过测试。
- [x] 新增无事实依据的包装宣称、礼品/赠品和现有禁止内容继续失败测试。
- [x] 将高风险硬禁止规则与可由事实证明的包装表述分开；拉丁词只从当前块引用事实加入允许集合。
- [x] 统一模型输出规范化和最终文档验证使用同一事实感知函数。

## Task 4：收紧重复校验到结构与不可变证据

**Files:**

- Modify: `server/tests/auto-listing-rich-content-repository.test.mjs`
- Modify: `server/auto-listing-rich-content-repository.mjs`
- Modify only if required: PostgreSQL migration and migration contract tests

- [x] 用已验收 V6 证据复现下游旧规则漂移，不允许伪造状态、范围、哈希或对象键。
- [x] 下游不重新执行图片语义判断，只验证验收证据完整、一致且绑定当前任务。
- [x] 若数据库约束仍重复语义判断，以向后兼容迁移同步收窄；否则不新增迁移。

## Task 5：将 Ozon 可选富内容能力改为非阻断

**Files:**

- Modify: `server/tests/auto-listing-listing-base-preparer.test.mjs`
- Modify: `server/tests/auto-listing-overlay.test.mjs`
- Modify: `server/auto-listing-listing-base-preparer.mjs`
- Modify: `server/auto-listing-overlay.mjs`

- [x] 类目没有属性 11254 时冻结 `richContentAttributeSupported=false`，不阻断基础商品。
- [x] 上传覆盖层继续验证图片、价格、范围和已有富内容证据，但只在类目支持时写入 11254。
- [x] 不支持时删除历史富内容字段并保留普通上架 payload。

## Task 6：回归与代表性流程验证

- [x] 运行图片工作流、图片生成、富内容、仓储、overlay、上传服务和 worker 定向测试。
- [x] 使用已有数据库记录验证至少一个 V6 软警告证据与一个跳过可选槽位的汇总形态。
- [x] 只报告实际运行结果；无法触发真实 Ozon 外部写入时明确标注。
