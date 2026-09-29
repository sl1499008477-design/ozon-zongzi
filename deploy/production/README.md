# ozon 粽子 1.0.0 服务器部署记录

首次部署日期：2026-09-11；最新发布：2026-09-15 21:07，扩展 1.0.15 下载与版本信息已更新。下方带日期的旧记录保留当时状态。

扩展下载发布回退备份：`/var/backups/ozon-extension115-20260915-210657/compose.before.yml`；仅恢复 API/Web 镜像并重建两项服务。验证与限制见 `outputs/releases/2026-09-15-seller-recovery/修复与验证说明.md`。

## 访问与运行位置

- 正式入口：https://www.ozonzongzi.com/ozon/products/list/
- 软件包：https://www.ozonzongzi.com/ozon/downloads/
- ECS：182.92.215.36，阿里云 Linux 3，x86_64，2 核 / 8 GiB（2026-09-13 云控制台核实），40 GiB 磁盘。
- 宿主机发布目录：`/opt/ozon 粽子/releases/1.0.0-20260911`。
- 生产环境文件：`/opt/ozon 粽子/shared/production.env`，root / 0600。
- Compose 项目：`ozon-zongzi`。API 与 worker 容器内工作目录 `/srv/sonli`。
- 当前 API 镜像 `ozon-zongzi-api:1.0.0-20260915.extension115`；上架 worker、AI worker 保留 `ozon-zongzi-api:1.0.0-20260915.first-media1`；Web 镜像 `ozon-zongzi-web:1.0.0-20260915.extension115`。
- 本次额度与布局回退使用 `/var/backups/ozon-ai-quota1-20260915-175649/compose.before.yml` 中的 API/Web 镜像，只重建这两项服务；详情见 `docs/reports/2026-09-15-ai-store-quota-layout.md`。
- 此前仓库加载修复仅更新 API：正式仓库关联不再依赖页面商品目录。该次回退仅恢复 `/var/backups/ozon-warehouse1-20260915-172552/compose.before.yml` 中的 API 镜像并重新创建 API；环境和数据库不回退。验收见 `docs/reports/2026-09-15-warehouse-loading.md`。
- 新 PostgreSQL 数据库 `ozon_production`，使用独立 volume；没有公开数据库端口。
- 本机日常目录仍为 `/Users/songliang/Documents/ozon 粽子`。本机改动不会自动更新服务器镜像。

| 服务 | 服务器监听 / 访问方式 |
| --- | --- |
| Web | 127.0.0.1:4173，由 Caddy 提供公网 HTTPS |
| API | 127.0.0.1:38303；Web 经 `/api/` 代理 |
| worker / ai-worker | 无公网入口，分别处理上架与商品生图 |
| 新图片和视频 | 桶 `ozon-zongzi-production`；Web 预览入口保留，上架下载改为媒体域名直接连接 MinIO，仅两个媒体前缀允许匿名读取 |
| 旧图片 | 原 `media.ozonzongzi.com` 地址及桶保持可用 |
| Ozon 回调中转 | 原 38302 中转入口；应用目标由 38301 改为 38303 |

`www` DNS A 记录由 47.243.191.50 改为 182.92.215.36，TTL 保留 600 秒。`media` DNS 与现有图片转发未改动。Caddy、Docker 和回调服务设置为开机启动；各容器使用 unless-stopped。

MinIO 沿用已有 `sonli-media-minio`，新应用使用独立用户及 `ozon-zongzi-media` 外部网络，容器别名 `media-storage`。仅 `listing-media/v1/ai-image-listing/*` 与 `listing-media/v1/prepared/*` 允许匿名 GetObject，其余对象、列表及写入保持受保护。普通重启会保留网络连接；若以后删除并重建 MinIO 容器，需在运行应用前重新执行 `docker network connect --alias media-storage ozon-zongzi-media sonli-media-minio`，仅在该容器尚未连接网络时执行。

## 2026-09-15 无品牌与完整媒体交付

设置 `LISTING_ASSET_DOWNLOAD_BASE_URL=https://media.ozonzongzi.com/ozon-zongzi-production/`（必须包含桶名）。使用现有服务器，不新建 OSS、服务器、凭据或数据库迁移。提交前先备齐媒体、固定图片顺序；视频流式临时落盘，完成后清理临时文件。准备失败只阻止当前商品，保留生成图；已经受理或结果不明的提交沿用原有恢复逻辑，不自动重复发送。

实际原商品 4380440590 一次更新后，Ozon 收到 11 图和 3 视频，无媒体错误；11 图逐张 SHA256 与原顺序一致，3 个成片完整读取验证通过。1555.80 CNY 和库存 5 未改。相关回归在本机和候选镜像各 152 项通过；两件 Xiaomi 失败商品仅验证新无品牌规则，没有自动重提。

发布目录 `/opt/ozon-first-media1-20260915/payload`。回滚配置位于 `/var/backups/ozon-first-media1-20260915-163725`；恢复其中旧 Compose 和环境文件后，仅重新创建 API、Web、worker、ai-worker。不要回退数据库、重生成密钥或删除已发布媒体/读取策略。当前 3 Mbps 服务器已跑通此代表商品，未验证多人峰值容量。

## 数据与自动开关

首次部署时生产只有 1 个新 admin、1 个 sl-主店；之后在正式环境新增的账号与业务数据正常保留。重新生成生产密码与加密密钥；未迁移旧账号、密码和会话。保留 2 条 AI 通道、2 条 AI 预设、4 个消息模板、1 条活动报名规则、8 条禁售配置及算价版本、佣金/物流/汇率配置。两份官方佣金源文件继续保留在原私有桶，21,590 条类目映射已导入。

同步前商品、订单、AI 任务、钱包流水和消息记录均为 0；随后只读同步取得 580 个商品、850 条订单记录及仓库、活动、聊天数据。页面数量受当前日期与状态筛选影响。这些是平台重新读取的真实资料，没有用旧测试库替代生产库。

- AI 通道、消息总开关及 4 个模板、活动总开关/自动退出/底价保护及报名规则均关闭。
- 本机旧环境的主店消息与活动自动执行也已关闭；配置单独备份，关闭前确认没有待执行活动任务。旧数据库和本机服务保留。
- 保留的 AI 图片预设启用人工审核并取消自动换店；原测试店仓库绑定被清空，测试前应选择主店仓库并明确审核方式。未选择预设时，页面仍沿用现有默认选项，应检查后再创建任务。
- 动态汇率探针、采样历史没有迁移；当前静态汇率配置保留。要验证动态汇率，应在正式环境重新配置采样 SKU。
- 旧类目策略/旧自动上架偏好留存在私有导出包，不自动激活。
- 原 Ozon 回调 URL/token 和原 ERP 目标保持一致，只切换本系统接收目标；中转事件账本保留。历史订单没有真实到店时间时，不补造到店日期。

## 实际验收

- 正式 HTTPS 浏览器登录、登录会话在服务重启后继续有效；页面 DOM 核对商品、订单、消息、活动、AI 通道、采集箱、提示词、算价、禁售及下载页面。
- 匿名请求无法取得业务信息，跨店请求返回 403。AI 通道匿名接口沿用原有 400 拒绝状态，其他被测业务接口为 401。
- 只读 Ozon 商品、仓库、订单、活动及聊天同步成功；主店识别到 Premium Pro。
- AIArtMirror 与 AnyAIGC 的模型目录连接检查均为 AVAILABLE；没有迁入旧能力测试通过记录。
- 服务器 Linux x64 上使用内置 6 图验证 OCR、拼图和切片，约 61.5 秒，输出 6 张 768×1024；俄语参数、小数尺寸及空白页顺序检查通过。此项没有调用付费图片模型。
- 新私有桶写入与公网图片读回字节一致，历史公开图片 HTTP 200。2 份私有佣金原文件在服务器内部通过 SDK 校验 SHA-256，与保存值一致，没有导出到本机。
- 5 个下载包均可 HEAD / Range 读取，文件长度、ZIP/EXE 文件头及服务器全文件 SHA-256 均匹配发布清单。
- 新 API、worker、Web 重启后重新登录与数据统计核对通过，配置未丢失；各服务无 OOM，原 MinIO 与旧 PostgreSQL 保留运行。
- Ozon 回调内部与公网 PING 通过，原 ERP 目标未变，最终中转队列 pending=0。首次切换曾因配置文件属主/权限错误短暂启动失败，已恢复原配置后按 root:sonli-message-tunnel / 0640 正确切换；中转账本未清空，不能据此声称短暂中断期间所有外部事件均已重投。
- 最终 AI 任务、钱包流水、库存写入、活动执行、买家消息记录均为 0。未执行付费生图、真实 Ozon 上架、库存/活动写入或买家消息发送。

客户端下载默认指向正式域名。若已有本机安装保留了旧服务设置，需核对服务地址并使用新生产账号登录。包未签名；Intel Mac 和 Windows 尚未在对应真实系统运行验收。初次部署时服务器按单并发配置；2026-09-13 已将商品/请求上限保存为 3、本地处理和同计费账号上限保存为 1，自动调节开启。尚未做真实付费模型的多人容量压力测试。

## 运维与备份

```sh
cd '/opt/ozon 粽子/releases/1.0.0-20260911'
PRODUCTION_ENV_FILE=../../shared/production.env docker compose --env-file ../../shared/production.env -f compose.yml ps
PRODUCTION_ENV_FILE=../../shared/production.env docker compose --env-file ../../shared/production.env -f compose.yml config --quiet
```

后续更新需先备份数据库与匹配的 production.env、检查待执行任务，再构建新标签镜像，修改 Compose 中的镜像标签并启动。后端构建必须包含 `shared/`；客户端生产地址构建见 `desktop/PRODUCTION-BUILD.md`，应先发布客户端产物再构建 Web。不要从本机 `.env` 覆盖 production.env 或重生成加密密钥。

服务器私有备份目录：`/var/backups/ozon-zongzi-20260911`，root / 0700。包含旧 PostgreSQL、旧媒体目录、Caddy、中转配置/SQLite，及本次新生产数据库、匹配环境文件和新媒体快照。

- `production-ready.dump`：4,682,965 字节，pg_restore 清单验证 1,805 项。
- SHA-256：`d07399d23abd1d86a573cc4463c51ddb03867322f3a30259690585d216fb1a35`。
- 验证报告：`production-smoke-report.json`、`production-sync-report.json`、`production-final-report.json`、`production-ocr.json`、`callback-cutover-report.json`。
- 本机数据库、匹配旧密钥/环境、生产登录资料、配置种子与恢复资料保存在项目旁独立私有目录 `ozon 粽子-部署资料/2026-09-11`；不提交 Git，不提供 Web 下载。
- 上传用的临时配置压缩包、种子目录及 API 内的传输密钥目录已清理；安装中的生产 env 保留。

此次创建的是部署快照，尚未配置持续异地自动备份。后续新增的订单成本、任务/消息去重、充值和账目须连同相应密钥持续备份。

恢复数据库应先在新数据库中验证快照并核对业务增量，不直接覆盖已产生新业务的生产库。回退初次部署时，先停止新 API/worker 的业务处理；若需恢复本机接收回调，确认本机 API 与 38301 隧道可用，再恢复旧中转配置，必须保留 root:sonli-message-tunnel / 0640，并验证服务账号可读后重启。不得清空 relay.sqlite3 或同时开启新旧环境的自动操作。

旧 DNS、原中转配置和本机开关均有独立备份。默认保留原 ERP 目标，不执行 Ozon 推送注册覆盖。恢复同一数据库必须使用与其匹配的加密密钥，否则已保存的店铺和通道凭据不能解密。

## 2026-09-11 账号列表修复

账号接口已有真实账号，页面却没有首次读取，手动刷新后又被初始化的空列表覆盖。账号页现自行读取 `/api/local/accounts`，不再用全局初始化数据覆盖结果。正式环境首次进入、手动刷新和整页刷新均显示实际 2 个账号。

本次只更新 Web 镜像到 `ozon-zongzi-web:1.0.0-20260911.2`，API、worker、数据库结构及账号信息不变；既有客户端下载文件保留。补丁目录为 `updates/accounts-ui`，数据库与匹配环境、原 Compose 另存 `/var/backups/ozon-zongzi-20260911-accounts-ui`。原 Web 镜像保留，可只改回原标签并执行 `up -d --no-deps web` 回滚页面，无需恢复数据库。验证记录见 `docs/reports/2026-09-11-account-list-load.md`。

## 2026-09-11 Windows 启动修复版

Windows 安装版和便携版更新为 1.0.1，修复自身锁阻止资料目录改名的问题；无法迁移时沿用旧资料。Mac 下载包保持 1.0.0，按文件显示真实版本。Web 镜像更新为 `ozon-zongzi-web:1.0.0-20260911.3`，只重新创建 Web，保留账号页修复，API/worker 和业务数据不变。

补丁位于 `updates/windows-1.0.1`，原 Compose、数据库与匹配环境保存在 `/var/backups/ozon-zongzi-20260911-windows-1.0.1`。回退只需将 Web 改回 `.2` 并 `up -d --no-deps web`，不要覆盖数据库。生产下载校验及账号页回归通过；Windows 实机启动仍待用户复核。详见 `docs/reports/2026-09-11-windows-profile-startup.md`。


### 2026-09-12 扩展图册修复

Web 当前镜像 `ozon-zongzi-web:1.0.0-20260912.1`，基于 `.3` 只覆盖下载页构建和扩展 v1.0.1 ZIP；API/worker 保持 `ozon-zongzi-api:1.0.0-20260911.2`。此次没有数据库迁移及生产业务写入。

发布包位于 `/opt/ozon 粽子/releases/1.0.0-20260911/updates/extension-1.0.1`。原 Compose、环境及数据库备份保存在 `/var/backups/ozon-zongzi-20260912-extension-1.0.1`。回滚仅将 Web 镜像恢复 `ozon-zongzi-web:1.0.0-20260911.3` 并 `up -d --no-deps web`，不要恢复数据库。

## 2026-09-12 AI 任务权限与取消

当前 API 为 `ozon-zongzi-api:1.0.0-20260912.1`，Web 为 `ozon-zongzi-web:1.0.0-20260912.3`；worker 仍为 `ozon-zongzi-api:1.0.0-20260911.2`。只更新本次runtime及AI任务UI、管理员账单入口，无数据库迁移、无真实取消或付费验证。生产数据库及匹配配置备份位于 `/var/backups/ozon-zongzi-20260912-ai-task-access`。详情见 `docs/reports/2026-09-12-ai-task-access.md`。

归档必须保留静态目录权限，并在Web镜像确保assets可被nginx遍历/读取；验收同时检查HTTP MIME、文件哈希和实际浏览器渲染。此次中间Web `.2` 曾因目录权限导致空白，已用 `.3` 修复，不可回退 `.2`。功能回滚目标为API `.20260911.2` 和Web `.20260912.1`，不要覆盖数据库。


## 已发布：2026-09-13 独立 AI worker

仓库 Compose 默认新标签为 `1.0.0-20260913.ai-runtime1`，可通过 `RELEASE_TAG` 指定此次发布标签；本次服务器已使用该标签。API、上架 worker 与 AI worker 共用本次构建的 `backend` 镜像，Web 使用同标签的 `web` 构建。不要继续使用不含 `server/ai-listing-worker.mjs` 的旧 backend 镜像启动 AI worker。

日常本机仍从项目根目录运行 `pnpm dev` 或 `启动项目.command`，启动器会监管 AI worker；`LISTING_PIPELINE_V3=0` 时两个上架 worker 均不启动。单独运行 AI worker 可用 `pnpm worker:ai`。API 仅准备 Excel 来源数据，独立 AI worker 执行已冻结来源的图片生成及上架结果续接，不监听 HTTP 端口。启动依赖既有 PostgreSQL、匹配的环境文件与已执行的数据库迁移；worker 不创建、重建数据库或生成密钥。

发布前检查在途队列、备份数据库与匹配环境文件，再从完整源码 checkout 构建。Compose 的构建上下文相对仓库内 `deploy/production/compose.yml` 为项目根目录；不要仅复制此 Compose 到缺少源码的旧 release 目录后执行 build。示例（环境文件路径由实际发布目录提供）：

```sh
export PRODUCTION_ENV_FILE=/absolute/path/to/shared/production.env
export RELEASE_TAG=1.0.0-20260913.ai-runtime1
docker compose --env-file "$PRODUCTION_ENV_FILE" -f deploy/production/compose.yml config --quiet
docker compose --env-file "$PRODUCTION_ENV_FILE" -f deploy/production/compose.yml build api web
# 在确认队列已停妥、备份完成后执行既有迁移流程，再启动本次服务。
docker compose --env-file "$PRODUCTION_ENV_FILE" -f deploy/production/compose.yml run --rm --no-deps api node server/db/migrate.mjs
docker compose --env-file "$PRODUCTION_ENV_FILE" -f deploy/production/compose.yml up -d api worker ai-worker web
```

AI worker 持有同一 PostgreSQL 会话的 `ai-listing-image-worker` advisory lock，重复启动会退出。收到退出信号后先停止接单，等待在途请求结束，再释放锁并关闭连接池；锁连接失效时立即停止接单、排空后以失败状态退出。Compose 给退出留出 10 分钟；超出后容器可能被强制终止，发布前仍需检查在途任务。不要在同一数据库上混跑仍消费图片任务的旧 API 与新 AI worker。

默认 AI 商品并发 3、实际请求上限 3、本地图片处理并发 1；通道限制与运行时调节仍可能进一步降低实际并发。这是配置上限，没有作负载容量保证。AI worker 容器内存上限 2 GiB，JS 堆上限 512 MiB，给图片 Buffer、Sharp 和 OCR 子进程保留容器内空间；Sharp 为单线程、32 MiB 缓存且无文件缓存，OCR 使用 `OMP_THREAD_LIMIT=1`。堆上限不约束原生内存，发布后仍需观测容器峰值。

AI worker 默认 PostgreSQL 池为 4（包含锁会话），API 与上架 worker 各 10，两个 pg-boss 池各 5，合计 34，不超过当前 PostgreSQL 的 40 连接设置。`AI_WORKER_POSTGRES_POOL_MAX` 只覆盖生产 AI worker；不要随意调大而挤占其他服务与运维连接。独立本机 worker 未设置 `POSTGRES_POOL_MAX` 时也默认 4，API 原默认 10 保留。

回滚前先停止新 AI worker 并等待排空，再按原发布备份恢复匹配的 API/worker/Web 镜像标签；旧 API 可能恢复图片消费，因此不能让新 AI worker 继续运行。保留当前数据库、环境密钥和队列，不以数据库覆盖作为应用回滚方式。本次生产已执行 134、135、136 三个迁移，迁移总数为 136；原有 5 条 AI 任务的状态和正文摘要保持一致。


AI resource admission: Linux samples host memory, CPU and event-loop delay every 5 seconds, and includes container limits when readable cgroup v2 metrics are available. Sustained pressure lowers new product admissions; critical pressure pauses new admissions. Healthy samples raise admission by at most one every 30 seconds, bounded by the saved product-concurrency ceiling (AI_LISTING_CONCURRENCY before the first UI save). In-flight paid results are still saved. Use the settings page to enable or disable adaptive control; AI_LISTING_ADAPTIVE_CONCURRENCY supplies the initial fallback, with macOS off by default. A host upgrade does not change the Compose 2 GiB memory limit. Administrators can now change concurrency ceilings in the UI; changing container memory still requires updating and recreating the container after verifying the larger budget.

Rollback note: if Excel MERGED aliases or unfinished batch grouping already exist, do not start an old consumer that ignores work_phase. Stop consumers and inspect retained tasks before choosing a compatible rollback. Never discard the SKU ledger or overwrite the database as an application rollback.


## 已发布：2026-09-13 AI 并发设置页面

管理员配置新增「AI 并发设置」(`/ozon/settings/ai-runtime-settings`)，提供商品并发、实际 AI 请求、本地图片处理、同计费账号请求上限与自动调节开关。保存到数据库后优先于环境默认值；后台正常时约 5 秒内读取应用，不需要修改环境文件或重新创建容器。页面分别显示已保存配置与后台应用状态，后台停止或心跳过期时不会冒充已生效。

发布时先执行增量迁移 `136_ai_runtime_settings`，再运行匹配版本的 API、AI worker 和 Web。迁移仅新增单行配置/状态表，不改写 AI 任务、SKU 账本或已有图片。未在页面保存过配置时，继续使用现有环境变量默认值。调整数量时保留在途请求和图片处理；降低上限后，等待占用自然下降再领取新工作。

容器/主机内存与 CPU 为只读观测信息，不能通过网页改变 Docker 内存配额。商品/请求/计费组上限范围 1～20、本地图片处理范围 1～2 只是程序支持范围，不代表服务器已经通过这些数值的容量验证。本页配置在当前实例内全站共享，管理员账号和后台 HTTP 均校验权限；页面不处理密钥或任意环境变量。

正式页面：https://www.ozonzongzi.com/ozon/settings/ai-runtime-settings/ 。配置已通过管理员页面保存，保存版本和后台应用版本均为 1，已核对有效商品并发为 3。若回退这一页面，先停止 AI 后台再恢复匹配的 API/worker/Web，保留新增表和业务数据；旧版本只读取环境上限，回退前应把环境默认值核对为已验证的额度。此前商品归组/账本的回滚约束继续适用。


2026-09-13 本次生产备份：`/var/backups/ozon-ai-runtime-20260913-183538`，包含迁移前数据库、匹配环境文件、Compose 和下载校验记录；数据库备份通过 `pg_restore -l` 验证。发布与最终验收记录位于 `/var/tmp/ozon-ai-runtime-20260913/release/deployment-report.json`。相关 Linux 隔离测试 309/309 通过、0 跳过；未发起真实付费生图、上架、库存写入或买家消息。详见 `docs/reports/2026-09-13-ai-runtime-settings-production.md`。

生产页面当前展示主机资源采样（约 7.3 GiB 可见物理内存），AI worker 的 Docker 内存上限仍为 2 GiB；两者含义不同。主机扩容不会自动修改容器限额或已保存并发上限。首次打开若缓存了旧页面，强制刷新后会载入新资源。


## 已发布：2026-09-13 采集助手 1.0.2

当前 Web 为 `ozon-zongzi-web:1.0.0-20260913.collector102`，四个 Windows/Mac 采集助手下载包均为 1.0.2。只更新静态网页与下载；API、上架 worker、AI worker 继续使用 `1.0.0-20260913.ai-runtime1`，容器未重启，无数据库迁移，AI 配置仍为 3/3/1/1 且自动调节开启。浏览器扩展保持 1.0.8。

服务端发布文件与记录在 `/var/tmp/ozon-collector-1.0.2-20260913/release`，私有备份在 `/var/backups/ozon-collector-102-20260913-205754`，包含数据库快照、匹配环境和原 Compose，快照通过 `pg_restore -l`。公网四个下载的版本、长度、HEAD/Range 与文件头通过；完整 SHA 在服务器核对。

Mac Apple 芯片实测商品读取通过，Windows 与 Intel Mac 仍需对应实机验证；不要以打包通过代替实机访问成功。旧 Mac 包的历史清单差异已记录，原文件保持。回退只将 Web 恢复为 `ozon-zongzi-web:1.0.0-20260913.ai-runtime1` 并 `up -d --no-deps web`，保留当前业务数据库和环境文件。详见 `docs/reports/2026-09-13-collector-categories-network.md`。

## 2026-09-13 类目预加载与充值管理

1.0.3 四个桌面下载包已上线，扩展仍为 1.0.8。后台仅更新 API/Web；两个 worker、PostgreSQL、MinIO 的容器身份与启动时间保持。只追加 `137_ai_billing_management`，生产总迁移数 137；费用更正保留原记录和审计。

发布文件位于 `/var/tmp/ozon-collector-103-billing-20260913/release`。首次备份 `/var/backups/ozon-billing103-20260913-232736`，最终切换备份 `/var/backups/ozon-billing103-20260913-233425`，包含数据库、匹配环境及 Compose。首次网页启动检查遇到连接重置，自动恢复旧应用且保留数据库；补充短暂连接错误的就绪等待后，第二次切换成功。

Linux 候选 45 项全通过；公网网页、四个下载包 HEAD/Range、充值页原记录和管理员编辑/明细入口核对通过。原用户余额 10 元、单价 0.20 元、预留 0 元不变，AI 后台在线，保存及应用版本均为 1，并发仍为 3/3/1/1。

回退必须先停稳 API 写入，再检查 `ai_billing_changes`。没有更正记录时可恢复之前 API ai-runtime1 与 Web collector102，并保留数据库追加字段；已有更正记录时保留新版 API 和审计，向前修复。不要恢复旧数据库、重生成密钥或用单一旧 `RELEASE_TAG` 覆盖当前不同服务标签。详细验收见 `docs/reports/2026-09-13-category-preload-billing-management.md`。
