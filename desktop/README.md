# sonli 采集助手（桌面端）

这是从原桌面程序恢复并迁入 sonli ozon 的 Electron 客户端。现有 Ozon 页面解析、筛选、1688 图片找货、任务 UI 和 Excel 逻辑继续保留；账号、任务、运行记录、市场数据校验、算价、导出与采集箱已改用 sonli 原生契约。

## 当前架构

- 唯一账号体系：`POST /local/accounts/login`，不再创建第二套采集服务会话。
- 任务：`/collector/tasks`。
- 运行租约：`/collector/tasks/:id/runs` 与 `/collector/runs/:id/*`。
- 数据店铺：先读取 Seller Ozon 的 `sc_company_id`，再调用 `/local/data-collection-stores/verify`。
- 市场数据：在 `seller.ozon.ru` 页面上下文调用 `what_to_sell/data/v3`。所有请求共用 200ms 节奏闸门，临时错误最多尝试 3 次。
- 算价：`POST /pricing/collector/calculate`。
- 会话隔离：每个 sonli 账号分别使用 `seller`、`ozon`、`1688` 三个持久 Electron partition。
- 自动直接上架已停用；结果应从 sonli 采集箱继续处理。
- 任务列表提供“加入采集箱”：默认导入该任务最新运行的全部 `QUALIFIED` 结果；IPC 同时接受 `itemIds` / `sourceKeys`，供后续结果级勾选界面显式选择。
- 运行开始后冻结 Seller Company 与数据店铺；后续每批/每页取数都会复核，检测到切店立即终止，市场快照同时绑定 task/run。
- 排队 run 的持久化 contract 以 PostgreSQL 为目标；桌面重启后应恢复 `QUEUED` run，并在租约过期时安全 reclaim。连续三次心跳失败会停止任务，避免产生失去租约的数据。当前保护性基线没有连接 PostgreSQL 做集成验证。
- 类目冷启动提供“全部类目”；运行过程中从 Seller Analytics 商品自动学习并保存最新类目映射，不内置易过期的静态类目表。
- 服务端和桌面 Excel 图片下载均限制协议、来源、超时、大小和像素，服务端额外阻断私网/元数据地址。
- 桌面 Excel 只允许在 Electron `userData/excel` 受控目录内创建、恢复、删除和导出。新文件名用可逆任务 ID 身份段区分所有权；旧版模糊命名文件不会自动重新认领，需要人工核对后另行迁移。

经营店铺和数据店铺统一在 sonli 后台管理；创建任务时读取当前账号所选店铺并冻结到任务，运行前再用 Seller 登录态重新校验数据店铺。

## 运行配置

可通过环境变量或同名命令行参数覆盖：

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| `SONLI_API_BASE` | `http://127.0.0.1:3001` | sonli API |
| `SONLI_WEB_BASE` | `http://127.0.0.1:3000` | sonli Web 后台 |
| `SONLI_SELLER_CENTER_URL` | `https://seller.ozon.ru/app/analytics/what-to-sell` | Seller 登录/分析页 |
| `SONLI_UPDATE_URL` | 空 | Electron 更新源 |
| `SONLI_CONFIG_URL` | 空 | 公告配置 |

非本机 HTTP 地址会被拒绝；线上服务必须使用 HTTPS。

## 本地验证

```bash
pnpm install --frozen-lockfile
pnpm verify
```

`desktop/` 是独立 pnpm workspace，必须先按自己的锁文件安装依赖。验证会执行：

1. 扫描旧服务域名、双登录 token、旧业务路径和直接发布入口；
2. 对桌面主进程、preload 和已编译 renderer 做语法检查；
3. 测试 Seller Analytics 字段归一、请求体、重试分类、任务状态与并发契约。

当前本地静态与单元验证为 42 项全部通过，其中包含真实 `cheerio` 解析器测试。当前没有启动
Electron GUI、连接 PostgreSQL、登录 Seller/Ozon/1688，或执行真实平台调用。

主窗口当前启用了 sandbox、context isolation 和导航限制，但 IPC handler 的 sender/origin
校验以及 renderer 可接触本地 token contract 的防御加固尚未完成真实 GUI 验证。

## 登录与验收

开发和静态测试不会尝试真实登录。端到端验收时由用户在桌面端 Seller Ozon 窗口和 1688 窗口中交互式登录；密码、Cookie 与 token 不得写入日志。Seller 数据调用前必须成功通过 sonli 数据店铺校验。

## 打包

```bash
npm run dist:win
npm run dist:mac
npm run dist:mac:zip
```

`dist:mac` 生成 DMG + ZIP；无法挂载磁盘镜像的 CI 环境可使用 `dist:mac:zip`。项目锁定 macOS arm64/x64 和 Windows x64 的 Sharp 原生依赖。内测可先使用未签名包，正式发布必须配置 Apple Developer ID/notarization 和 Windows Authenticode。
