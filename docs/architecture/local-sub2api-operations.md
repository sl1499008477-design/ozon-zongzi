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
- `logs` 只跟随 sub2API 容器日志。日志中不应出现网关 Key、授权头、主密钥、原始提示词或上游原始响应体。
- `down` 只停止并移除 `sonli-sub2api-local` 的容器和网络，不加 `--volumes`，因此保留数据库和 Redis 数据。

如需停止日志跟随，按 `Ctrl+C`；这不会停止容器。

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

### 6.1 备份范围

停写后备份以下三类内容：

1. `server-data/sub2api-local/.env`
2. `server-data/sub2api-local/credential-master.key`
3. Compose 项目 `sonli-sub2api-local` 的三个命名卷：sub2API 数据、PostgreSQL 数据、Redis 数据

先停止本地栈，避免数据库备份处于不一致状态：

```bash
pnpm sub2api:down
docker volume ls --filter label=com.docker.compose.project=sonli-sub2api-local
```

将两个秘密文件复制到受访问控制、加密的备份位置，并保持仅备份管理员可读。命名卷应使用组织批准的 Docker volume 备份工具逐卷导出；备份文件不得进入项目目录、Git、聊天或普通网盘。

### 6.2 恢复顺序

1. 保持本地栈停止。
2. 恢复原 `server-data/sub2api-local/.env` 和 `credential-master.key`，并把目录权限设为 `0700`、文件权限设为 `0600`。
3. 将三个数据卷恢复到同名 `sonli-sub2api-local` 项目卷。
4. 执行 `pnpm sub2api:up` 和 `pnpm sub2api:status`。
5. 登录后台确认上游账号仍存在，再在 Web 测试连接；不要仅凭容器健康状态发布模型。

主密钥与业务数据库中的密文必须成对恢复。丢失或替换 `credential-master.key` 后，旧网关 Key 无法解密，正确恢复方式是创建并验证一个新连接，而不是把密文改成明文。

## 7. 升级

升级只能显式执行：

```bash
pnpm sub2api:upgrade
```

当前命令拉取 Compose 中固定的 sub2API `0.1.132`、PostgreSQL `16.8-alpine` 和 Redis `7.4.2-alpine`，然后重建服务。修改任一固定版本前必须：

1. 完成秘密文件和三个数据卷备份。
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
3. 保留追加式数据库迁移、连接版本、能力尝试、任务事件和审计；不要删除或改写不可变证据行。
4. 如上一正式配置的凭据仍有效，先重新同步并运行明确确认费用的能力测试，再通过安全回退流程重新启用。
5. 必要时回退应用提交，但保留新增表和历史数据，后续通过兼容迁移继续处理；不要执行破坏性数据库回滚。

恢复功能时先启用 `AUTO_LISTING_ENABLED` 的 REVIEW 流程并完成验证，再启用 AI；DIRECT 上传不属于本地能力验收范围。
