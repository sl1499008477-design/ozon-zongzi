# 最小生产配置种子

已批准范围：只读现有源库，导出主店、当前 AI 通道和保存配置；导入时复用服务器首次正常登录持久化的唯一 admin 和已有生产密钥。不创建管理员、不改密码、不覆盖 production.env，不调用 Ozon、AI、对象存储或消息服务。

## 本次源数据结论

源库审查：钱包/任务费用预留/充值扣费账本各 0；消息记录 0（包含已发送、待发送与结果不明）；商品手工成本、订单采购成本与商家促销底价为 0。主店 1,565 条订单、其中 725 条含财务快照，以及 56 条 AI 请求回执是需要留档的真实源记录，不能按“测试”删除。本次只将有采购成本的订单纳入种子；其余订单和消费回执继续保留在已做的 custom dump。导出再次在同一只读事务内检查资金和消息记录，任何一项非零会停止，不擅自清零。

## 导出（本机）

```sh
node scripts/deploy-seed.mjs export \
  --source-env /private/tmp/ozon-production-ticfled0/backup/local.env \
  --source-ai-key-file /private/tmp/ozon-production-ticfled0/backup/credential-master.key \
  --out /private/tmp/ozon-production-ticfled0/seed \
  --store-label sl-主店
```

输出目录须预先创建为 0700。输出 `seed-source.json`、`seed-transport.key`、`seed-report.json` 均以排他创建方式写入，权限 0600；已存在文件或符号链接会拒绝覆盖。重复导出需使用新的私有目录。不会读写生产 env，也不会连接目标数据库。

源店铺/AI 凭据在内存解密后，用独立的传输密钥重新封装；源文件中没有 API Key 明文，也不保存源主密钥。旧消息 webhook token 和运行状态、通道健康/租约信息不导出。所有运行中的功能只会在目标关闭状态下重建。

## 目标 dry-run / 导入

服务器发布目录 `/opt/ozon 粽子/releases/1.0.0-20260911`；API 容器 `ozon-zongzi-api-1` 的应用工作目录为 `/srv/sonli`。先用现有生产 env 正常 `POST /local/accounts/login` 完成首次账号持久化；health 不会创建 admin。已成功登录后无需再次初始化。seed 不发起登录，不生成密码或生产密钥。

最终文件包 `seed-runtime.tar.gz` 内为 `seed/` 目录。服务器上传并在私有临时目录解包后，按以下命令复制文件（若容器运行用户不是 root，私有文件须归该运行用户所有）。不把本机源 env、源主密钥或整个备份上传为 seed：

```sh
cd /root/ozon-production-seed-20260911
umask 077
tar -xzf seed-runtime.tar.gz
docker exec -w /srv/sonli ozon-zongzi-api-1 test -d /srv/sonli/scripts
docker cp seed/deploy-seed.mjs ozon-zongzi-api-1:/srv/sonli/scripts/deploy-seed.mjs
docker cp seed ozon-zongzi-api-1:/tmp/ozon-seed

docker exec -w /srv/sonli ozon-zongzi-api-1 node scripts/deploy-seed.mjs dry-run \
  --bundle /tmp/ozon-seed/seed-source.json \
  --target-env process --expect-database ozon_production

docker exec -w /srv/sonli ozon-zongzi-api-1 node scripts/deploy-seed.mjs import \
  --bundle /tmp/ozon-seed/seed-source.json \
  --target-env process --expect-database ozon_production
```

仅在 dry-run 返回 `ok:true, mode:DRY_RUN` 后运行 import。`--target-env process` 显式使用容器已有生产环境；也可传实际已存在的私有生产 env 文件路径。不会加载项目默认 `.env`。`--transport-key-file` 可指定独立路径，默认读源文件同目录的 `seed-transport.key`。dry-run 使用只读事务，核对账号、表范围、迁移、配置字段和加密转换，不执行 INSERT/UPDATE/锁表；实际写入及约束检查由 import 的单事务完成。

目标必须已应用源库记录的迁移，仅包含 bootstrap 的唯一 active admin、该 admin 成功 web 登录的 sessions/audit_events 和 local_state 镜像、迁移 075 的账号默认策略设置及事件各 1 条，以及生产 env 中 `PG_BOSS_SCHEMA` 指定队列 schema 的 queue/version 基础元数据。目标数据库名称必须精确等于 `ozon_production`。默认策略须为 LEGACY_FALLBACK/version=1，事件须为 ACCOUNT_SETTINGS_CHANGED/settings_version=1，且账号、actor 和 bootstrap 幂等键与该 admin 一致。已有店铺、其他账号、其他审计、改过的策略、钱包、消息、历史任务、队列作业或其他业务记录都会导致拒绝；不覆盖服务器另一个旧 PostgreSQL。若启动过程已生成其他默认配置，脚本也会安全拒绝，需要先核实这些记录，不能为了通过检查清空数据库。

导入在一个事务内执行：检查与锁定目标 → 找到现有 admin 和状态版本 → 验证迁移 → 用生产密钥按目标 admin/新通道 ID 重加密 → 店铺/仓库和必要成本父记录 → 更新初始 local_state → AI 档案/通道 → 提示词再图片配置 → 定价父版本、规则、官方文件引用和完整类目映射 → 禁售 → 消息/活动配置 → 成本。原 admin 关系表、密码 hash、sessions、audit_events 及两张类目初始化表不被改写；local_state.sessions/token/auditEvents 原样保留。失败回滚；再次运行会因目标已存在业务数据而拒绝，不重复导入。

## 加密合同和保留范围

- 店铺：`crypto-secrets.mjs` 的 AES-256-GCM，密钥为 SHA-256(APP_ENCRYPTION_KEY)，无账号 AAD；同时重建 store_credentials、local_state 中的密文，移除 stores.raw 中旧密文副本。key_version 是标签，不是自动轮换密钥环。
- AI：复用 `createAutoListingCredentialCipher`，AAD 包含 purpose、accountId、connectionId、connectionVersion、keyVersion。导入按已有 admin 和新通道 ID、版本 1 重新加密并重算 HMAC 指纹。使用 production.env 的 `AUTO_LISTING_CREDENTIAL_MASTER_KEY` 或 `_FILE`，以及 KEY_VERSION；不生成替代生产密钥。
- 现有 admin：保留 bootstrap ID、密码 salt/hash/算法与本次生产会话；源账号、密码及会话不迁移。
- 2 个 AI 通道导入为 enabled=false，所有检查结果、失败计数、冷却、租约和使用时间重置。重新启用前需按现有能力检查流程确认，源库的 PENDING_REVIEW/REVIEW_FAILED 不能冒充通过。
- 主店消息及模板 disabled；创建新 webhook token，旧回调地址不自动沿用。主店活动 enabled/exitEnabled/protectPrices=false，规则 disabled，无 next_run；成本 auto_apply=false。禁售规则保持原 action/enabled，不能把保护规则关闭。
- 主店 4 个消息模板、1 套活动设置和 1 条活动规则；2 条 AI 预设（提示词/图片配置）；禁售 8 条；定价当前版本和已保存草稿 2 个、佣金规则 723、物流 14、官方导入 2、类目映射 21,590。普通 createPricingDraft 克隆不足以恢复官方映射，因此这些关系表一并迁移。
- 图片配置保留参数，但 manualReview=true、autoSwitchStores=false，移除备用店。原测试店仓库不会绑定到主店；targetWarehouseId 留空，须在页面选主店仓库后才能创建任务。主店缓存的 RFBS 仓库均标记 disabled，不能擅自恢复启用。
- 旧 auto_listing_preferences 有店铺/仓库复合外键，不能填空或串到测试店。其 1 份参数与旧当前类目策略 1 版/10 条规则放在seed-source.json 的 source.legacy 内留存，不自动激活或恢复采样/分析历史。
- `orders` 仅迁有 purchase_costs 的记录及其 order_items；商品成本/底价涉及的 products 才随之保留。保留外部 product_id、SKU、offer_id、posting_number、币种和精确金额，不用新充值伪造期初账目。

本次不迁测试上架任务、旧账号会话、collector 票据/会话、pg-boss 作业、outbox、自动恢复/清理任务、核价历史或钱包。源库成功 Ozon 提交仍是实际外部副作用：保留旧备份中的 import task ID、offer/product/SKU、库存回执和幂等关联，不向生产重新提交。

公开图片 URL、106 条旧发布对象引用、AI 提交图片以及两个官方佣金原文件的 bucket/key/hash 不能随着换数据库或账号被清理。脚本只保留官方文件引用，没有下载/搬运任何对象，也没有改写原图片 backend/www 地址；部署方需保持对应文件/公网地址可用。消息记录目前为零，但以后如有 SENT/UNCERTAIN，不能丢弃去重与外部消息关联。

## 验证与限制

```sh
node --test scripts/deploy-seed.test.mjs
```

定向测试覆盖生产加密函数互通、账号 AAD 变化、保持 bootstrap 密码/登录/审计/默认类目初始化记录、真实资金/消息保护、官方映射与精确成本、关闭自动行为、非空目标拒绝、0600/排他写和生产 env 不被覆盖。2026-09-11 已完成真实源导出、生产目标 dry-run、导入事务和配置读回。已验证正式登录、店铺隔离、只读平台同步、通道模型目录连接及 Linux OCR/切片；未执行付费 AI 生图、Ozon 商品提交、库存/活动写入或买家消息发送。当前目标库已有正式同步资料，不得再次运行 seed 导入。部署详情见 `../deploy/production/README.md`。

部署预检发现源库保留 `014_dynamic_fx_probes` 旧编号记录，而现行源码为 `015_dynamic_fx_probes.sql`。仅在目标已应用 `015_dynamic_fx_probes` 时允许该旧编号；其他迁移缺失仍拒绝，不伪造或删除数据库迁移记录。

部署切换补充：实际上线时，为保持 Ozon 已登记回调 URL，单独将目标消息 token 与现有中转入口对齐；仅把应用目标改为服务器 38303，原 ERP 目标与中转账本保留。这是部署步骤，不是 seed 的默认行为。
