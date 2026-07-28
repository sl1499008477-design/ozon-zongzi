### Task 9: 完整验证、AGENTS.md 复查和交付记录

**Files:**
- Verify: all changed files
- Modify: `docs/superpowers/plans/2026-07-28-ozon-sync-service-extraction.md` checkbox state only

**Interfaces:**
- Consumes: 完成后的客户端、同步服务、入口和测试。
- Produces: 可复现的验证结果、未验证范围、风险和回滚说明。

- [ ] **Step 1: 运行语法和定向测试**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --check server/ozon-client.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --check server/store-cache-scope.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --check server/ozon-sync-service.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-client.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/store-cache-scope.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-sync-service.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/module-boundaries.test.mjs
```

Expected: 全部通过。

- [ ] **Step 2: 运行完整门禁**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/verify.mjs
```

Expected: 自动测试、前端构建、扩展包一致性和数据库集成检查全部通过。

- [ ] **Step 3: 对照 AGENTS.md 做结构和安全复查**

Run:

```bash
wc -l server/index.mjs server/ozon-client.mjs server/store-cache-scope.mjs server/ozon-sync-service.mjs
rg -n "apiKey|Client-Id|Api-Key" server/ozon-client.mjs server/ozon-sync-service.mjs server/tests/ozon-client.test.mjs
rg -n "fetch\\(" server/index.mjs server/ozon-client.mjs server/ozon-sync-service.mjs
rg -n "activeStore\\(|storesForAccount\\(" server/ozon-sync-service.mjs
git diff --check
```

Expected:

- `server/index.mjs` 不超过 5400 行。
- 凭据只用于请求头和测试桩，不进入日志、错误摘要或报告。
- Ozon Seller API fetch 只存在于 `server/ozon-client.mjs`。
- service 在选择和最终提交时都执行账号/店铺边界校验。
- 无空白和冲突标记错误。

- [ ] **Step 4: 核对改动范围**

Run:

```bash
git status --short
git diff --name-only
git diff --stat
```

Expected: 新增/修改只涉及本计划文件以及进入本轮前已存在的用户改动；不得暂存或提交。

- [ ] **Step 5: 形成交付说明**

最终说明必须包含：

```text
改了什么：
- 单一 Ozon HTTP 客户端
- 独立缓存作用域模块
- 独立同步服务
- 入口只保留路由编排

contract：
- 现有两个同步相关路由 contract 未变
- 新增内部 getOzonSellerApi 和 createOzonSyncService contract

验证：
- 列出定向测试与 scripts/verify.mjs 的实际结果和测试数量

回归：
- 账号/店铺隔离、同步租约、上架外部写保护、前端构建、扩展包一致性

未验证：
- 未连接真实 Ozon；原因是本轮禁止真实外部调用

回滚：
- 仅反向恢复本轮新模块、入口导入/调用和测试门禁
- 不使用 git reset --hard，不影响用户其他改动
```
