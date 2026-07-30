# Final delivery correction report

日期：2026-07-30

整改基线：`5b89d60943e6b923490275172887ec2d4476956a`

当前运行时、contract 与交付包提交：`e7d55e4e639874524500302146bcef896cfa74de`

## 结果

终审三项 finding 已关闭：

1. 验证记录不再把旧产品基线、后续 contract/包提交和文档提交混为同一个 SHA。完整 hermetic suite 明确归属 `32611daa717c54761a973fe962e1c4365eaf4a13`；当前增量聚焦验证明确归属 `e7d55e4e639874524500302146bcef896cfa74de`；后续仅文档提交不声明自身 SHA。
2. 根 `design-qa.md` 在第一行前置醒目 WARNING，明确全文是选品/水印移除前历史证据，并链接当前验证记录。旧 “Current Build”、选品和水印断言不能再被误读为当前行为。
3. `ozon-data-panel.js` 不再声称选品模式仍由 `ozon-search.js` 持有；注释只描述搜索页与其他页面的数据面板、采集器和关键词导航职责。

采集、数据面板、店铺选择、商品与 AI 保留能力未删除。新增正向 contract 锁定搜索页和其他页面仍含 `collect-one` 与 `jzRenderProductCardPanel` 入口。

## TDD 证据

先扩展 `extension/tests/removed-selection-watermark-contract.test.js`：

- 精确要求 `ozon-data-panel.js` 不含陈旧短语“选品模式”；
- 同时要求 `ozon-search.js` 与 `ozon-data-panel.js` 保留采集和面板渲染入口。

RED：Codex 内置 Node `v24.14.0` 运行 contract，退出 1，精确失败于 `assert(!dataPanel.includes("选品模式"))`。

GREEN：仅修正 `extension/content/ozon-data-panel.js` 两处职责说明后，同一 runner 退出 0；随后 collector session 19/19、collector removal runner、popup Collector runtime runner 均通过。

## 文件与 contract

运行时/测试/派生物提交 `e7d55e4`：

- `extension/content/ozon-data-panel.js`
- `extension/tests/removed-selection-watermark-contract.test.js`
- `app/public/sonli-extension-0.13.46.1/content/ozon-data-panel.js`
- `app/public/sonli-extension-0.13.46.1/tests/removed-selection-watermark-contract.test.js`
- `app/public/sonli-extension-0.13.46.1.zip`

最终文档提交：

- `docs/superpowers/verification/2026-07-30-remove-selection-watermark.md`
- `design-qa.md`
- `.superpowers/sdd/2026-07-30-remove-selection-watermark/final-delivery-correction-report.md`

未修改 ledger。

## 机械重建与一致性

运行 `scripts/package-extension.mjs` 从 `extension/` 机械重建：

- `app/public/sonli-extension-0.13.46.1/`
- `app/public/sonli-extension-0.13.46.1.zip`
- `app/dist/sonli-extension-0.13.46.1.zip`

public ZIP 与 dist ZIP 的 SHA-256 均为：

`a933152eb008f0fa4e2af38f46dbfa71184fcfaf32f7f0ef316e146f6deffe27`

两个 ZIP 自身逐字节相同。ZIP parity 对 104 个文件逐项通过；source parity 也确认 `extension/` 与 tracked public 解压树一致。`app/dist/` 是仓库忽略目录，因此 dist ZIP 已在工作区重建和验证，但不进入 Git 提交。

## 聚焦验证

- 移除/UI/后端/UI mutation：6 tests，6 pass，0 fail，0 skip。
- 退役能力 negative contract：退出 0。
- Collector session：19/19 pass。
- Collector removal、一键采集守卫：退出 0。
- Popup Collector-session runtime：退出 0。
- Extension source parity：退出 0。
- Extension UI parity：退出 0。
- Extension capture-only diff contract：退出 0。
- ZIP parity：public/dist 各 104 文件，退出 0。
- 两份 ZIP smoke：每份 Collector 19/19、capture-only 7/7，所有 runner 退出 0。
- Plugin readiness：capture-only 7/7、Web plugin-surface 3/3。
- 陈旧“选品模式”短语扫描：source/public data panel 均无命中。
- Residual scan：仅命中 follow-sell 兼容字段剥离和 server 历史状态字段剥离，均为已审查防御性兼容，不是活动能力。
- `scripts/check-personal-data.mjs`：通过。
- `git diff --check`：通过。

一次未设置 `QH_SOURCE_EXTENSION_DIR` 的 UI mutation 测试预调用按 contract 拒绝启动该覆盖项；补上固定上游目录 `/Users/songliang/Desktop/0.13.46.1` 后，完整 6/6 聚焦测试通过。这是验证环境前置条件，不是产品失败。

## 完整验证边界、风险与未验证范围

本轮没有冒充重新执行完整 hermetic `scripts/verify.mjs`。该完整 suite 的精确证据仍属于 `32611daa717c54761a973fe962e1c4365eaf4a13`；`e7d55e4` 之后的增量由上述聚焦门禁、ZIP smoke、readiness、残留和敏感数据扫描覆盖。

未手工安装 ZIP 到用户 Chrome，未调用真实 Ozon/1688 写操作或 AI 付费接口，未重跑需要专用 disposable PostgreSQL URL 的 account-scoped integration。当前改动只涉及注释、contract 和机械派生包，主要回归风险是打包漂移；source/public/两份 ZIP parity 与 packaged smoke 已覆盖该风险。

## 回滚

验证记录提供固定运行时头的完整安全范围流程：`37b01ce..e7d55e4` 共 21 个提交，由 `git rev-list --topo-order` 生成真正新到旧顺序，再交给单次 `git revert --no-commit` sequencer。冲突时可 `git revert --abort` 回到开始前状态；禁止跳过提交或使用 `reset --hard`。恢复源码后必须重新执行 package、source/UI/diff/ZIP/smoke/readiness 与完整验证。
