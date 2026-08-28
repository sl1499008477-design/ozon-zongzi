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

## 独立审查修复

### 审查 RED

- 在 `fe287dc3c93298dad06fa19f83f488de713f2203` 上新增 never-closing SSE、重复 named `[DONE]` 和严格 Retry-After 公开 adapter 探针。
- 聚焦运行共 `9` 项：`0` 通过、`9` 失败。完整成功及 model-not-found/401/403/404/429 JSON 终态全部仍等待物理 EOF；两个 named `[DONE]` 将 idle timer 的设置次数从 `1` 增到 `3`；缺失 Retry-After 暴露 `null` 而非默认 `60_000`。

### 审查 GREEN

- SSE 每解析一个完整 JSON data frame 后立即检查终态。完整 `response.completed` 立即返回，完整 failure event 立即按既有安全 classifier 抛错；两条路径均取消未结束 reader，并由外层清除 timer/listener，不再等待 TCP EOF。
- 所有 `data: [DONE]` 无论 event name 都只作为非 JSON 控制标记忽略，绝不调用 `progress()`，也不会合成成功或失败业务事件。
- Retry-After 只接受非负十进制安全整数秒或严格、规范化的 IMF-fixdate；不再让宽松 `Date.parse` 解释其他文本。缺失、负数、小数、带符号、垃圾、非规范日期及溢出值均安全回退到 `60_000`，合法值仍限制在 24 小时，合法过去日期为 `0`。
- 聚焦修复探针：`9/9` 通过；adapter/gateway boundary：`130/130` 通过；brief 四文件组合：`185/185` 通过；四 caller：`256/256` 通过；Task 6 orchestrator/worker：`55/55` 通过。Task 8 的 11 个 `.mjs` 再次逐一通过 `node --check`，`git diff --check` 退出码为 `0`。

## 第二轮终审修复

### 终审 RED

- 在 `767c29d097a8fdfadafe78dc735f33460b3f7b3c` 上新增公开 adapter 探针，使用 HTTP 200、never-closing SSE 的完整 terminal JSON frame 覆盖 429 的 `Retry-After: 120`、缺失、非法、超过 24 小时，以及非 429 terminal 携带恶意 header。
- 聚焦运行共 `6` 项：非 429 安全隔离用例通过，其余四个 429 子用例及父用例失败（`1` 通过、`5` 失败）；429 都已立即取消 reader 且为 `NOT_SENT`，但 immutable `retryAfterMs` 错误地提前固定为 `null`。

### 终审 GREEN

- 进入增量 SSE reader 前只调用一次既有严格 `safeRetryAfter(response)`；该安全值显式传入即时 terminal classifier 和 EOF 兼容 classifier。
- 只有 429 terminal 把解析值附加到 immutable metadata：整数 `120` 为 `120_000`，缺失/非法为 `60_000`，超长合法秒数 cap 为 `86_400_000`。非 429 terminal 即使携带恶意 header，`retryAfterMs` 仍为 `null`，错误 message/JSON 不包含 header 内容。
- 200 SSE terminal 仍在完整 JSON frame 后立即 settle、cancel never-closing reader、清 timer，并保持明确拒绝的 `NOT_SENT`；没有新增重试或外部副作用。
- 聚焦终审探针：`6/6` 通过；adapter/gateway boundary：`136/136` 通过；brief 四文件组合：`191/191` 通过；四 caller：`256/256` 通过；Task 6 orchestrator/worker：`55/55` 通过。Task 8 的 11 个 `.mjs` 逐一通过 `node --check`，`git diff --check` 退出码为 `0`。

## 第三轮终审修复

### 终审 RED

- 在 `ba736f669f4c7a4b7ab89726bdd20753cd289c21` 上扩展公开 `testCapabilities` 探针，覆盖 2xx 后 completion persistence ambiguity、2xx image decode、本地 model evidence、完全 prefetch invalid、首子调用成功后次子调用明确 401/fence，以及 caller abort。
- 聚焦运行 `8` 项：完全 prefetch、caller abort、既有 model-evidence POSSIBLY guard 和 fetch 前 terminal-write 用例通过；2xx completion ambiguity、后续明确 401、后续 prefetch fence、2xx image decode 四项失败（`4` 通过、`4` 失败），均被 public catch 错误默认成 `NOT_SENT`。

### 终审 GREEN

- compound capability call 使用不可由 public caller 注入的内部 symbol tracker；每个子调用先记录是否已有先前 fetch，每个实际 fetch 只在首次 `onFetchStart` 处把调用级 `anyStarted` 线性化为真。
- public catch 对无精确 metadata 的错误按 `anyStarted` 选择 `NOT_SENT/POSSIBLY_SENT`；已有 `POSSIBLY_SENT` 原样保留；已有 `NOT_SENT` 仅在当前子调用之前已经发生过 fetch 时，以相同安全 code/status/requestId/retryAfter 重新构造为整体 `POSSIBLY_SENT`。
- 因此完全 prefetch invalid 和 fetch 前 caller abort 仍为 `NOT_SENT` 且保留原错误码；首子请求即明确拒绝仍可精确 `NOT_SENT`；但任一先前 probe 已发送后，后续本地错误或明确拒绝都不会宣称整个 compound 操作可安全整体重试。
- 聚焦终审探针：`8/8` 通过；adapter/gateway boundary：`138/138` 通过；brief 四文件组合：`193/193` 通过；四 caller：`256/256` 通过；Task 6 orchestrator/worker：`55/55` 通过。Task 8 的 11 个 `.mjs` 逐一通过 `node --check`，`git diff --check` 退出码为 `0`。

## 第四轮终审修复

### 终审 RED

- 在 `ebd98ffad28282170e8d0530da996f8476436902` 上新增 OpenAI Images 复合调用探针。主生成 POST 成功后，二次 URL 下载分别返回 401/403/404/429、network failure 和不可解析图片；聚焦运行 `7` 项时 `2` 通过、`5` 失败，四个明确 HTTP 拒绝错误都错误保留了下载级 `NOT_SENT`。
- 新增四个 never-settling persistence 探针，分别卡住 `markCapabilitySubcallSending`、provider-rejected completion、provider-accepted completion 和 pre-send failure completion。聚焦运行 `5` 项时 `0` 通过、`5` 失败：总 timeout 或 caller abort 后操作仍等待持久化 promise。

### 终审 GREEN

- OpenAI Images 的 URL 下载只会发生在主生成 POST 已成功返回之后；下载阶段任意错误现在以明确 prior-send 语义重构为整体 `POSSIBLY_SENT`。重构只保留既有安全 `code/status/requestId/retryAfterMs`，所以 401/403/404/429、network 和 parse failure 都不会把整个付费操作误报为可安全重试；429 的严格 Retry-After 仍保持不变。
- 对 adapter 内所有 fetch 序列做了静态审计：能力测试的 reachability/text/image 多 probe 已由不可注入的 compound tracker 覆盖；OpenAI Images 的主 POST→URL GET 是此次修复的另一条真实多-fetch 复合操作；catalog sync 是单请求，`fetchWithBoundary` 的 redirect 循环是同一请求边界且既有 delivery classification 不变。没有发现其他需要升级整体投递状态的多-fetch 序列。
- 四个 capability persistence 写入均通过专用 abort-aware await。abort 会立即移除本次 listener 并返回；底层 promise 的迟到 resolve/reject 会被消费，不会二次改变结果或形成 unhandled rejection。SENDING persistence 一旦启动就不会被 catch 错误终结为 PREPARED failure。
- caller abort/总 timeout 的错误码优先于 capability-result-unknown：fetch 前仍为 `NOT_SENT`，fetch 已开始后的 completion ambiguity 为 `POSSIBLY_SENT`。非 abort 的持久化不确定性继续使用既有 `AI_GATEWAY_CAPABILITY_RESULT_UNKNOWN` guard，没有内联重试或吞错。
- 聚焦 Images 探针：`7/7` 通过；聚焦 persistence 探针：`5/5` 通过；adapter/gateway boundary：`150/150` 通过；brief 四文件组合：`205/205` 通过；四 caller：`256/256` 通过；Task 6 orchestrator/worker：`55/55` 通过。Task 8 的 11 个 `.mjs` 逐一通过 `node --check`。

### 未验证、风险与回滚补充

- 未连接真实 Sub2API/Ozon、真实长连接、生产存储或生产数据库；never-settling/late-settling 行为由受控 promise、受控 stream 和注入 timer 验证。
- 剩余风险集中在外部 provider 对成功生成后临时图片 URL 的非标准行为；适配器会保留安全错误分类，但因主 POST 已发生，不再允许整体自动安全重试。回滚本轮可单独 revert 第四轮终审修复提交；无需数据库恢复，回滚前应先停止新 worker intake 并允许在途付费调用到达 guard 边界。
