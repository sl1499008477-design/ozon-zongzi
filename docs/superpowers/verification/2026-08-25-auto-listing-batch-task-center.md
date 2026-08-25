# 自动上架批次任务中心验证

## 结论

验证基线为提交 `6a6e876` 的隔离归档，不使用共享工作树中的未提交业务改动掩盖结果。聚焦后端测试、前端测试和 Vite 生产构建通过；mock API 浏览器测试及正式本地页面只读检查均没有触发付费 AI 或 Ozon 写入。

当前结论为 **仍有未验证范围**：集成测试第 280 行的 `.attempts` / `.attemptCount` 字段错配已在 `32941d6` 修复并经复审 Approve，不再是当前代码阻断项；但一次性 PostgreSQL URL 仍未提供，真实数据库并发套件没有运行，所以数据库级验收仍未完成。现有应用数据库也尚未应用迁移 088，不能代替一次性测试库或验证新字段投影。

## 修改批次与提交

- Task 1（迁移）：`6907525`、`f4ba113`
- Task 2（倍率 contract、精确定价与持久化）：`df01126`、`e4f3e44`
- Task 3（顺序保存、任务投影）：`e385452`、`327d1bb`
- Task 4（同批次领取门禁与并发测试）：`352e305`、`4d41342`、`8358498`、`1294be0`；后续测试字段修复：`32941d6`
- Task 5（前端纯函数投影）：`d615be8`、`047c587`
- Task 6（任务中心 UI 与轮询）：`95e3709`、`6a6e876`

## 数据库

迁移 088 是附加迁移：为 `auto_listing_job_items` 增加并确定性回填一基 `source_order`，设置非空、正数约束及同账号/批次唯一索引；为 `auto_listing_preferences` 增加默认 `1000000` 的正数 `price_multiplier_micros`。它不修改来源快照、任务状态或上传数据。

- `SONLI_MIGRATION_TEST_DATABASE_URL` 未设置。严格按约束没有使用普通应用数据库代替，也没有运行迁移或数据库并发集成套件。
- `32941d6` 只把 guarded 集成测试的重领次数断言从 `.attempts` 改为 DTO 的 `.attemptCount`，复审结论为 Approve；没有修改领取业务代码。
- 现有应用数据库只在配置的管理员账号边界内以 `BEGIN READ ONLY` 开始、以 `ROLLBACK` 结束；没有更新、清洗、删除或迁移。
- 只读 schema 检查结果：`088_auto_listing_batch_order_multiplier` 未登记，`source_order` 和 `price_multiplier_micros` 列均不存在。
- 因 schema 未应用 088，简报中的新字段投影 SQL 无法执行；没有通过改写数据库规避此限制。

## 核心结果

- 同批次逐件领取、稳定失败后放行、重试门禁和不同批次并行：聚焦后端单元/SQL contract 测试覆盖并通过；真实 PostgreSQL 并发执行未验证。
- 倍率：测试覆盖默认倍率 1、六位小数 micros、先加减后乘倍率、整数 half-up 舍入、历史缺失倍率兼容及金额边界，均通过。
- 顺序与任务中心：mock API 浏览器测试验证 URL/提交顺序一致、倍率默认与提交值、创建后切换任务中心、图片失败占位、进度、总用时及 3 秒轮询停止条件；没有真实创建任务。
- 七个筛选器的纯函数映射通过。自动化浏览器只点击并断言“上架失败”；正式本地页面只读检查已逐项切换全部七个筛选器。
- `autoListingTaskDuration` 在页面调用点传入显式显示时钟；helper 自身仍以 `Date.now()` 作为缺省参数，属于确定性方面的已知次要风险。

## 测试与执行时间

所有提交级命令均在 `git archive 6a6e876` 的隔离目录中执行，并复用已有依赖；未安装依赖。

| 验证 | 命令 | 结果 | 大致用时 |
| --- | --- | --- | ---: |
| 聚焦后端 | `node --test server/tests/auto-listing-batch-order-multiplier-migration.test.mjs server/tests/auto-listing-contract.test.mjs server/tests/auto-listing-pricing.test.mjs server/tests/auto-listing-preferences-postgres.test.mjs server/tests/auto-listing-service.test.mjs server/tests/auto-listing-repository.test.mjs server/tests/auto-listing-ai-outbox-postgres.test.mjs server/tests/auto-listing-routes.test.mjs server/tests/auto-listing-view.test.mjs server/tests/auto-listing-overlay.test.mjs` | PASS，231/231，0 skipped | 0.34 秒 |
| 一次性 PostgreSQL | `AUTO_LISTING_POSTGRES_TESTS=1 SONLI_MIGRATION_TEST_DATABASE_URL=... node --test --test-concurrency=1 server/tests/auto-listing-batch-order-postgres.integration.test.mjs` | 未运行：专用 URL 缺失；普通应用 DB 未代替 | — |
| 字段修复后的 guarded test | 无专用 URL 环境下运行 `node --test --test-concurrency=1 server/tests/auto-listing-batch-order-postgres.integration.test.mjs` | 0 pass、1 explicit skip；只证明 guard 生效，不证明 PostgreSQL 并发行为 | 0.08 秒 |
| 字段修复后的 Outbox 单测 | `node --test server/tests/auto-listing-ai-outbox-postgres.test.mjs` | PASS，14/14，0 skipped | 0.08 秒 |
| 前端 | `node --test app/tests/auto-listing-config.test.mjs app/tests/auto-listing-view.test.mjs app/tests/auto-listing-page-contract.test.mjs app/tests/auto-listing-task-center.browser.test.mjs` | 沙箱内 Chrome 启动 `SIGABRT`；沙箱外原命令重跑 PASS，61/61，0 skipped | 7.58 秒 |
| 生产构建 | `pnpm --dir app build` | PASS，4850 modules；有既存的大 chunk 警告 | 5.74 秒 |
| 现有 DB 只读检查 | Node/pg 连接后执行 `BEGIN READ ONLY`、账号范围 schema/状态/投影统计、`ROLLBACK` | 连接成功，只输出状态类别和数量 | 每次约 0.2 秒 |

构建说明：运行时的 pnpm 默认依赖状态检查会尝试自动安装并因无 TTY 中止。为遵守“不安装依赖”，最终使用现有 `node_modules`、设置 bundled Node 到 `PATH` 并关闭 `verify-deps-before-run` 后运行同一 `pnpm --dir app build` 脚本。

## 代表性数据

现有应用数据库的配置管理员账号范围共有 63 个自动上架商品项。仅记录类别与数量：

- 上架成功：1
- 生成失败：39
- 上架失败：2
- 等待审核：0
- 历史无倍率配置：63；带新倍率配置：0
- 至少两件商品的批次：0
- 最近 20 条旧 schema 来源投影：标题 20、SKU 20、缩略图 20

因此成功、生成失败和上架失败类别有代表性只读数据；等待审核、新倍率任务、多商品批次与一基顺序投影没有现有数据/schema 证据，明确记为未验证。没有复制账号 ID、标题、SKU、图片 URL、密钥或其他敏感业务内容。

## 浏览器与副作用边界

- 自动化浏览器用 1280×900 viewport 和 mock API 验证创建流程及任务中心，不访问付费 AI/Ozon。
- 控制器先确认旧 5173 服务是与 AI Worker 无父子托管关系的独立过期 Vite；仅精确替换该 Vite 后，正式 3000 地址加载最新界面，持续运行的 AI Worker 未停止。
- 正式本地页面登录态正常。创建页只读确认来源按缩略图、标题、SKU、ID 列表展示，倍率默认 1，店铺、仓库、库存和售价控件对齐。
- 任务中心只读确认独立页签和七个筛选器（全部、处理中、待审核、生成失败、上架失败、上架成功、已取消）均可切换；表头包含商品、任务进度、上架店铺、任务用时、创建时间和操作。现有成功项显示 100% 与总用时，失败项显示阶段进度与“未上架”用时。
- 由于应用库没有迁移 088，历史任务缺少新的来源投影；页面正确回退到来源 ID 与“图片不可用”，没有崩溃。
- 未在真实本地页面点击创建、审核、上传、重试或取消，也没有产生数据库、AI 或 Ozon 写操作。
- 窄屏仅由页面 contract/CSS 测试覆盖，未执行窄 viewport 浏览器验收。

## 后续修复与未验证范围

1. **原 Task 4 字段错配已修复**：`32941d6` 已将 `server/tests/auto-listing-batch-order-postgres.integration.test.mjs:280` 的 `.attempts` 改为仓储 DTO 的 `.attemptCount`，并经复审 Approve。无专用 URL 时 guarded test 为 1 explicit skip，Outbox 单测 14/14 通过；由于未在专用一次性数据库执行，该修复不能替代同批次串行、失败放行、重试门禁与跨批次并行的真实 PostgreSQL 验收。
2. 生产迁移 088 未执行、未验证；现有应用库也未应用 088。
3. 同批次数据库级串行、失败放行、重试门禁和跨批次并行未在真实 PostgreSQL 执行。
4. 付费 AI、真实 Ozon 上传/提交、生产写入均未执行。
5. 没有真实数据库中的等待审核、新倍率任务、多商品批次代表性数据。
6. 自动化浏览器没有逐个点击七个筛选器，但正式页面只读验收已逐项切换；窄 viewport 仍未实测。
7. helper 的缺省 `Date.now()` 保留；当前页面显式传入时钟，未观察到套件失败。

不得据此宣称真实 Ozon 上架、生产迁移或数据库并发已经验证。

## 回滚与恢复

- 代码按 Tasks 6 → 1 的反向提交顺序回滚，具体批次见上方提交列表。
- 数据库新增字段为附加字段；回滚应用代码时保留 `source_order` 与 `price_multiplier_micros`，不执行删除列、删除约束或改写历史数据的破坏性降级。
- 若顺序门禁在线上异常，先停止相关 Worker、回滚 Task 4 代码并调查；不在运行中的失败逻辑上继续叠加补丁。
- 本轮没有数据库写入，因此不需要数据恢复。
