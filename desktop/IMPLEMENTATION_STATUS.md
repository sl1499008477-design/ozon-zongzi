# sonli 采集助手 V1.0.20 交付状态

更新日期：2026-07-29

> 本文的“已实现”描述代码能力；不等于当前机器已经完成真实平台或生产环境验收。
> 2026-07-11 的产物与集成结果作为历史交付记录保留，当前保护性基线的验证边界见文末。

## 正式内测产物

2026-07-11 的交付记录曾只保留 Apple Silicon 内测包；下列摘要是历史记录。当前工作树中没有
`release/SHA256SUMS.txt`，本轮也没有重新打包或复算校验值，因此不能把它当作本次基线的已验证产物。
Windows 与 macOS Intel 产物仍需在最终开发完成并收到明确打包指令后重新生成：

| 平台 | 文件 | SHA-256 |
|---|---|---|
| macOS Apple Silicon | `sonli-collector-1.0.20-mac-arm64.zip` | `d356431af7cb193b9ef0546de2015c8c0470279cd15190479528ac823da12f77` |

## 已实现

- sonli 统一账号、会话、登录期限、退出和账号/店铺数据隔离。
- macOS ARM64/x64 与 Windows x64 Electron 客户端。
- 任务增删改查、复制、并发、取消、重跑、租约、心跳、日志、崩溃恢复和导出。
- Ozon 链接滚动采集、商品详情、跟卖信息和现有筛选规则。
- 1688 以图找货、价格/销量排序和货源链接。
- Seller Analytics `what_to_sell/data/v3`、数据店铺校验与运行期冻结。
- 63 列带图 Excel、MinIO 存储和下载。
- 合格结果进入 sonli 采集箱，并继续使用现有草稿/上架队列。
- `goodsFilter` 反推定价与 `goodsFilter2` 主要利润字段。

## 部分实现或仍需真实环境验收

- `goodsFilter2` 没有恢复出唯一可信的原尾程配送费公式，
  `endDeliveryFee` 保持为空；同时缺少源服务黄金输入/输出，不能声明逐分一致。
- sonli 的最终物流、汇率和上架配置尚在开发；当前已经保留读取和适配接口。
- Seller Analytics 核心销量、GMV、广告和促销字段已映射，但仍需用真实数据店铺响应做长期回归。
- Ozon/1688 网页采集代码已经迁移；页面 DOM、验证码、风控和内部接口变化只能在真实登录环境持续验证。
- 类目冷启动支持“全部类目”并会自动学习映射，但新账号首次使用时没有预置完整类目树。
- 后端支持按 `itemIds/sourceKeys` 精确加入采集箱；当前桌面按钮提供任务级全部合格结果导入，尚无逐商品勾选结果页。
- 崩溃后可以安全重新领取并依靠幂等 upsert 去重，但不是滚动位置/1688 子任务级的精确断点续采。
- Excel 现在统一写入 Electron `userData/excel` 受控目录，并把原始任务 ID 编码为无歧义的文件所有权段。
  旧版按“清洗后任务名/前缀”生成的文件不会自动重新发现；如需保留，必须先人工核对归属，再复制到新命名体系。
- IPC sender/origin 校验与 renderer 本地 token 暴露仍是后续防御加固项；当前只验证了 sandbox、
  context isolation、窗口导航限制和 Excel 路径边界，没有完成真实 Electron GUI 攻击面测试。

## 未实现

- 商品俄文/原文标题自动翻译为中文：旧翻译服务已移除，sonli 目前没有可用的翻译接口或服务凭据。
- 原程序精确尾程物流费算法：恢复代码和现有配置不足以唯一确定公式。
- Apple Developer ID 签名、公证和 stapling，以及 Windows Authenticode 签名：当前环境没有证书。
- DMG：当前构建环境无法使用 `hdiutil` 创建设备镜像，macOS ZIP 可正常使用。
- 自动更新发布通道：当前构建明确使用 `--publish never`，尚未配置发布地址和签名元数据。

`batchCreateGoods` 自动转换和直接上架按需求明确排除，不属于实现失败。

## 当前保护性基线验证结果

- 测试清单：100 个 active、13 个 historical/manual。
- 单进程 active 套件：186 项中 185 项通过；唯一失败是桌面解析测试无法加载本机未安装的
  `cheerio`。桌面独立验证为 41 项中 40 项通过，原因相同。
- 根验证：App 构建、扩展 UI/diff contract、语法、manifest、Docker Compose 插值、隔离门禁、
  whitespace 和凭据字面量扫描已通过；Task 7 时扩展解压分发副本与 ZIP 仍未同步，留给生成产物任务处理。
- 数据库：仓库当前有 19 个 SQL migration 文件；本轮只核对清单，没有连接 PostgreSQL，
  没有执行迁移，也没有复验并行 migration。
- 当前未验证：MinIO 真实上传/下载、Electron GUI、packaged app、Chrome 扩展生命周期、
  真实 Seller/Ozon/1688、Windows、Intel Mac，以及任何真实外部写操作。
- 回滚：文档提交可单独 `git revert`；运行代码应按对应功能提交逆序回退。数据库与外部数据本轮未改动，
  不需要为本轮文档提交执行数据回滚。
