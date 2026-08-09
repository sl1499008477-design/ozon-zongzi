# sub2API OAuth 图片模型证据解析设计

## 背景

本地 sub2API 已将两个 OpenAI OAuth 账号识别为 ChatGPT Go，账号均为启用、可调度状态。2026-08-09 22:21 与 22:26 的两次能力测试中，连通性、文字生成和图片生成三个付费子调用都被上游接受并完成，但最终均被 Ozon 粽子判定为 `AI_GATEWAY_MODEL_MISMATCH`。

当前 OAuth 图片链路通过 Responses API 使用 `gpt-5.4` 作为外层编排模型，并在 `image_generation` 工具中请求管理员选择的图片模型（当前为 `gpt-image-2`）。第一轮修复只排除了与 `response.model` 完全相同的 `image_generation_call.model`，但 2026-08-09 23:34 至 23:36 的三次新测试仍在成功出图后被判定为 `AI_GATEWAY_MODEL_MISMATCH`。

数据库证据显示三次测试的连通性、文字和图片子调用均为 `PROVIDER_ACCEPTED`，sub2API 用量记录也确认外层 `gpt-5.4` 请求成功并生成一张 2K 图片。失败发生在图片响应读取完成后的本地模型一致性校验，而不是 OAuth、ChatGPT Go、Key、调度或图片生成阶段。

进一步核对 Responses API contract 后确认：标准 `image_generation_call` 输出只保证 `id`、`result`、`status` 和 `type`，不提供可作为图片后端身份证明的 `model` 字段；响应中的 `tools` 是工具配置，不是上游实际图片后端的证明。sub2API 兼容层可能在这些非标准位置填入外层编排模型或内部路由名称。将这些字段当作图片模型证明既会误报，也会对网关没有承诺的字段建立错误 contract。

## 目标

1. 区分 Responses 图片链路中的编排模型证据和图片工具模型证据。
2. 不把 `gpt-5.4` 编排模型误判为图片模型不一致。
3. 只对协议中有稳定、明确语义的模型字段执行模型一致性校验。
4. 不伪造网关未提供的图片模型证据。
5. 保持租户、密钥、付费确认、幂等、审计和模型选择 contract 不变。

## 非目标

- 不修改 sub2API、OpenAI OAuth 账号或套餐。
- 不新增模型别名映射。
- 不把 `gpt-5.4` 注册为图片模型。
- 不放宽独立 Images API 等具有明确模型回报语义的协议校验。
- 不执行真实 AI、真实图片生成或 Ozon 调用。

## 方案选择

采用按协议 contract 区分的严格解析：

- `response.completed.response.model` 始终作为外层编排模型。
- 对 `SUB2API_RESPONSES` 图片工具协议，`response.tools[].model`、`image_generation_call.model` 和未被该协议文档定义的 `response.image_model` 都不作为图片后端模型证明，也不参与 `AI_GATEWAY_MODEL_MISMATCH` 判断。
- Responses 图片结果继续记录管理员请求的 `requestedImageModel`、外层 `orchestratorModel`、成功生成与解码证据；`gatewayReportedImageModel` 为空且 `gatewayReportedImageModelPresent=false`。
- 这表示能力测试证明“所选配置通过该网关成功完成图片能力调用”，不表示网关已证明实际使用的内部图片后端名称。
- `SUB2API_OPENAI_IMAGES` 等直接图片协议仍按其稳定响应字段执行精确模型一致性校验，明确冲突继续失败关闭。
- 将来只有在 sub2API 或上游发布稳定、可引用的图片后端证明字段后，才能通过版本化 contract 和测试将该字段加入证据集合。

拒绝以下替代方案：

1. 把 `gpt-5.4` 当作 `gpt-image-2` 的别名：会掩盖真实路由错误。
2. 全局关闭模型一致性校验：会错误放宽具有明确模型回报语义的直接图片协议。
3. 继续猜测非标准字段的含义或做模型别名/前缀匹配：无法区分编排模型、内部路由名和真实图片后端。

## 组件与数据流

只修改 `server/sub2api-ai-adapter.mjs` 的 Responses 图片流解析和其相邻测试。

1. 解析 SSE 或非流式 JSON，要求完整终态与可解码图片结果。
2. 从 `response.model` 保留外层编排模型。
3. Responses 图片工具不再从 `tools`、输出项或未定义扩展字段推断图片后端模型。
4. 直接 Images 协议继续把其稳定模型字段交给现有一致性验证。
5. 生成结果继续返回现有 `modelEvidence`：
   - `requestedImageModel`
   - `gatewayReportedImageModel`
   - `gatewayReportedImageModelPresent`
   - `orchestratorModel`

不增加前端字段，不修改数据库，不新增迁移。

## 错误与安全边界

- 直接 Images 协议明确回报的图片模型与配置不一致：`AI_GATEWAY_MODEL_MISMATCH`，不可重试。
- Responses 图片工具的非标准模型字段不得升级为身份依据或错误依据。
- 编排模型字段只能作为编排证据，不能证明图片模型。
- 没有明确图片模型字段时，不显示或持久化虚构的图片模型名。
- 现有响应大小、图片解码、SSE 终态、重定向、DNS、超时和付费子调用预约边界保持不变。
- 日志仍不得包含提示词、图片、Authorization、OAuth 令牌、API Key 或原始响应。

## 验收测试

必须先观察失败再实现：

1. OAuth SSE 返回 `response.model=gpt-5.4`，并在 `response.tools` 或 `image_generation_call` 的非标准 `model` 字段重复/变形报告编排模型，请求图片模型为 `gpt-image-2`：图片成功，编排模型为 `gpt-5.4`，图片模型回报证据为空。
2. 非流式 JSON Responses 返回相同非标准字段组合：行为与 SSE 一致。
3. Responses 响应携带未定义的 `image_model` 或输出项模型：不得据此声称实际图片后端已验证，也不得误报模型不一致。
4. 直接 Images 协议明确回报错误模型：仍失败 `AI_GATEWAY_MODEL_MISMATCH`；匹配或缺失证据保持现有行为。
5. 能力测试成功结果保留请求模型、编排模型、图片生成与真实解码证据，且 `gatewayReportedImageModelPresent=false`。
6. 现有图片解码、付费预约/幂等、超时、DNS、日志脱敏和相邻设置流程回归全部通过。

## 回滚

实现提交可通过单独 `git revert` 回滚。该变更不修改数据库、配置或外部账号，因此无需数据恢复。回滚后旧的 `AI_GATEWAY_MODEL_MISMATCH` 行为会恢复。
