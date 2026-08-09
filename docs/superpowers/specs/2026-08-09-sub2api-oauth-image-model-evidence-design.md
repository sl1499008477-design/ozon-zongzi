# sub2API OAuth 图片模型证据解析设计

## 背景

本地 sub2API 已将两个 OpenAI OAuth 账号识别为 ChatGPT Go，账号均为启用、可调度状态。2026-08-09 22:21 与 22:26 的两次能力测试中，连通性、文字生成和图片生成三个付费子调用都被上游接受并完成，但最终均被 Ozon 粽子判定为 `AI_GATEWAY_MODEL_MISMATCH`。

当前 OAuth 图片链路通过 Responses API 使用 `gpt-5.4` 作为外层编排模型，并在 `image_generation` 工具中请求管理员选择的图片模型（当前为 `gpt-image-2`）。sub2API 的流式响应可能在 `response.output_item.done.item.model` 中重复报告外层编排模型。现有适配器将该字段无条件当作图片模型证据，因而错误地把 `gpt-5.4` 与 `gpt-image-2` 比较并拒绝已经成功生成的图片。

## 目标

1. 区分 Responses 图片链路中的编排模型证据和图片工具模型证据。
2. 不把 `gpt-5.4` 编排模型误判为图片模型不一致。
3. 当网关明确报告了不同的图片工具模型时，继续以 `AI_GATEWAY_MODEL_MISMATCH` 失败关闭。
4. 不伪造网关未提供的图片模型证据。
5. 保持租户、密钥、付费确认、幂等、审计和模型选择 contract 不变。

## 非目标

- 不修改 sub2API、OpenAI OAuth 账号或套餐。
- 不新增模型别名映射。
- 不把 `gpt-5.4` 注册为图片模型。
- 不关闭图片模型一致性校验。
- 不执行真实 AI、真实图片生成或 Ozon 调用。

## 方案选择

采用来源感知的严格解析：

- `response.completed.response.model` 始终作为外层编排模型。
- `response.image_model` 和 `response.tools[].model` 中属于 `image_generation` 工具的字段，作为明确图片模型证据。
- `image_generation_call` 输出项上的 `model` 若与已确认的编排模型相同，归入编排证据，不进入图片模型比较。
- `image_generation_call` 输出项上的 `model` 若与请求的图片模型相同，作为图片模型证据。
- `image_generation_call` 输出项上的 `model` 若既不等于编排模型，也不等于请求的图片模型，作为明确冲突并失败关闭。
- 如果响应完成且图片可解码，但没有明确图片模型证据，则保留 `gatewayReportedImageModelPresent=false`；不把请求值伪装成网关回报值。

拒绝以下替代方案：

1. 把 `gpt-5.4` 当作 `gpt-image-2` 的别名：会掩盖真实路由错误。
2. 关闭模型一致性校验：会允许管理员选择与实际生成模型不一致。

## 组件与数据流

只修改 `server/sub2api-ai-adapter.mjs` 的 Responses 图片流解析和其相邻测试。

1. 解析 SSE 事件并保留模型字段的来源。
2. 在收到 `response.completed` 后确定外层编排模型。
3. 将输出项模型按“编排、明确图片、冲突”分类。
4. 只把明确图片模型集合交给现有一致性验证。
5. 生成结果继续返回现有 `modelEvidence`：
   - `requestedImageModel`
   - `gatewayReportedImageModel`
   - `gatewayReportedImageModelPresent`
   - `orchestratorModel`

不增加前端字段，不修改数据库，不新增迁移。

## 错误与安全边界

- 明确图片模型与配置不一致：`AI_GATEWAY_MODEL_MISMATCH`，不可重试。
- 多个明确图片模型互相冲突：`AI_GATEWAY_MODEL_MISMATCH`，不可重试。
- 编排模型字段只能作为编排证据，不能证明图片模型。
- 没有明确图片模型字段时，不显示或持久化虚构的图片模型名。
- 现有响应大小、图片解码、SSE 终态、重定向、DNS、超时和付费子调用预约边界保持不变。
- 日志仍不得包含提示词、图片、Authorization、OAuth 令牌、API Key 或原始响应。

## 验收测试

必须先观察失败再实现：

1. OAuth 流返回 `response.model=gpt-5.4`，且 `image_generation_call.item.model=gpt-5.4`，请求图片模型为 `gpt-image-2`：图片成功，编排模型为 `gpt-5.4`，图片模型回报证据为空。
2. 输出项明确回报 `gpt-image-2`：成功，并记录明确图片模型证据。
3. `response.image_model` 或图片工具明确回报 `gpt-image-1`：失败 `AI_GATEWAY_MODEL_MISMATCH`。
4. 同一响应同时包含匹配与冲突的明确图片模型：失败 `AI_GATEWAY_MODEL_MISMATCH`。
5. 现有非 OAuth 图片接口、图片解码、付费能力测试、超时和安全回归全部通过。

## 回滚

实现提交可通过单独 `git revert` 回滚。该变更不修改数据库、配置或外部账号，因此无需数据恢复。回滚后旧的 `AI_GATEWAY_MODEL_MISMATCH` 行为会恢复。
