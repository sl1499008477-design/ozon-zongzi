# 扩展买家页读取失败后的 Seller 安全回退设计

## 背景与根因

Ozon 商品详情页的数据面板会调用 `searchVariants` 补充类目、品牌、重量和包装尺寸。扩展先尝试借当前 `www.ozon.ru` 买家商品页跨域读取 Seller 接口；如果这条快速通道失败，再回退到已登录的 `seller.ozon.ru` 页面执行同一读取。

当前实现把同一个 `preferTabId` 同时用于两种不同语义：

- 买家商品页的“优先尝试标签”；
- 后台采集任务已冻结的“Seller 身份标签”。

快速通道失败后，买家商品页编号被交给只接受 Seller 页的严格校验。校验因此返回 `SELLER_CONTEXT_CHANGED`，阻止正常回退。页面仍能从公开页面读取 SKU、评分和部分类目，但 `searchVariants` 被拒绝，最终显示“部分商品数据加载失败”，重量和尺寸显示“暂无数据”。

## 目标与验收标准

1. 用户在 Ozon 买家商品页打开数据面板时，跨域快速读取失败后自动改用可信、已登录的 Seller 页面。
2. 后台任务已经冻结 Seller 身份快照时，只能继续使用该快照中的 Seller 标签；标签失效或跳离可信 Seller 地址时继续返回 `SELLER_CONTEXT_CHANGED`。
3. 不允许因为回退而跨店铺、跨账号读取，也不接受页面传入的公司编号作为可信身份。
4. 没有可用 Seller 页面时沿用现有明确错误，不循环打开、刷新或关闭用户页面。
5. 不修改数据库、后端 API、Collector 会话、采集箱归属或店铺同步规则。
6. 成功路径不再让数据面板因本错误显示“部分商品数据加载失败”，并可继续填充类目、重量和包装尺寸。

## 方案

为 Seller 门户标签解析增加一个明确的严格标志，而不是继续从 `preferTabId` 猜测调用意图：

- `strictPreferredSellerTab: false`：用于普通商品页请求。`preferTabId` 只是跨域快速读取提示；快速通道失败后忽略买家页编号，调用现有 `ensureSellerTab()` 选择可信 Seller 页面。
- `strictPreferredSellerTab: true`：仅用于携带已冻结 `sellerContext` 的后台采集任务。必须复用快照中的 Seller 标签；标签失效或不再可信时失败关闭，返回 `SELLER_CONTEXT_CHANGED`。

`searchVariantsLocal()` 根据是否存在经过既有 Seller 身份运行时生成的 `input.sellerContext` 设置该标志。内容脚本发送的普通 `searchVariants` 不携带 Seller 快照，因此只能进入非严格回退；后台 Collector 富化任务携带快照，因此保持严格边界。

## 数据流

普通数据面板：

1. 当前买家商品页发送 `searchVariants`。
2. 扩展解析当前可信 Seller 公司上下文。
3. 优先在买家页尝试跨域 Seller 请求。
4. 快速请求失败时，选择现有可信 Seller 页面继续请求。
5. 返回类目、重量和尺寸，面板完成字段填充。

后台冻结任务：

1. Collector 任务取得包含公司编号、修订号和 Seller 标签编号的可信快照。
2. `searchVariantsLocal()` 开启严格标签模式。
3. 快照标签仍可信时继续；标签变化时返回 `SELLER_CONTEXT_CHANGED`，不选择其他 Seller 页面代替。

## 错误处理与安全边界

- 买家页快速通道失败：允许回退，不再误报店铺环境变化。
- 冻结 Seller 标签失效：返回 `SELLER_CONTEXT_CHANGED`。
- 无可信 Seller 页面：沿用 `SELLER_CONTEXT_REQUIRED` 或现有恢复失败提示。
- 多公司编号冲突：沿用 `SELLER_COMPANY_CONTEXT_CONFLICT`，不自动挑选公司。
- Ozon 网络、登录或反爬失败：保留现有分类和重试规则，不伪装成商品无数据。

## 测试与回归

先写失败测试，再实施代码：

1. 普通买家页作为优先标签时，严格 Seller 解析器不得把它判为上下文变化，而应调用现有 Seller 选择器。
2. 冻结 Seller 标签跳转到非可信地址时，仍返回 `SELLER_CONTEXT_CHANGED`，且不得选择其他 Seller 页。
3. `searchVariantsLocal()` 只在存在可信 `sellerContext` 时开启严格模式。
4. 运行 Seller 身份、数据面板、Collector 富化和扩展完整回归。
5. 重新生成扩展安装包，校验源码与两个 ZIP 一致。
6. 在真实 Ozon 商品页验证顶部状态、类目、重量和包装尺寸；同时确认 Seller 页面未被循环刷新或关闭。

## 回滚

回滚标签解析参数、`searchVariantsLocal()` 的参数传递和对应测试即可恢复原行为。没有数据库迁移、数据写入或后端接口变更，不需要数据恢复。
