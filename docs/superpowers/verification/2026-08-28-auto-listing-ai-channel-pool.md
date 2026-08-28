# 自动上架 AI 独立通道池最终验证

## 结论

Task 11 的本地无费用验收通过：两个真正独立的受控假网关、一次性 PostgreSQL 16 和真实前端页面共同覆盖了计划中的 10 个容量、恢复、顺序和兼容场景。单通道最大观测并发为 1，双通道最大观测并发为 2，同一商品跨 plan、image generation、checker 和 rich content 的最大收费调用并发为 1。等待不会增加 Outbox 尝试数，确定性连接失败会切换通道且不会重新生成已接受主图，5 分钟 idle watchdog、两次不确定结果升级、租约接管、上传顺序和 v2/v3 隔离均通过。

这不是“真实上游双通道已验收”。没有提供或使用两个真实 Sub2API Key，没有触发真实付费 AI，没有调用真实 Ozon 商品、库存或富内容写接口，也没有对生产数据库执行迁移。浏览器页面只使用受控 mock API；一次性数据库在 loopback Docker 容器中运行并在验收后删除。

## 十个验收场景

| 场景 | 代表性证据 | 结果 |
| --- | --- | --- |
| 1. 一通道两商品 | PostgreSQL 同一账号只启用 channel A；第一件持有 lease 时第二件投影为 `WAITING_FOR_AI_CHANNEL`，`attempts=0`、`dispatch_generation=0`；第一件进入 `UPLOAD_QUEUED` 后、其 upload task 尚为 `PENDING` 时第二件已取得 AI lease | PASS，通道最大并发 1 |
| 2. 两通道三商品 | A/B 分别领取前两件，第三件无 claim；释放 A 后第三件继续 | PASS，最大有效通道 lease 2 |
| 3. 同商品收费阶段串行 | 两个独立 handler 共享按 item 计数器；plan、逐图 generate、逐图 checker、rich content 均逐次释放 | PASS，同一商品最大并发 1 |
| 4. 故障切换和资产复用 | A 对 `detail-2` 返回确定性 `NOT_SENT` 网络失败，B 重试成功；在 B 重放已接受 `main-1` 时 handler 调用数不增加 | PASS |
| 5. 无可用通道等待 | 两个 lease 都占用时第三件不失败、无 claim、尝试数仍为 0；释放后自动继续 | PASS |
| 6. 不确定结果边界 | 第一次 `POSSIBLY_SENT` 得到 `REQUEUED`、计数 1；另一通道第二次后进入 `RETRYABLE_ERROR`，错误码 `AUTO_LISTING_AI_RESULT_UNCERTAIN`、计数 2 | PASS |
| 7. 5 分钟 idle | 注释/残缺 frame 不重置 300000 ms watchdog 并得到 `AI_GATEWAY_IDLE_TIMEOUT`；合法完整 progress event 重置计时，599998 ms 总时长仍成功 | PASS |
| 8. Worker 接管 | 同一 fixed item 的 outbox/channel lease 同时过期后，替代 Worker 以同一 item、同一 channel、`dispatch_generation=2` 接管；后序 item 未被误领 | PASS |
| 9. 上传不越序 | 后序商品可先到 `UPLOAD_QUEUED`，但前序为 `UPLOADING` 时不能领取；前序 `SUCCEEDED` 后才能领取 | PASS |
| 10. v2/v3 兼容 | connected profile 只由 v3 claim；环境变量式 legacy profile 只由受限 v2 claim；plain legacy job 可由 v2 排空，连接版本式 work envelope 在 v2 被拒绝 | PASS |

## 自动化命令和结果

所有 Node 命令使用工作区已有的固定 Node 运行时；测试数据库 URL 指向一次性 loopback 容器，文档不保留其临时凭据。

| 命令 | 退出码与结果 |
| --- | --- |
| `node --test server/tests/auto-listing-ai-channel-pool-journey.test.mjs server/tests/auto-listing-ai-channel-pool-postgres.integration.test.mjs`（写测试前） | exit 1：两个文件均不存在，Task 11 RED |
| `node --test server/tests/auto-listing-ai-channel-pool-journey.test.mjs` | exit 0：3/3，0 skipped |
| `AUTO_LISTING_POSTGRES_TESTS=1 SONLI_MIGRATION_TEST_DATABASE_URL=<disposable> node --test --test-concurrency=1 server/tests/auto-listing-ai-channel-pool-postgres.integration.test.mjs` | exit 0：6/6，0 skipped |
| 上述 journey/PG 加 `auto-listing-ai-runtime-composition`、`auto-listing-ai-workflow-journey` | exit 0：23/23，0 skipped |
| 不设置 PostgreSQL gate 运行 PG 文件 | 0 pass、6 explicit skip；只证明 guard，不把 skip 记为通过 |
| 不确定结果 mutation：临时把升级阈值从 2 改为 3，运行 case 6 | exit 1：实际保持 `REQUEUED`、计数 2，与预期 `RETRYABLE_ERROR` 不同；恢复生产阈值后 1/1 PASS |
| 计划列出的 6 个服务端非目标回归 | exit 0：70/70，0 skipped |
| 计划列出的完整非目标回归（含浏览器，沙箱外受控 Chrome） | exit 0：72/72，0 skipped |
| `AUTO_LISTING_CONFIGURABLE_SKELETON_PG_TESTS=1 ... auto-listing-configurable-skeleton-e2e.test.mjs` | RED 暴露 guarded fixture 漂移；经逐项授权的 test-only contract 更新后 exit 0：6/6，0 skipped；未改生产代码 |
| 类目策略真实组合 PostgreSQL E2E | exit 0：真实 route/runtime 组合通过，未调用生产外部服务 |
| `node --test --test-concurrency=1 server/tests/auto-listing-runtime-worker.test.mjs server/tests/auto-listing-web-runtime.test.mjs` | mandatory execution repository/v3 queue 和 archive publication port 的 stale fixture 更新后 exit 0：38/38，0 skipped；未改生产代码 |
| `pnpm run db:migrate`（一次性 PostgreSQL） | exit 0：98 条迁移，最新 `098_auto_listing_ai_channel_pool` |
| `pnpm run build` | exit 0：4851 modules；仅有既存的 >500 kB chunk 提示 |
| `pnpm run verify` | 标准环境 exit 1；详见“项目级验证边界”，不把阻塞项称为通过 |
| `git diff --check` | exit 0，无空白错误 |

### 项目级验证边界

标准 `pnpm run verify` 的应用构建、开发入口、扩展 zip、一致性 smoke、插件就绪、安全扫描等阶段执行；最终命令仍因环境和非 Task 11 基线门禁返回 1：

- 三个上游扩展 parity 阶段要求 `QH_SOURCE_EXTENSION_DIR`；标准环境未设置，明确返回 environment blocked。
- Docker compose 插值缺少必需部署环境；最终标准命令首先报告 `MINIO_ACCESS_KEY` 未设置。
- 桌面 parser 缺少已声明但当前 `node_modules` 未安装的 `cheerio`。
- 桌面沙箱内 Playwright/Chrome 启动为 `SIGABRT`；计划内同一浏览器回归在沙箱外原命令 72/72 通过。
- 与迁移 098、mandatory execution repository/v3 queue 和 archive publication port 相关的 stale fixture 均在逐项授权后做了 test-only 更新；迁移聚焦测试和 runtime/category 隔离回归 38/38 通过。

最终活动套件统计为 3852 total、3748 pass、21 fail、83 explicit skip；完整 verifier 共 5 个 check 非零。21 个失败全部可归入环境门禁：19 个测试在 Chrome 启动阶段即失败、1 个 desktop parser 缺少已声明的 `cheerio` 安装、1 个 UI parity 测试缺少 `QH_SOURCE_EXTENSION_DIR`。没有剩余的 runtime/category 行为失败。

因此本记录只声明 Task 11 聚焦验收、计划内非目标回归、构建和一次性迁移通过，不声明当前机器的完整 `pnpm run verify` 通过，也不把任何 skip 计为通过。

## 浏览器验收

使用 ego-browser 独立 task space、真实本地 Vite 页面和页面启动前注入的封闭 fetch fixture。所有非 localhost 请求均 fail closed；验收结束后 task space 和 Vite 均关闭。

- `EGO-TASK11-TASK-CENTER-001`：账号 `account-task11`，任务 `job-task11-safe-fixture`，商品 `item-calling`、`item-waiting`、`item-switching`。页面实际显示“正在使用「主通道 1」生成”“等待可用 AI 通道”“原通道暂不可用，正在等待其他通道”，对应 60%、15%、30%。请求仅有本地受控 `/api/local/state`、`/api/auto-listing/preferences`、`/api/auto-listing/jobs`、`/api/admin/auto-listing/upload-policies`；`externalRequests=[]`，`secretsVisible=false`。
- `EGO-TASK11-AI-SETTINGS-002`：页面显示“主通道 1”和“测试通道 B”，通过受控本地 POST `/api/admin/auto-listing/ai-settings/profiles/profile-task11/versions/1/channels/channel-test/status` 启用测试通道，刷新后两者均显示“可用”，toast 为“独立通道已启用”；`externalRequests=[]`，`secretsVisible=false`。

截图：

- [任务中心等待与切换](assets/2026-08-28-auto-listing-ai-channel-pool-task-center.png)
- [AI 配置启用反馈](assets/2026-08-28-auto-listing-ai-channel-pool-settings.png)

浏览器没有点击真实能力测试、真实审核上传、DIRECT 上架、库存写入、取消或重试动作。

## 回归与数据安全

- 类目策略 service/routes 继续读取主配置，不申请 channel lease；计划内回归通过。
- 人工审核路径仍在 `READY_FOR_REVIEW` 停止；受控 fixed-skeleton PostgreSQL 验证 6、8、13 张配置均不产生 Ozon 写入。
- runtime composition 明确断言 v2/v3 队列和 worker options 的精确映射。
- workflow journey 对每个业务 Outbox message 断言只有 V1 业务载荷，不含 execution、`apiKey`、Authorization、Bearer 或 ciphertext。
- 定价、库存、幂等上传、账号隔离由计划列出的上传 service/worker、settings 和类目策略回归覆盖；72/72 全部通过。
- 数据库公开 schema 的迁移登记为 `98 | 098_auto_listing_ai_channel_pool`；未读取或复制真实账号、商品、密钥或上游响应。

## 未执行范围

1. 两个真实独立 Sub2API Key 和真实上游双通道并发；原因是无费用、安全验收禁止真实付费调用。
2. 真实 Ozon 商品、图片、富内容、库存或价格写入；原因是本任务没有外部写授权。
3. 生产数据库迁移和生产数据恢复；只使用 disposable PostgreSQL 16。
4. 真实 Worker/进程被操作系统 kill 的进程级演练；租约过期与接管使用真实 PostgreSQL 状态和两个逻辑 owner 验证。

## 回滚与恢复

- 容量异常时先在管理员配置中停用附加通道，恢复单通道容量；已有业务 Outbox 和证据继续保留。
- 代码可回滚 Task 11 测试/展示记录及前序实现提交，但迁移 098、通道版本、lease 和审计证据不得通过删表或删除历史数据回滚。
- 若迁移 098 已在某环境应用，回退应用前先停止 AI worker/relay；恢复兼容版本后再逐步启用主通道。需要 schema 变化时使用新的 forward-only 迁移。
- 本次 disposable 容器删除后无持久数据需要恢复；没有外部调用需要补偿。
