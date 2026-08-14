# 自动上架配置驱动固定骨架与规划诊断验证记录

## 验证对象

- 生产实现 SHA：`25f4f4cc528fa36a3083ee58a1ce5aad9661f46e`
- 分支：`codex/auto-listing-configurable-skeleton`
- 数据库迁移范围：`001`～`074`
- 验证日期：2026-08-14（Asia/Shanghai）

本次实现将新试验任务的图片数量、顺序、职责和结构冻结为 `FIXED_SKELETON_V1`。冻结总数来自任务创建时用户提交的 6～13 张角色配置，不固定为 8 张。AI 只填写俄语文案；有效结果按冻结数量生成图片，固定方案完成后始终进入人工审核，不创建上传任务，也不写 Ozon 商品或库存。

旧 `LEGACY_FULL_PLAN_V3` 规划失败新增管理员只读诊断和一次性文字诊断复现。复现需要管理员权限、费用确认、精确账号/任务/商品/快照/状态版本和幂等键；它只保存文字响应与验证结果，不改变旧任务，不创建图片、计划、上传或 Ozon 写入。

## 自动化验证

### Fresh PostgreSQL 16 端到端门禁

命令：

```bash
AUTO_LISTING_CONFIGURABLE_SKELETON_PG_TESTS=1 \
SONLI_MIGRATION_TEST_DATABASE_URL='<disposable-postgres-url>' \
node --test --test-concurrency=1 server/tests/auto-listing-configurable-skeleton-e2e.test.mjs
```

结果：4/4 通过，0 失败，0 跳过。

覆盖：

- fresh schema 顺序应用 `001`～`074`，确认规划合同和三张诊断证据表存在；
- 6、当前 8、13 张三组配置分别只发起 1 次文字填充，图片调用数精确等于 6/8/13；
- 图片位置顺序固定，不按视觉组倍增；
- `DIRECT` 账号策略下固定方案仍进入 `READY_FOR_REVIEW`，上传任务与 Ozon 写入均为 0；
- 非法填充保留失败边界并产生 0 图片；
- 配置要求尺寸图但没有可靠商品尺寸时，在仓储和 AI 调用前失败；
- 多视觉组在固定骨架构建时失败；
- 试验门禁仅匹配精确账号与采集商品，其他账号、其他商品和 Excel 均保持旧合同。

外部文字、图片、富内容和 Ozon 端口全部是本地有界假端口；没有真实费用或平台副作用。工作流终态通过生产状态流转函数验证，数据库 schema 与诊断持久化使用真实 PostgreSQL。

### 规划、骨架、诊断和相邻回归

- focused/adjacent：169/169 通过，0 失败，0 跳过。
- 真实 PostgreSQL 规划仓储 + 一次性诊断：2/2 通过，0 失败，0 跳过。
- 一次性诊断断言：同一幂等键只调用文字网关 1 次；保存 1 个 run、1 个 response、1 个 validation；active plan、asset、AI outbox 均为 0；旧商品状态、状态版本、失败码和 active plan 保持不变。
- 并发回归：同一 RUNNING 诊断的状态检查和 stale 更新保持在一个数据库锁事务内；stale 不自动再次调用付费网关。

### 前端构建与静态门禁

- Vite production build：成功，4844 modules transformed。
- 变更模块语法检查：通过。
- `git diff --check`：通过。
- 敏感信息扫描：命中仅包括防泄漏正则、环境变量字段名和专门的泄漏测试假数据；未发现真实密钥、Authorization、完整内部提示词或供应商原始错误进入代码、公开 DTO 或本记录。

## 没有执行的范围

- 未调用真实 AI 文字模型；旧失败任务的一次文字诊断复现仍需单独确认费用后执行一次。
- 未调用真实图片模型；当前商品的实际 6～13 张试验仍需单独确认费用后执行。
- 未调用真实 Ozon、对象存储、生产数据库或生产库存。
- 未自动审核、上传或上架；固定方案必须停在人工审核。

## 运行与恢复

自动化命令：

```bash
npm run test:auto-listing-configurable-skeleton-e2e
```

运行前需要显式设置测试门禁和一次性 PostgreSQL 测试地址；缺少门禁时测试会跳过，跳过不得计为通过。

出现问题时：

1. 先关闭 `AUTO_LISTING_FIXED_SKELETON_PILOT_ENABLED`，新任务立即回到 `LEGACY_FULL_PLAN_V3`。
2. 已冻结为固定合同的任务保留其原合同，可继续到人工审核，或在审核前取消；不得改写为旧合同。
3. 按从新到旧顺序回滚应用提交；保留迁移 `074` 和已写入的不可变诊断证据。
4. 一次性文字诊断出现网络结果不确定时标记为 `AUTO_LISTING_PLAN_DIAGNOSTIC_RESPONSE_UNKNOWN`，不得用原幂等键盲目重发；由管理员使用新的费用确认请求决定是否再试。

建议的应用回滚顺序：

```bash
git revert 25f4f4c f3514c9 efc2f25 9eb2a22 deefa93 0f6f639 cccbe30
```

数据库恢复不删除 `074` 表或历史证据；它们保持向前兼容和可追溯。

## 受控真实试验状态

- 文字诊断：尚未执行，等待费用确认。
- 图片试验：尚未执行，等待第二次费用确认。
- Ozon/上传：按设计不执行，人工审核前必须保持 0。
