# sub2API OAuth 图片流兼容设计

## 背景与证据

本地 sub2API 的连接检查、模型同步和文字能力测试均已成功。最新一次图片能力请求也被网关和上游接受，但上游只返回文字输出，应用最终显示 `INVALID_GATEWAY_RESPONSE`。现有适配器只接受 `response.output_item.done.item.result` 或 `response.completed.response.output[].result`，并明确拒绝 sub2API OAuth 图片桥实际可能使用的 `response.image_generation_call.partial_image.partial_image_b64` 流式事件。

同时，当前配置把已选文字模型同时用作 Responses 图片工具的外层编排模型。已确认的本地 sub2API OAuth 兼容路径优先使用 `gpt-5.4` 作为外层模型，再由 `image_generation` 工具调用已选图片模型。现有推荐规则没有表达这一兼容提示，因此管理员容易继续选中 `gpt-5.5`。

## 目标

1. 在不放宽失败边界的前提下，接受完整成功响应中的最终流式图片快照。
2. 当目录同时包含 `gpt-5.4` 和 OpenAI 图片模型时，把 `gpt-5.4` 提升为文字模型的 OAuth 图片编排兼容候选。
3. 保持推荐为“未验证”：管理员仍需确认文字模型和图片模型，并明确授权一次可能收费的能力测试。
4. 不修改历史失败配置、历史能力测试、付费审计或 provider 幂等证据。

## 方案选择

### 采用：严格流式解析 + 版本化推荐提示

- 适配器继续使用 `/v1/responses`、`stream: true`、`tool_choice: "auto"` 和现有 `image_generation` 工具声明。
- 解析器接受 `response.image_generation_call.partial_image`，但只在同一响应最终出现成功的 `response.completed` 后使用最后一个合法快照。
- 若存在正式 `image_generation_call.result`，正式结果优先于 partial 快照。
- 推荐规则升级为 V2。只有目录同时出现精确 `gpt-5.4` 与 `gpt-image-*` 候选时，才增加可解释的 OAuth 图片编排兼容提示和分数。
- V1 历史目录仍可读取；V2 新目录按新规则严格校验。

这是最小且可追溯的方案：不隐式改写管理员选择，也不在请求发送时把已冻结的文字模型替换成另一模型。

### 未采用：适配器静默把任意文字模型替换成 `gpt-5.4`

该方案会让配置页显示的文字模型与真实图片请求使用的编排模型不一致，破坏模型冻结、审计和幂等证据。

### 未采用：把 partial 图片无条件视为成功

partial 事件可能在失败或中断前出现。缺少成功终态时接受图片会把不完整响应误记为能力通过。

## 适配器合同

### 可接受事件

`response.image_generation_call.partial_image` 必须满足：

- `partial_image_b64` 是非空字符串；
- `partial_image_index` 是非负安全整数；
- 同一响应中的索引严格递增，重复或倒退均返回 `INVALID_GATEWAY_RESPONSE`；
- 整个 SSE 仍受现有总字节、总时间、终止和错误事件边界约束；
- 最终必须出现 `response.completed` 且状态为 completed；
- 最终选择的 Base64 必须通过现有严格解码、图片字节上限、PNG/JPEG 尺寸和格式校验。

若响应同时含正式 final result 和 partial 快照，使用正式 final result。失败、不完整、错误或只有 `[DONE]` 而没有成功完成事件时，继续 fail closed。

### 安全与可观测性

- 不记录原始 SSE、Base64 图片、提示词、Authorization 或网关 Key。
- 对外只返回现有稳定安全错误码。
- model evidence 继续记录请求图片模型、网关报告图片模型和外层编排模型；不伪造上游未报告的图片模型。

## 推荐合同

新规则版本为 `AUTO_LISTING_MODEL_RECOMMENDATION_V2`。

- 新增固定 reason code：`SUB2API_OAUTH_IMAGE_ORCHESTRATOR_HINT`。
- 该提示只适用于精确模型 ID `gpt-5.4`，且同一目录必须存在至少一个 `gpt-image-*` 图片候选。
- 提示只增加推荐排序分数，不把 `verified` 改为 true，不跳过收费能力测试，也不阻止管理员选择其他模型。
- 前端同时接受并严格复算 V1、V2；未知规则版本、未知 reason、分数不一致、非规范排序或重复候选继续拒绝。
- 页面把新 reason 显示为“OAuth 图片编排兼容提示（待验证）”。

## 数据流

1. 管理员执行模型同步，服务端保存不可变目录及 V2 推荐结果。
2. 配置页把 `gpt-5.4` 置于文字候选前部，同时继续标记“待验证”。
3. 管理员确认 `gpt-5.4` 与 `gpt-image-1`/`gpt-image-2`，保存为新的 disabled 配置版本。
4. 管理员勾选费用确认并执行一次能力测试。
5. 图片阶段读取受限 SSE；若正式 final result 缺失但存在合法 partial 快照且响应成功完成，则使用最后快照进行既有图片解码与能力验证。
6. 只有文字、图片生成和图片解码三项均通过时，配置才可发布。

## 测试与验收

所有开发测试均使用 fake SSE，不调用真实 sub2API、真实 AI 或 Ozon：

- RED：合法 partial 快照 + `response.completed` 当前被拒绝；实现后应成功。
- 多个严格递增 partial 快照选择最后一个。
- final result 与 partial 同时存在时 final result 优先。
- 缺少 completed、失败终态、空 Base64、非法索引、重复/倒退索引、超限图片继续拒绝。
- V2 在 `gpt-5.4` + `gpt-image-*` 共存时提高 `gpt-5.4` 排名，仍为未验证。
- 没有图片候选时不增加兼容提示。
- V1 历史目录和 V2 新目录均通过前端严格校验；未知版本和伪造分数失败关闭。
- 运行适配器、推荐、模型同步、设置 client/view/page 相邻回归、生产构建和完整 verify。

## 部署与人工验收

代码验证通过后重启本地 API/Web/worker。随后由管理员在页面中手工：

1. 立即同步模型；
2. 新建配置版本，文字模型选 `gpt-5.4`，图片模型选 `gpt-image-1` 或 `gpt-image-2`；
3. 保存选择；
4. 明确确认费用后只执行一次真实能力测试。

最后一步可能产生真实费用，开发和自动化验证阶段绝不代替管理员点击。

## 回滚

代码回滚只需 revert 本次实现提交。数据库没有迁移或数据改写；已保存的 V2 目录为不可变历史，旧代码若不认识 V2 会安全拒绝而不是误用。恢复服务后重新同步即可生成旧规则目录。历史能力测试和审计记录不得删除或覆盖。
