# 线上正式版快照 — 2026-09-29

此目录以运行中的生产容器逐文件 SHA-256 为准。API、AI worker、普通 worker 使用不同的历史镜像，不能用一套最新本机代码代替三个服务。

- 根目录 `server/`、`shared/` 保存正式 API 代码。
- `overlays/<role>/` 保存相对根源码的角色差异，包括旧 worker 的代码和后端嵌入的扩展版本标识。
- `app/production/` 是线上正在提供的 Web HTML、JS、CSS 和共用静态资源。`app/src/` 是同步业务调整后的维护源码，已验证可构建；重新构建的字节与历史发布包不同，不能将其当作此快照的原发布包。
- `extension/` 对应线上发布的扩展 1.0.28。
- 采集助手版本与来源见 `manifest.json` 和 `app/src/collector-release.json`。
- `manifest.json` 记录读取时的镜像标识和文件校验值。环境变量、数据库、生成结果和商户资料均不属于代码快照。

验证任一服务的代码：

```sh
node deploy/production/snapshot/materialize.mjs api
node deploy/production/snapshot/materialize.mjs ai-worker
node deploy/production/snapshot/materialize.mjs worker
node deploy/production/snapshot/materialize.mjs web
```

可传入一个不存在的输出目录，导出该角色的精确代码文件集合。例如：

```sh
node deploy/production/snapshot/materialize.mjs worker /tmp/ozon-worker-source
```

导出的是应用代码，不包括 node_modules、操作系统组件、服务密钥或业务数据。重建系统依赖时使用根目录锁文件；既有正式镜像标识是部署与回滚的依据。此提交不触发服务器部署，也不修改线上数据。

本次对应正式版本 `20260928.deleted-all`（API、AI worker、Web）和 `20260928.variant-ready-ru`（普通 worker）。正式版继续使用迁移154；不要重建或回退业务数据库。原服务器各版本回滚入口保持。

## 本次同步验证

API 437、AI worker 429、普通 worker 402份运行文件逐一核对SHA-256；Web 22份发布文件、扩展85份文件全部核对。采集助手从当前公网1.0.29 mac-arm64安装包提取85份应用文件，并校验安装包SHA-256为 `93236fc5ff5e6eab5e002b6ec178f4504842f0d077231b8942df6f7b5ffe5197`。不将Electron、node_modules和FFmpeg二进制入库，其发布来源与清单位于现有版本文件中。

相关后端135项测试通过；维护用Web源码构建通过。此前正式发布已完成实际健康和回滚检查。本次是代码同步，没有重新触发采集、生图、Ozon上架或生产部署。未重新执行Windows/Intel原生安装验收。

部分生产原文件带有尾部空行，为保持哈希相同而原样保留。必要依赖通过锁文件和既有发布依赖配置管理。
