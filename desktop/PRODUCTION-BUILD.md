# 正式客户端打包

当前源码与四个 Windows/Mac 发布包均为 1.0.3，名称 ozon 粽子。扩展 key、Electron appId 保持原值。
生产服务为 https://www.ozonzongzi.com，API 使用同域 /api。
源码运行以及原有打包命令继续使用本机默认地址；生产包从包内配置取得默认地址，不需要用户设置环境变量。

在项目根目录运行，已有依赖即可打包；所有输出指向单独目录：

```sh
node scripts/package-extension.mjs --web-origin https://www.ozonzongzi.com --output-dir /private/tmp/ozon-production-ticfled0/client-downloads
pnpm --dir desktop dist:production:mac --config.directories.output=/private/tmp/ozon-production-ticfled0/client-downloads
pnpm --dir desktop dist:production:win --config.directories.output=/private/tmp/ozon-production-ticfled0/client-downloads
```

扩展只改写暂存副本中的服务地址、品牌地址和授权域名；未传 --web-origin 时保留既有本机打包行为。
桌面通过 electron-builder.production.cjs 的 extraMetadata 写入包内 package.json，再由 runtime.js 读取。
SONLI_API_BASE / SONLI_WEB_BASE 和原有命令行参数仍可覆盖包内默认值。
未配置签名证书时仍为未签名发行包；打包命令禁止自动发布。

将文件加入单独的 Web 构建目录（第三个参数为该目录中的 app，不要指向日常项目）：

```sh
node scripts/publish-desktop-downloads.mjs /private/tmp/ozon-production-ticfled0/client-downloads /path/to/web-build/app
cp '/private/tmp/ozon-production-ticfled0/client-downloads/ozon 粽子-扩展-v1.0.8.zip' /path/to/web-build/app/public/
```

发布脚本复制四个平台文件到 app/public/downloads/collector，并按实际字节生成 app/src/collector-release.json。
扩展版本保持 1.0.8，因此现有 extension-page-contract.mjs 无需修改。文件与清单就位后再构建 Web。
目标域名必须已有可信 HTTPS 证书，并将 /api/ 转发到后端；本打包过程不部署服务。

部分平台单独发布时，必须沿用其他平台实际文件及校验和。每个 artifact 可带独立 `version`，未提供时使用清单版本。现有发布脚本默认生成完整平台清单；仅更新部分平台时需保留其他平台已有的清单及文件，不能用缺少 Mac 的临时清单覆盖生产清单。本次类目与访问修复验收记录见 `../docs/reports/2026-09-13-collector-categories-network.md`；旧 Windows 资料目录兼容规则继续保留。

1.0.3 内置官方分类基线并优先本地加载，后台分类更新失败保留选择；详情见 `../docs/reports/2026-09-13-category-preload-billing-management.md`。四个归档均核对 71 个运行文件和生产地址，ARM Mac 已实际启动并验证分类 IPC；Windows/Intel Mac 尚待实机安装运行。
