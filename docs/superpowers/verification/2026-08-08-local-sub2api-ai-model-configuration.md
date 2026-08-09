# 本地 sub2API 与 AI 模型配置验证记录

验证日期：2026-08-09
验证范围：本地 sub2API 部署、加密连接、模型目录同步与推荐、显式付费能力测试、配置发布、自动上架任务版本冻结、管理页面及旧功能回归。

## 1. 验收结论

- 受控 loopback fake sub2API 端到端链路通过，没有调用真实 AI 上游或 Ozon。
- 本地 Docker 栈通过启动、健康、loopback 端口、停启持久化和隔离停止验证。
- 最终项目门禁通过：`2523` 项测试，`2500` 通过、`0` 失败、`23` 项按 PostgreSQL 专用测试库配置跳过。
- 前端生产构建、扩展上游/UI/diff/ZIP 一致性、主 Compose 插值、语法、测试清单、个人数据与凭据扫描均通过。
- 真实上游 AI 能力和真实 Ozon 上传没有验证。原因是当前没有用户在 sub2API 配置的上游账号/Key，并且本任务禁止擅自产生费用或平台副作用。

## 2. 受控端到端链路

新增测试：`server/tests/auto-listing-ai-settings-e2e.test.mjs`。

测试在进程内启动仅监听随机 `127.0.0.1` 端口的 fake sub2API，并通过实际生产 adapter、AES-256-GCM cipher、凭据 resolver、模型同步 service、设置 service、能力 service 和自动上架 repository 验证：

1. 保存连接 A 时完整网关 Key 被加密，公开 DTO 不返回密文、认证标签或完整 Key。
2. 免费同步只请求 `/v1/models`，同步期间文字和图片 POST 请求数保持不变。
3. 推荐只基于目录元数据产生，仍标记为未验证，不能把模型名称当能力证明。
4. 管理员明确传入费用确认后，fake 能力测试执行结构化文字和一张可解码 PNG 图片探针。
5. 能力证据通过后发布配置 A；随后创建的任务冻结 A 的 profile/version 和 connection/version。
6. 连接 B 重复同步、测试并发布后，新任务使用 B，旧任务仍保留 A 的不可变引用。
7. 日志、审计、领域事件和公开 DTO 扫描不到两个原始 fake Key；日志不含 Authorization/Bearer。

TDD 记录：测试最初因受控持久化夹具的映射、provider identity、SQL 参数位置和过宽秘密字段断言而 RED；逐一对齐稳定 contract 后最终 `1/1` 通过。测试没有伪造真实上游成功。

聚焦 AI 设置、凭据、同步、推荐、网关、运行时和页面回归结果：`329` 项，`328` 通过、`0` 失败、`1` 项 PostgreSQL 专项按配置跳过。该项随后已在当前可执行代码提交对应的一次性 PostgreSQL 16 上补跑并通过，证据见 5.1；它不再只是未映射到当前代码的历史结果。

运维日志边界也完成 TDD：普通 `pnpm sub2api:logs` 不再读取或透传第三方日志，而是只输出 Compose `service/state/health` 白名单摘要。含 `Authorization`、Bearer 值和任意供应商错误文本的夹具均无法进入普通命令输出。只有显式 `pnpm sub2api:logs:raw` 才在高风险警告后把原始日志送到当前终端；原始日志从未被声称可安全自动脱敏。

## 3. Docker 本地 smoke

操作范围始终限定 Compose project `sonli-sub2api-local`，没有启动、停止或删除其他项目。

验证镜像：

- `ghcr.io/wei-shaw/sub2api:0.1.132`
- `postgres:16.8-alpine`
- `redis:7.4.2-alpine`
- Docker Server `29.6.1`

首次启动暴露出真实兼容问题：旧初始化脚本为 TOTP 生成 Base64URL，而固定 sub2API 镜像要求 64 位十六进制，主容器因此重启。修复过程遵循 TDD：

- RED：部署测试要求新 TOTP 为 64 位 hex，原输出不符合。
- GREEN：新秘密直接生成 32 字节 hex；旧脚本生成的规范 32-byte Base64URL 会在 `bootstrap` 时等价转码，并先生成 `0600` 备份。
- 兼容性：PostgreSQL、Redis、管理员和 JWT 密码保持不变；重复 bootstrap 不改写；部署合同扩展后 `13/13` 通过。
- 既有根 `.env`、sub2API `.env`、凭据主密钥及其本地目录若为符号链接或非普通目标，bootstrap 会失败关闭。测试证明不会读取、替换或修改链接目标权限；普通文件通过禁止跟随链接的文件句柄处理。

首次无镜像缓存还证明 `upgrade` 必须拉取整个固定栈。部署合同先 RED，再将显式 `upgrade` 调整为拉取三个固定版本服务；普通 `up` 仍使用 `--pull never`。

实机结果：

- sub2API、PostgreSQL、Redis 三个容器均为 `healthy`。
- `http://127.0.0.1:8080/health` 返回 HTTP `200`。
- `http://127.0.0.1:8080/` 返回 HTTP `200`。
- 只有 sub2API 发布 `127.0.0.1:8080->8080/tcp`；PostgreSQL `5432` 与 Redis `6379` 没有宿主机发布端口。
- 三个容器 label 的 project 均为 `sonli-sub2api-local`。
- 停启前 PostgreSQL system identifier 为 `7671843421623242785`、public 表数 `73`；停启后两项完全相同，证明命名卷持久化。
- 最终执行 `pnpm sub2api:down` 后，该 project 没有运行容器或网络；三个命名卷仍保留，没有执行 `down -v` 或删除卷。

本 smoke 只验证基础设施，不在 sub2API 后台配置上游账号，不进行文字/图片生成或 Ozon 调用。

## 4. 项目门禁与回归

最终 `pnpm verify` 使用：

- 项目已评审上游扩展基准 `0.13.46.1`；
- `QH_LOCAL_NO_DOTENV=1`，避免本地 `.env` 改变测试输入；
- 仅用于 Compose 插值的命令级测试值，没有写入仓库；
- 沙箱外本地 Chrome，使浏览器夹具可以真实启动。

结果：

- App production build：通过，`4842` modules transformed。
- 完整 active suite：`2523` tests，`2500` pass，`0` fail，`23` skip。
- Docker compose interpolation：通过。
- extension source/UI/diff/ZIP parity：通过。
- plugin readiness、采集箱删除持久化、经营店铺隔离、桥接语法、manifest JSON：通过。
- personal data and credential scan：通过。
- 最终输出：`All verification checks passed.`

开发期间完整门禁曾稳定复现三项旧测试夹具回归：

- 路由测试因默认读取 bootstrap 后启用 AI 的 `process.env`，误走真实 AI workflow，错误码 `AUTO_LISTING_AI_WORKFLOW_INVALID`；测试改为显式 `env: {}`。
- 两项 worker 测试在 Task 7 增加凭据主密钥要求后仍使用旧 `enabledEnv`，对外错误码均为 `AUTO_LISTING_AI_RUNTIME_INITIALIZATION_FAILED`；夹具补充测试专用 32-byte Base64URL master key 和 key version。

修复后原组合 `33/33` 通过；相邻 routes/runtime/settings/web 组合 `53/53` 通过。

## 5. 明确未验证范围

### 5.1 PostgreSQL 专项集成

完整门禁运行时的 `23` 项 skip 全部与专用 PostgreSQL 集成数据库有关；门禁没有设置 `AUTO_LISTING_POSTGRES_TESTS=1` 和 `SONLI_MIGRATION_TEST_DATABASE_URL`，因此没有对未知本机数据库执行迁移、并发写入或清理。

为消除聚焦结果中那 `1` 项设置库 skip 与当前代码之间的证据缺口，随后在干净 detached worktree 对提交 `d84492d481cb650c92531864a358cd6440aeb010` 启动 `postgres:16-alpine` 一次性容器。容器只绑定随机 loopback 端口，不挂载命名卷，测试结束后容器自动删除；没有连接本机业务 PostgreSQL，也没有接触 `sonli-sub2api-local` 的数据卷。结果：

- 设置迁移、租约、租户隔离和不可变证据合同：`1/1` 通过、`0` skip。
- 管理发布、连接密文、付费回滚、旧证据隔离和跨账号完整性：`4/4` 通过、`0` skip。
- 阶段上下文、DEAD 恢复、受控重试、Outbox 迁移和并发精确重放：`5/5` 通过、`0` skip。
- 合计：`10/10` 通过、`0` 失败、`0` skip。

该证据覆盖当前功能的关键业务 PostgreSQL 合同，并明确补上聚焦的 `1` 项 skip；它不代表完整门禁其余所有 PostgreSQL 专项都已在真实数据库补跑，也不代表生产数据库通过。正式发布前仍须在可销毁的非生产 PostgreSQL 测试库运行完整 `23` 项专项集合。

### 5.2 真实上游 AI

未验证真实模型列表、真实结构化文字、真实图片生成、真实费用和供应商限流，因为用户尚未在 sub2API 配置上游账号/Key。不得把 fake E2E 记为真实供应商通过。

用户完成上游配置后，验收顺序必须是：免费同步模型 → 管理员确认推荐模型 → 阅读费用提示并显式确认 → 运行一次最低成本能力测试 → 仅通过后发布。真实能力测试可能收费，不能由自动化或代理擅自触发。

### 5.3 真实 Ozon

没有调用真实 Ozon API，也没有上传、修改或删除商品。首次真实业务验收必须保持 REVIEW 模式，由用户审核一条结果；DIRECT 自动上传不属于本次本地模型配置验收。

### 5.4 生产灾备恢复

没有执行生产业务 PostgreSQL、匹配 `credential-master.key`、应用配置以及 sub2API 三个数据卷的完整同恢复点备份/恢复演练。文档已补齐这组一致性恢复合同，但不能把文档审查或本地 PostgreSQL 测试当作生产灾备通过。正式发布前必须在可销毁的非生产副本验证：旧连接可解密、profile/目录/能力与审计证据完整、冻结任务引用不变，并从 REVIEW 模式逐步恢复。

## 6. 回滚与恢复证据

功能异常时：

1. 设置 `AUTO_LISTING_AI_ENABLED=false` 和 `AUTO_LISTING_ENABLED=false`，停止创建新的 AI/自动上架外部工作。
2. 执行 `pnpm sub2api:down`；该命令只操作 `sonli-sub2api-local` 且保留命名卷。
3. 将业务 PostgreSQL 的连接密文、目录、profile、能力/任务/审计证据与匹配 `credential-master.key` 作为同一恢复点成对备份；sub2API 自有 `.env` 与三个卷属于同一完整恢复集。
4. 保留加法迁移、连接版本、目录、能力尝试、任务事件和审计，禁止删证据伪造成功。
5. 如需回退应用提交，保留数据库兼容结构；恢复时先在 REVIEW 模式验证上一正式 profile 与凭据，再逐步启用。
6. 主密钥丢失时保留旧密文和证据，创建并验证新连接供新任务使用；不把密文改成明文，也不伪造旧连接成功。

详细操作、备份、升级和生产替换规则见 `docs/architecture/local-sub2api-operations.md`。
