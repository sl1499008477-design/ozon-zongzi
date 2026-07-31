# 浏览器扩展采集认证恢复设计

## 目标

修复 Ozon 数据面板点击“采集”时，Seller 页面明明已登录但插件因读不到
`sc_company_id` 而无法取得平台类目和物流尺寸的问题；同时让插件严格复用 Web
端的一次性采集会话，未登录时在发起采集前给出明确入口。

## 验收标准

1. Seller 页面正常请求已经携带唯一 `x-o3-company-id` 时，即使
   `sc_company_id` Cookie 缺失，插件仍能解析当前 Seller 公司上下文。
2. Cookie 与页面观测值一致时正常使用；存在多个不同公司编号时必须失败关闭，
   不允许猜测或跨店使用。
3. 插件不读取 Web 页面的 `localStorage`、密码、Bearer token 或 Seller 的完整请求体。
4. Web 未登录或采集会话缺失时，数据面板不再继续加载受保护数据或尝试上传，
   而是展示可直达 Web 登录页的按钮。
5. Seller 上下文缺失、Web 未登录、网络失败、源字段缺失必须显示不同提示；源字段
   缺失时应列出具体字段。
6. 采集成功 contract、采集箱去重逻辑、账号级统一采集箱和上架时选经营店铺的流程
   保持不变。

## 方案比较

### 方案 A：观测 Seller 页面真实请求（采用）

在 Seller 页面 MAIN world 的 `document_start` 脚本中只观测请求头
`x-o3-company-id`，将通过数字格式校验的公司编号传给隔离世界，再由后台按 Seller
标签页保存短生命周期上下文。现有 Cookie 仍是第一来源，页面观测值仅在 Cookie
缺失时兜底。

优点：使用 Ozon 页面实际采用的公司编号，不猜字段、不新增浏览历史权限；适配当前
“页面可用但 Cookie 已不再存在”的真实状态。缺点：需要在 Seller 页面加载后至少发生
一次正常 API 请求。

### 方案 B：新增 `webRequest` 权限

后台直接观察 Seller 请求头。实现较集中，但新增浏览器敏感权限可能触发安装授权变化，
影响现有用户升级，因此不采用。

### 方案 C：从 Seller 页面脚本状态猜测公司编号

当前页面同时出现广告公司编号和经营公司编号，字段语义不稳定，存在串店风险，因此
不采用。

## 组件与数据流

### Seller 公司上下文

1. `seller-company-context-hook.js` 在 Seller 页面开始加载时包装 `fetch` 和 XHR
   的请求头设置，仅观察 `x-o3-company-id`。
2. Hook 只发送 `{type, companyId}`，不发送 URL、Cookie、请求体或响应。
3. `ozon-seller-bridge.js` 校验消息来源、格式和 Seller 域后，将观测结果通过
   Chrome runtime 消息交给后台。
4. 后台按 `tabId` 记录公司编号与观测时间。解析当前公司上下文时：
   - 唯一可信 Cookie 优先；
   - Cookie 缺失时使用当前活动 Seller 标签的最新观测值；
   - 多个值冲突、值过期、没有可信 Seller 标签时失败关闭。
5. `searchVariants`、Seller portal fetch 与 Seller 身份策略共用同一解析函数，避免
   各自重复读取 Cookie 后产生不同判断。

### Web 采集会话

Web 页面继续通过一次性 ticket 建立 `Collector` 会话。插件只持有 Collector
session，不能读取 Web Bearer token。数据卡门禁先调用 `getAuth`：

- 已有 Collector 会话：再检查会员权限并继续加载；
- 没有会话：返回 `WEB_AUTH_REQUIRED`，显示 Web 登录按钮并允许用户重新检查；
- 后端暂时不可用但本地 Collector 会话有效：保留当前会话，不把网络故障误判为登出。

### 错误 contract

采集源字段解析返回 `{payload, variantMatch, sourceError}`。如果 Seller 请求失败，
`sourceError` 必须保留稳定错误码和安全消息。按钮提示按以下优先级显示：

1. `COLLECTOR_AUTH_REQUIRED` / `WEB_AUTH_REQUIRED`：请先登录 Web；
2. `SELLER_CONTEXT_REQUIRED` / `AUTH_REQUIRED`：Seller 公司上下文未就绪；
3. `COLLECT_CAPTURE_INCOMPLETE`：列出缺少的类目、重量、长、宽、高；
4. 网络或超时：网络错误；
5. 其他：采集失败，并在控制台保留已脱敏的排查信息。

## 安全与数据边界

- 只接受 `https://seller.ozon.ru` 顶层标签传来的数字公司编号。
- 公司编号按标签页隔离并带过期时间；冲突时拒绝使用。
- 不记录 Cookie 值、授权头、完整请求体或 Collector ticket。
- Web ticket 仍是一次性、账号级并由后端校验；插件不恢复旧的独立账号密码登录。
- 所有采集上传继续使用账号级 Collector contract，不引入经营店铺 ID。

## 测试

1. Seller hook 单元测试：fetch、XHR 能观察公司编号；无关请求头和非法值被忽略。
2. Seller 身份策略测试：Cookie 正常、Cookie 缺失+唯一页面上下文、冲突、过期和非
   Seller 标签。
3. 后台 contract 测试：`searchVariants` 使用统一公司解析，不再在 Cookie 缺失时
   提前返回旧错误。
4. 数据卡浏览器测试：Web 未登录显示登录入口；Seller 上下文错误和具体缺失字段显示
   正确；不会调用 `pushSourceCollect`。
5. 运行扩展完整测试、应用构建、源目录与公开包一致性校验，并重新生成 ZIP。

## 回滚

回滚新增 Seller context hook、统一解析调用及数据卡门禁即可恢复旧行为；没有数据库
迁移、服务端 contract 或持久业务数据变更。若 Hook 兼容性异常，可单独从 manifest
移除，不影响原 Cookie 路径。
