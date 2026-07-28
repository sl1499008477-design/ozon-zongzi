# Task 2 报告：抽出多账号、多店铺缓存作用域模块

## Status

`DONE_WITH_CONCERNS`

已按 Task 2 brief 抽出纯缓存作用域模块，入口改为导入共享实现，旧 `testExports` 名称保持不变。未修改 API、数据库、数据结构、配置或依赖，未执行真实 Ozon 调用，也未执行 commit、stage、push、stash、分支切换或破坏性 Git 操作。

## 变更文件

- `server/store-cache-scope.mjs`
  - 新增 `cacheItemMatchesStore`
  - 新增 `cacheItemsForStore`
  - 新增 `cacheItemScope`
  - 新增 `upsertCacheItemByStore`
  - 新增 `upsertProductByStore`
- `server/tests/store-cache-scope.test.mjs`
  - 新增跨店铺匹配、作用域生成、同 ID 跨店铺插入和同店更新测试。
- `server/index.mjs`
  - 导入上述五个函数。
  - 删除入口中的同名本地实现。
  - 保留原有 `testExports` contract。
- `scripts/check-store-data-isolation.mjs`
  - 辅助函数定义检查改为读取新模块。
  - 入口路由和调用检查继续读取 `server/index.mjs`。
  - 原有店铺隔离断言语义不变。

## TDD 记录

RED 命令：

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/store-cache-scope.test.mjs
```

首次执行退出码为 `1`，失败原因符合预期：`ERR_MODULE_NOT_FOUND`，目标模块 `server/store-cache-scope.mjs` 尚不存在。

实现 brief 中给定的共享模块后，原始测试夹具暴露出 brief 内部不一致：upsert 实现按原有 contract 原样保存 `value`，不会自行注入店铺作用域，但原始测试写入的 `value` 没有店铺字段，因此后续无法按店铺匹配。经任务负责人明确确认，保留生产函数原有语义，只在测试夹具中通过 `cacheItemScope(...)` 补齐作用域字段，没有扩大 helper 行为。

## 验证结果

以下指定验证均通过：

```text
store cache scope tests passed
account store isolation smoke passed
module boundary guards passed（1/1）
store data isolation contract ok
node --check server/index.mjs（通过）
node --check server/store-cache-scope.mjs（通过）
git diff --check -- server/index.mjs scripts/check-store-data-isolation.mjs（通过）
```

完整 active suite 的本轮结果：

```text
tests 95
pass 89
fail 6
cancelled 0
skipped 0
todo 0
```

相对改造前基线 `94 tests / 88 pass / 6 fail`，新增测试通过，失败数未增加。6 项失败仍全部是本机 PostgreSQL `127.0.0.1:5432` 不可连接导致的 `ECONNREFUSED`：

1. `server/tests/account-deletion-postgres.integration.mjs`
2. `server/tests/collection-pipeline-v4.integration.mjs`
3. `server/tests/collector-desktop.integration.mjs`
4. `server/tests/listing-pipeline-v3.integration.mjs`
5. `server/tests/pricing-config.integration.mjs`
6. `server/tests/pricing-fx.integration.mjs`

测试清单检查通过：`69 active, 9 historical/manual`。

## 自审

- 新模块只处理传入对象和数组，不访问数据库、网络、环境变量、全局状态或当前账号上下文。
- 店铺匹配优先级保持为：明确店铺 ID、client ID、店铺名称。
- upsert 的返回值和写入语义保持现有实现不变。
- 同商品 ID 可以在不同店铺保留独立记录；同店铺同 ID 会更新原记录。
- 入口仍对旧测试暴露相同的 `testExports` 名称。
- 静态隔离门禁已随代码移动更新，未降低或删除断言。
- 工作区原有 dirty 内容未被清理、回退、暂存或吸收。

## Concerns

1. 本机 PostgreSQL 未运行，因此 6 个既有数据库集成测试仍无法通过；失败项和数量与基线相同。
2. brief 的接口摘要把两个 upsert 返回类型写为 `object`，但 brief 给定实现和现有 contract 实际返回 `boolean`；本 Task 依照给定实现保持 `boolean`，未擅自改变调用 contract。
3. brief 原始测试夹具遗漏店铺作用域字段；已按明确授权只修正夹具，并保留生产 helper 原有行为。
4. 未执行真实 Ozon 请求或生产数据验证；本 Task 是纯模块抽取，没有外部副作用。

## 回滚方式

若需回滚，只移除新增的模块和测试，并将 `server/index.mjs` 恢复为原本地 helper 定义、将静态隔离脚本恢复为读取入口中的 helper 定义。由于工作区已有大量用户改动，回滚必须按本 Task 的窄范围差异手工执行，不能使用整库 reset 或 checkout。
