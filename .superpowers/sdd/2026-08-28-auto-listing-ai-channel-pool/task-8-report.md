# Task 8 报告：自动上架 AI 空闲看门狗与安全投递状态

## 范围与基线

- 基线：`a502186a05c145c4539fab58c80fd90eb8f6cd0c`
- 分支：`codex/auto-listing-ai-channel-pool`
- 按 brief 修改适配器、两个适配器边界测试和四个自动上架 caller。
- 为严格 RED/GREEN，经 `/root` 明确批准，将四个 caller 的现有直接测试加入范围；没有修改 Task 7 exact routing 或后续任务。
- 没有数据库迁移，没有真实 AI/Ozon 请求，没有部署、push 或生产数据库操作。

## 实现结果与公开 contract

- 适配器接受二选一的 `timeoutMs` 或 `idleTimeoutMs`；同时传入或超出 `1..600_000` 会在 fetch 前以 `AI_GATEWAY_REQUEST_INVALID`、`deliveryState=NOT_SENT` 失败。
- 管理员模型同步/能力测试继续使用总 `timeoutMs`；四个自动上架付费 caller 只传 `idleTimeoutMs: 300_000`，不传 `timeoutMs`。
- idle 看门狗只在完整 JSON body 成功解析，或完整 SSE `data:` frame 成功解析为 JSON 对象时重置。字节噪声、SSE 注释/keepalive、`[DONE]`、半 frame 都不会重置。
- SSE 改为增量解析；已消费 frame 会从工作 buffer 移除，同时保留既有总响应字节上限。正常结束、reader 异常、parser 异常、caller abort、idle/total timeout 均清理 timer、caller listener 和未完成 reader。
- caller abort 在竞态分类中优先，保持 `GATEWAY_CANCELLED`；管理员总超时保持 `GATEWAY_TIMEOUT`；空闲超时为 `AI_GATEWAY_IDLE_TIMEOUT`。
- 适配器错误只公开不可写的安全字段 `deliveryState` 和 `retryAfterMs`：
  - fetch 前：`NOT_SENT`；
  - fetch 后网络失败、unexpected EOF、5xx、成功响应解析失败：`POSSIBLY_SENT`；
  - 401/403/404、显式 model reject、429：`NOT_SENT`；
  - 429 的 `Retry-After` 仅接受安全整数秒或可解析 HTTP 日期，最大 24 小时；不会暴露原始 header 或 body。
- 没有在适配器内重试或吞错；业务 400 仍是普通 `NON_RETRYABLE_GATEWAY`，不会伪装成 404/model revalidation 信号。

## TDD 证据

### RED

- 新增 8 个适配器/边界行为测试后运行 adapter 与 boundary：`8` 项失败、`0` 项通过；失败点分别为 idle timer、有效 frame 重置、噪声不重置、caller abort 优先、互斥参数、deliveryState、Retry-After、DNS/fetch 边界。
- 新增显式 streamed `model_not_found` 测试后单独运行：`1` 项失败、`0` 项通过；当时仍返回旧的 terminal failure 分类。
- 四个 caller 直接测试先加入 `idleTimeoutMs` 断言后均观察到失败（image 共用 fixture 使多个用例同步暴露缺失字段），再修改生产 caller。

### GREEN 与回归

- Task 8 adapter/boundary：`121/121` 通过。
- brief 指定组合（adapter、gateway boundary、Task 6 orchestrator、Task 6 worker）：`176/176` 通过。
- 四个 caller 直接回归：`256/256` 通过，覆盖已有取消/lease guard contract 以及新的 idle-only 参数 contract。
- Task 6 orchestrator/worker 单独回归：`55/55` 通过。
- 11 个变更 `.mjs` 文件逐一运行 `node --check`，全部退出码 `0`。
- `git diff --check`：退出码 `0`。

## 未验证、风险与回滚

- 未连接真实 Sub2API/Ozon，也未用真实网络长连接等待五分钟；时间推进通过可注入 timer 和受控 stream 验证。
- 未运行无边界的全仓测试；回归范围按 Task 8 brief、四个直接 caller 和 Task 6 closed classifier/worker/orchestrator 边界确定。
- 主要回归风险在第三方 SSE 的非标准分帧：实现保留无尾随空行但完整、可解析 final frame 的兼容行为；不完整 JSON 明确按 unexpected EOF 处理。
- 回滚无需数据库恢复。停止新的自动上架 worker intake 后，revert 本 Task 8 独立提交即可恢复旧超时/解析行为；已在途的外部请求应先等待结束或由 caller 取消。
