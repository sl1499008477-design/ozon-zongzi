# 模块边界

本项目的入口文件仍包含一批历史页面和兼容路由。为避免继续形成万能模块，后续开发遵守以下门禁：

- `server/index.mjs` 只负责进程启动、HTTP 编排和仍待迁移的兼容路由。账号、会话、店铺归属、审计、同步租约、Browser Agent 状态机、持久化事务、算价、采集和上架等业务规则必须放在独立模块。
- `app/src/App.jsx` 只保留应用壳、路由编排和仍待迁移的历史页面。新页面不得继续直接写进该文件。
- 账号设置、算价设置、店铺设置、利润趋势和数据大屏已经是独立页面模块。
- 订单金额解析、订单分析、金额展示、API/插件通信、表格和日期规则已经是稳定的共享模块。
- 新增业务模块时，优先新增一个明确用例的 Service/页面模块；不得新增万能 `utils`。
- `server/tests/module-boundaries.test.mjs` 会阻止入口文件重新膨胀或把已拆出的职责搬回入口。
- 角色权限和待确认的平台业务规则见 `permissions-and-platform-rules.md`；路由不得自行新增角色判断或未经确认的费率默认值。

## Ozon 类目查询边界

- `server/ozon-category-service.mjs` 唯一负责真实 Ozon 类目数据的查询、结构校验、6 小时 TTL 缓存、字典值分页及 `typeId` 到 `descriptionCategoryId` 的解析。它不读取本地商品缓存，也不处理 HTTP 响应。
- `server/ozon-category-routes.mjs` 负责三个既有类目查询路径的后端认证、账号/店铺归属校验、URL 参数解析和 HTTP 成功/错误映射；路由不得实现类目查询算法或读取本地商品缓存。
- `state.caches.products` 及其他本地商品缓存禁止作为类目树、类目 ID、属性或字典值的来源。只有服务取得并校验的 Ozon 数据（或其未过期的真实数据缓存）可供类目选择和解析。
- 商品预检和上架最终校验直接消费服务稳定 contract：`getCategoryTree`、`getCategoryAttributes` 与 `getCategoryAttributeValues`；必要查询失败必须向上传播，不能创建成功预检或上架任务。
- 三个 HTTP 消费者保持 `data`、`items`、`total` 成功字段，并可消费服务提供的来源 `meta`；入口文件只装配服务并委托类目路由。

目前 `server/index.mjs` 的兼容入口行数上限为 5200，不是推荐大小，而是迁移护栏。后续每次拆分后应只下调上限，不能上调。

## 可移植验证配置

扩展来源对比依赖显式环境变量 `QH_SOURCE_EXTENSION_DIR`，值必须是待比较的上游扩展目录：

```bash
QH_SOURCE_EXTENSION_DIR=/absolute/path/to/upstream-extension node scripts/check-extension-source-parity.mjs
```

同一变量也供扩展 UI 与 diff contract 门禁使用。缺失配置时相关脚本必须以退出码 `2`
报告“环境阻塞”，不能静默跳过或写死某位开发者的个人路径；退出码 `2` 在根验证中始终按失败闭环处理。
