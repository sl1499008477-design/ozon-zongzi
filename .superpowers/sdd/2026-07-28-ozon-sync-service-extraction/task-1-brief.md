### Task 1: 固化改造前基线

**Files:**
- Read: `server/index.mjs`
- Read: `server/ozon-client.mjs`
- Read: `server/tests/module-boundaries.test.mjs`
- Read: `scripts/verify.mjs`

**Interfaces:**
- Consumes: 当前工作区和现有 68 个测试文件门禁。
- Produces: 可对比的测试数量、入口行数和工作区差异清单。

- [ ] **Step 1: 记录目标文件的现状**

Run:

```bash
git status --short
wc -l server/index.mjs server/ozon-client.mjs server/tests/module-boundaries.test.mjs
```

Expected:

- `server/index.mjs` 当前约 6186 行。
- 输出可能包含用户已有修改；后续不得清理或回退。

- [ ] **Step 2: 运行改造前完整门禁**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/verify.mjs
```

Expected: 全部测试、构建和扩展包一致性检查通过；若失败，先记录为基线失败，不把无关失败混入本轮修复。

- [ ] **Step 3: 记录本轮允许改动的文件**

Run:

```bash
git diff --name-only
```

Expected: 保存输出用于最终核对；本计划不得修改未列入“文件结构”的新文件。
