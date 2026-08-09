# 本地 sub2API 与 AI 模型配置运维说明

日期：2026-08-09

适用范围：`ozon 粽子` 的本地自动上架 AI 网关。它只服务 AI 模型同步、能力测试和自动上架生成，不替代业务 PostgreSQL、MinIO、Ozon 店铺凭据或浏览器扩展。

## 1. 边界与本地地址

- sub2API 管理后台：`http://127.0.0.1:8080/`
- sub2API 网关地址：`http://127.0.0.1:8080/v1`
- `ozon 粽子` Web：`http://127.0.0.1:3000/`
- AI 模型配置页：`http://127.0.0.1:3000/ozon/tools/auto-listing/ai-settings`
- Compose 项目名固定为 `sonli-sub2api-local`。
- sub2API、PostgreSQL 和 Redis 使用独立网络及独立数据卷，不复用 `ozon 粽子` 的数据库、Redis、MinIO 或密钥。
- 唯一对宿主机发布的 sub2API 端口默认绑定 `127.0.0.1:8080`；PostgreSQL 和 Redis 不发布宿主机端口。
- Web 服务不挂载 Docker socket，也不能从页面启动或停止容器。

## 2. 首次初始化

在项目根目录执行：

```bash
pnpm sub2api:bootstrap
```

初始化会以“文件不存在时才创建”的方式生成：

- `server-data/sub2api-local/.env`：sub2API 管理员、PostgreSQL、Redis、JWT 和 TOTP 本地秘密，权限 `0600`。
- `server-data/sub2api-local/credential-master.key`：`ozon 粽子` 加密网关 Key 的 32 字节主密钥，权限 `0600`。
- 项目根目录 `.env` 中由脚本拥有的本地自动上架配置，权限 `0600`。

`server-data/`、`.env` 和自动备份文件都已被 Git 忽略。初始化不会旋转已有秘密；如根目录 `.env` 中同名配置与本地安全值冲突，命令会停止并要求人工处理。首次修改已有 `.env` 前会生成 `.env.sub2api-local-*.bak` 备份。

初始化只接受普通文件。根目录 `.env`、sub2API `.env` 或 `credential-master.key` 如果是符号链接、目录、管道、设备等非普通文件，命令会停止，不会读取链接目标、替换目标或修改目标权限。已有普通文件通过禁止跟随符号链接的文件句柄读取和改权。

旧开发版本曾把 sub2API TOTP 密钥写成 32 字节 Base64URL。固定镜像 `0.1.132` 要求同一密钥使用 64 位十六进制表示；再次执行 `bootstrap` 会先生成权限为 `0600` 的栈环境备份，再做等价转码。该兼容迁移不改变原始 32 字节密钥，也不轮换 PostgreSQL、Redis、管理员或 JWT 密码；重复执行不会再次改写。

查看本地 sub2API 管理员账号：

```bash
pnpm sub2api:credentials
```

该命令会把管理员邮箱和密码显示在当前终端。不要截屏、转发、重定向到文件或粘贴到问题单/日志中。

## 3. 启动、状态、日志与停止

首次安装或明确升级时执行：

```bash
pnpm sub2api:upgrade
```

该命令显式拉取 Compose 中三个固定版本镜像，然后启动服务。普通启动不会联网拉取；镜像已安装后使用：

```bash
pnpm sub2api:up
pnpm sub2api:status
pnpm sub2api:logs
pnpm sub2api:down
```

- `upgrade` 只拉取 Compose 中固定的 sub2API、PostgreSQL 和 Redis 版本；任一拉取失败就停止，不会用半套未验证镜像启动。
- `up` 只启动已经安装的固定镜像，普通启动不会拉取 `latest` 或隐式升级。
- `status` 只查看 `sonli-sub2api-local` 项目。
- `logs` 不读取第三方原始日志，只根据 Compose 状态输出 `sub2api`、`postgres`、`redis` 的服务名、运行状态和健康状态白名单摘要。未知字段与自由文本一律丢弃，因此这个普通命令可以用于日常排查。
- `down` 只停止并移除 `sonli-sub2api-local` 的容器和网络，不加 `--volumes`，因此保留数据库和 Redis 数据。

供应商自由文本无法可靠自动脱敏。只有必须调查供应商内部错误时，才显式执行：

```bash
pnpm sub2api:logs:raw
```

该高风险命令会先警告，再把 sub2API 原始日志直接送到当前终端；它不会默认写文件，但 shell 重定向仍可能落盘。原始日志可能包含网关 Key、授权头、主密钥、提示词或上游响应，不能截屏、复制、重定向、粘贴到聊天/问题单，也不能声称“已脱敏”。按 `Ctrl+C` 只停止跟随，不停止容器。

## 4. sub2API 后台与 Web 配置顺序

1. 打开 `http://127.0.0.1:8080/`，使用 `pnpm sub2api:credentials` 显示的本地管理员登录。
2. 在 sub2API 后台配置上游 AI 账号或供应商 API Key。
3. 在 sub2API 中创建一个仅供 `ozon 粽子` 使用的网关 Key。
4. 打开 Web 的 `AI 工具 → 自动上架 → AI 模型配置`。
5. 填写网关地址 `http://127.0.0.1:8080/v1` 和新网关 Key，保存后完整 Key 不可回看。
6. 点击同步模型。同步只读取 `/v1/models`，不会调用文字生成或图片生成接口，不应产生模型生成费用。
7. 查看系统推荐依据，管理员确认文字模型和图片模型。同步结果仍是“待验证”，不能仅凭模型名称当作可用证明。
8. 阅读费用提示并明确确认后，运行一次能力测试。该操作会进行一次固定结构化文字测试和一张最低成本图片测试，可能产生少量上游费用。
9. 只有结构化文字、图片生成和图片解码均通过后才发布配置。
10. 新建自动上架任务冻结当时的配置、模型和连接版本；后续换 Key 或换模型只影响新任务。

推荐与能力测试是不同边界：推荐只使用模型目录元数据，不收费；能力测试会调用模型，必须由管理员显式确认费用。

## 5. 日常同步和故障行为

- 首次连接后可手动同步；后台对符合条件的连接每 24 小时安排一次目录同步。
- 同一账号、同一连接版本的重复同步意图复用任务，不创建重复副作用。
- 一次同步失败会保留上一次正式配置和成功目录，不会自动停用当前模型。
- 成功同步明确证明已发布模型不存在时，只阻止创建新的自动上架任务；旧任务继续使用其冻结版本。
- sub2API 不可用时，AI 模型配置与新的 AI 自动上架会失败闭合；登录、采集箱、店铺、商品、订单和浏览器扩展不应受影响。

常见安全错误：

| 安全错误码 | 大白话含义 | 处理方式 |
| --- | --- | --- |
| `AI_GATEWAY_SECRET_MISSING` | 网关 Key 不存在、不能解密或已失效 | 在 sub2API 创建新 Key，并在 Web 保存新连接；不要尝试读取旧 Key |
| `NON_RETRYABLE_AUTH` | sub2API 或上游拒绝鉴权 | 检查上游账号和网关 Key，修复后创建新连接版本 |
| `GATEWAY_TIMEOUT` / `RETRYABLE_GATEWAY` | 网关暂时无响应 | 查看 `pnpm sub2api:status` 和安全日志，稍后按原意图重试 |
| `AUTO_LISTING_AI_ACTIVE_MODEL_UNAVAILABLE` | 最新成功目录中找不到已发布模型 | 重新选择、能力测试并发布；不要修改旧任务 |
| `AUTO_LISTING_AI_SETTINGS_COST_CONFIRMATION_REQUIRED` | 未明确同意可能产生的少量费用 | 确认费用提示后再运行能力测试 |
| `AI_GATEWAY_CAPABILITY_RESULT_UNKNOWN` | 请求可能已发送，但结果证据不完整 | 不要盲目重复付费测试，先查看任务/审计状态再恢复 |
| `AUTO_LISTING_AI_PROFILE_VERSION_CONFLICT` | 页面基于旧版本提交 | 刷新概览，确认当前版本后重新操作 |

页面和接口只显示安全错误码及可公开说明，不展示上游原始错误体。

## 6. 备份和恢复

### 6.1 完整恢复集

完整恢复不是只备份 sub2API。停写后必须把以下内容作为同一个有编号、有时间点的恢复集：

1. `server-data/sub2api-local/.env`：sub2API 自有 PostgreSQL、Redis、管理员、JWT、TOTP 秘密。
2. Compose 项目 `sonli-sub2api-local` 的三个命名卷：sub2API 应用数据、sub2API PostgreSQL、sub2API Redis。
3. `ozon 粽子` **业务 PostgreSQL** 的一致性备份。它包含 `ai_gateway_connection_versions.ciphertext`、连接/目录/推荐、能力尝试与付费子调用证据、正式 profile、审计事件、冻结到任务的版本引用等业务事实。
4. 与第 3 项业务数据库密文匹配的 `server-data/sub2api-local/credential-master.key`，以及选择该密钥版本和业务数据库连接的应用配置。业务 PostgreSQL 与这个主密钥必须成对备份、成对恢复。

先停止新外部工作和所有业务写入，再停止本地栈：

```bash
# 先将 AUTO_LISTING_AI_ENABLED=false、AUTO_LISTING_ENABLED=false 并重启应用，
# 再停止 API、listing worker 与 auto-listing AI worker。
pnpm sub2api:down
docker volume ls --filter label=com.docker.compose.project=sonli-sub2api-local
```

业务 PostgreSQL 必须使用组织批准的事务一致逻辑备份或停库物理快照；不能只导出密文表而漏掉审计、目录、profile、任务版本引用及数据库约束。将秘密文件复制到受访问控制、加密的备份位置，并保持仅备份管理员可读。命名卷使用组织批准的 Docker volume 备份工具逐卷导出。为恢复集记录时间、应用提交、迁移版本、业务 PostgreSQL 备份标识、sub2API 固定镜像版本和主密钥版本，但不能记录秘密值。备份不得进入项目目录、Git、聊天或普通网盘。

### 6.2 恢复顺序

1. 保持 API、两个 worker 和本地 sub2API 栈停止，禁止恢复期间创建新任务或外部调用。
2. 恢复同一恢复集中的应用配置、原 `credential-master.key` 和**业务 PostgreSQL**；目录权限设为 `0700`、秘密文件权限设为 `0600`。不要把其他日期的主密钥与该业务数据库拼接。
3. 恢复原 `server-data/sub2api-local/.env`，再把三个 sub2API 数据卷恢复到同名 `sonli-sub2api-local` 项目卷。
4. 执行 `pnpm sub2api:up` 和 `pnpm sub2api:status`；先只启动业务 API 的只读检查路径，不启动 worker 或 DIRECT 上传。
5. 确认迁移版本、正式 profile、连接版本、目录、能力尝试、审计与冻结任务引用都存在；使用匹配主密钥验证已有连接能解密。任一项不一致就保持失败关闭，不删除证据、不发布模型。
6. 登录 sub2API 后台确认上游账号仍存在，再在 Web 执行免费模型同步；需要付费的能力测试仍须管理员重新明确确认。不要仅凭容器健康状态发布模型。
7. 先启用 REVIEW 并验证一条新任务，再逐步恢复 worker；DIRECT 不属于本地恢复验收。

只恢复 sub2API 数据卷不能恢复 `ozon 粽子` 的连接、审计和任务证据；只恢复业务 PostgreSQL而没有匹配主密钥，也无法解密旧网关 Key。主密钥丢失时，应保留原密文与审计，创建并验证一个新连接供新任务使用，不能把旧密文改成明文或伪造旧连接成功。

本说明定义了恢复合同，但本次本地验收**没有执行生产业务 PostgreSQL + 主密钥 + sub2API 三卷的完整灾备恢复演练**；正式发布前必须在可销毁的非生产副本执行并记录恢复点、解密检查和证据完整性结果。

## 7. 升级

升级只能显式执行：

```bash
pnpm sub2api:upgrade
```

当前命令拉取 Compose 中固定的 sub2API `0.1.132`、PostgreSQL `16.8-alpine` 和 Redis `7.4.2-alpine`，然后重建服务。修改任一固定版本前必须：

1. 完成第 6 节的完整恢复集：业务 PostgreSQL 与主密钥成对备份，并备份 sub2API 秘密文件和三个数据卷。
2. 阅读目标版本迁移说明，并在非生产副本验证数据库兼容性。
3. 更新固定镜像版本及部署合同测试，禁止改为 `latest`。
4. 运行完整测试、健康检查和“同步不收费”验证。
5. 失败时恢复原固定镜像与备份卷；不得删除审计或配置历史来伪造成功。

## 8. 生产替换规则

本地配置不能原样用于生产：

- 使用独立受管 sub2API 主机和 HTTPS 地址；只把明确地址/来源加入网关允许列表。
- 生产必须关闭 `AUTO_LISTING_AI_ALLOW_LOCAL_GATEWAY`，不得允许 localhost、私网或不受控重定向。
- 生产主密钥使用服务器环境秘密或只读挂载的密钥文件；不得使用仓库文件、示例值或开发回退。
- sub2API 的 PostgreSQL、Redis、管理员密码、JWT、TOTP 和上游凭据由生产密钥管理及备份制度负责。
- 业务后端是唯一持有下游网关 Key 的调用方；浏览器不得直接调用 sub2API。
- 先以 REVIEW 模式完成一条人工验收，不在本验收中开启 DIRECT 自动上传。

## 9. 回滚与恢复

出现重要异常时按以下顺序处理：

1. 设置 `AUTO_LISTING_AI_ENABLED=false` 和 `AUTO_LISTING_ENABLED=false`，重启应用，使 AI 配置运行时和自动上架运行时停止创建新外部工作。
2. 执行 `pnpm sub2api:down`，只停止 `sonli-sub2api-local` 项目，不删除卷。
3. 对业务 PostgreSQL 与匹配主密钥制作同一恢复点备份；保留追加式数据库迁移、连接版本、能力尝试、任务事件和审计，不要删除或改写不可变证据行。
4. 如上一正式配置的凭据仍有效，先重新同步并运行明确确认费用的能力测试，再通过安全回退流程重新启用。
5. 必要时回退应用提交，但保留新增表和历史数据，后续通过兼容迁移继续处理；不要执行破坏性数据库回滚。

恢复功能时先启用 `AUTO_LISTING_ENABLED` 的 REVIEW 流程并完成验证，再启用 AI；DIRECT 上传不属于本地能力验收范围。
