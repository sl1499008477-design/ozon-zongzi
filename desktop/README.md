# ozon 粽子

当前源码与 Windows 修复版为 **1.0.1**；Mac 已发布包仍为 1.0.0。默认用户资料目录迁移为「ozon 粽子」，保留原登录加密身份及旧路径兼容链接；目录被占用时继续使用旧资料。当前包未启用自动更新；查看 [交付及更新说明](../docs/reports/2026-09-11-brand-v1-release.md)。下方历史版本段落仅用于追溯。

这是从原桌面程序恢复并迁入 ozon 粽子 的 Electron 客户端。主要流程是根据 Ozon 销售与营销数据筛选商品，将合格结果发送到 Web 补全资料，再直接上架或进入 AI 上架。桌面不再接入 1688、采购比价或商品定价，历史任务和历史结果保留。

## 当前架构

- 唯一账号体系：`POST /local/accounts/login`；桌面通过正常票据交换取得同账号 Collector 授权。
- 任务：`/collector/tasks`。
- 运行租约：`/collector/tasks/:id/runs` 与 `/collector/runs/:id/*`。
- Seller 来源：验证当前登录页面，以 ozon 粽子账号和实际 `sourceIdentity` 关联每轮运行。
- 市场数据：在 `seller.ozon.ru` 页面上下文调用 `what_to_sell/data/v3`。所有请求共用 200ms 节奏闸门，临时错误最多尝试 3 次。
- 采集任务不依赖费用或算价配置。迁移 124 只允许新 run 的算价配置引用为空，旧引用及外键保留。
- 会话隔离：每个 ozon 粽子账号分别使用 `seller`、`ozon` 持久 Electron partition；退出登录时仍清理旧版遗留的 1688 分区。
- 每次打开 Ozon 采集窗口，使用平台“语言和货币”设置的 `changeCurrency` 操作选择 CNY，保存本账号会话后刷新页面。前台参考价按平台实际返回的金额和币种记录；设置失败明确提示，不把卢布金额标成人民币。
- Seller 的均价、销售额及基于它们的筛选保持报告原始 RUB 口径。Ozon 提示 CNY 是参考换算展示；目标店铺上架价继续由 Web 上架配置决定。
- 任务列表提供“加入采集箱”：默认导入该任务最新运行的全部 `QUALIFIED` 结果；IPC 同时接受 `itemIds` / `sourceKeys`，供后续结果级勾选界面显式选择。
- “发送至 AI 上架”复用同一导入和去重流程，打开预选商品的 Web AI 上架页。超过 100 个商品时展示全部批次，每批最多 100 个，不静默截断或同时弹出多个页面。用户在 Web 使用店铺、仓库和售价配置创建任务；关闭人工审核时，页面须明确生图成功后自动提交。
- 运行开始后冻结实际 Seller 来源；后续取数复核来源身份，市场快照同时绑定 task/run。
- 排队 run 持久化在 PostgreSQL；桌面重启后恢复 `QUEUED` run，并在租约过期时安全 reclaim。连续三次心跳失败会停止任务。真实 HTTP、专库和两个独立进程的恢复验证见修复记录。
- 类目冷启动提供“全部类目”；运行过程中从 Seller Analytics 商品自动学习并保存最新类目映射，不内置易过期的静态类目表。
- 服务端和桌面 Excel 图片下载均限制协议、来源、超时、大小和像素，服务端额外阻断私网/元数据地址。
- 桌面 Excel 只允许在 Electron `userData/excel` 受控目录内创建、恢复、删除和导出。新文件名用可逆任务 ID 身份段区分所有权；旧版模糊命名文件不会自动重新认领，需要人工核对后另行迁移。

采集资料归属当前 ozon 粽子账号；发布时在 Web 选择经营店铺。任务进度区分已获取商品和通过筛选商品。Excel 保留 Ozon 前台参考价、报告指标、包装及跟卖资料，不包含采购价、费用、利润或推荐售价。

## 界面与品牌

1.0.29 与 Web 使用同一套浅蓝背景、白色圆角面板、蓝色主按钮和品牌 Logo。任务列表、新建/编辑弹窗及登录页由 `dist/assets/web-theme.css` 统一外观，控件主题放在现有 renderer 的 ConfigProvider；已有采集、IPC、AI 上架和持久化 contract 不变。最小窗口仍为 1100×680，任务列表与长表单内部滚动，弹窗底部操作保持可见。

`pnpm build:brand` 直接复用 `app/public/brand` 的 Web 矢量标志，生成白底蓝标圆角应用图标、ICO 和界面 Logo。更新品牌素材后先运行此命令再打包。应用名称、appId 和账号会话目录保持现有值，换图标不新建登录资料。

1.0.29 的界面、原生应用及安装包核对结果见[桌面 Web 风格验收记录](../docs/reports/2026-09-10-desktop-web-style.md)。

1.0.30 的应用显示名为「ozon 粽子」；包名、appId 和原有账号/Seller 会话目录保留。新建及编辑任务的基础信息增加「自动发送至 AI 上架」，默认选「否」，旧任务不会自动开启。选「是」后，仅在该轮采集成功且有合格商品时自动执行现有发送操作：导入采集箱、携带选中记录打开 Web AI 上架页；仍使用 Web 的店铺、仓库和上架配置创建 AI 任务。多个批次或浏览器打开失败时保留批次窗口，多个任务的结果依次展示。

自动发送使用运行创建时保存的配置和刚完成的 run ID。发送失败不会将采集改为失败，已采集结果可通过原「发送至 AI 上架」按钮补发。应用中断后不会追溯自动发送历史已完成任务。

1.0.30 的测试和当时的方案见[自动发送与去重方案记录](../docs/reports/2026-09-10-desktop-auto-ai-and-dedup-proposal.md)。

1.0.31 已实施用户确认的跨任务去重：同一账号、Ozon 来源、精确源 SKU 在桌面成功入库或已有 Web/扩展采集资料时跳过；成功上架历史独立保留。主动删除且未成功上架的商品可重采。失败、取消、租约失效释放临时占用；跳过项不占目标数量，继续找新商品。无法确定保存/删除语义的旧记录允许重采。

进度显示新采集、已采集跳过、已上架跳过和正在采集跳过。「查看跳过商品」可查看来源任务、采集箱和上架记录；从来源任务发送 AI 时只发送所选历史商品，固定其原 run 和商品 ID。服务端新增批量 SKU claim/release 接口，复用现有运行授权与租约；迁移 126、128 为增量变更。验收、兼容限制和回滚说明见[桌面 SKU 去重记录](../docs/reports/2026-09-10-desktop-sku-dedup.md)。

## 运行配置

可通过环境变量或同名命令行参数覆盖：

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| `SONLI_API_BASE` | `http://127.0.0.1:3001` | ozon 粽子 API |
| `SONLI_WEB_BASE` | `http://127.0.0.1:3000` | ozon 粽子 Web 后台 |
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

本次测试、实际原生采集、产物哈希及未验证范围统一记录在[2026-09-10 修复与验收记录](../docs/reports/2026-09-10-project-repair-acceptance.md)。测试文件数量不代表真实流程全部通过；较早基线见历史交付记录。

## 登录与验收

端到端验收使用用户在原生平台窗口完成的正常登录，复用当前账号的持久会话；密码、Cookie 与 token 不得写入日志。Seller 数据调用前验证当前登录来源。平台要求登录或验证时，由用户在对应窗口完成。

## 打包

```bash
npm run dist:win
npm run dist:mac
npm run dist:mac:zip
```

`dist:mac` 生成 DMG + ZIP；无法挂载磁盘镜像的 CI 环境可使用 `dist:mac:zip`。项目锁定 macOS arm64/x64 和 Windows x64 的 Sharp 原生依赖。内测可先使用未签名包，正式发布必须配置 Apple Developer ID/notarization 和 Windows Authenticode。

## Web 软件下载页

Web 右上角「软件下载」进入 `/ozon/downloads`。采集助手是一款软件，同一版本提供 Mac Apple 芯片 ZIP、Mac Intel ZIP、Windows x64 安装版和便携版共 4 个包。Mac 包要求 macOS 12 或以上（以包内 Info.plist 为准），Windows 不提供 32 位或 ARM64 原生包。

在桌面目录完成上述打包后，从项目根目录运行：

```bash
node scripts/publish-desktop-downloads.mjs desktop/release
pnpm build
```

可将第一个参数改为其他构建输出目录。脚本只选择与 `desktop/package.json` 当前版本一致的已完成 ZIP/EXE，复制到 `app/public/downloads/collector/`，记录文件大小及 SHA-256 到 `app/src/collector-release.json`。页面使用同一清单；缺少的系统包显示未发布。先完成所有打包命令再发布，发布时不要并行改写安装包。版本发布需递增版本号；旧版本文件保留以支持回退。二进制包不提交 Git，部署 Web 前须重新生成或恢复清单对应的文件。

2026-09-11 已发布 1.0.31 的 4 个包，构建目录为 `outputs/software-downloads-1.0.31/`。Windows 内测打包使用 `--config.win.signExecutable=false`，保留应用图标和版本资源，只跳过签名。Mac Apple 芯片已有本机运行验证；Intel Mac 与 Windows 已完成打包及包内版本/文件核对，尚待对应系统实机运行验证。详细下载验收见 [软件下载交付记录](../docs/reports/2026-09-11-software-downloads.md)。

安装包默认连接本机 `127.0.0.1` 服务。跨电脑使用需按「运行配置」设置已部署的 HTTPS Web/API 地址；下载和安装成功不代表远程后台已配置。
