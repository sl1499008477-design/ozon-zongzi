# 类目图片策略详情返回列表 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在类目图片策略详情页提供可靠的“返回策略列表”入口，并阻止自动恢复状态重新打开原草稿。

**Architecture:** 复用 `category-strategy-model.js` 已有的 `clearStrategyResumeDraft(storage, accountId)`，由 `CategoryStrategyPage` 的一个本地点击处理函数协调请求失效、恢复快照刷新、详情清理和无查询参数导航。不新增路由、共享状态层或依赖。

**Tech Stack:** React 19、Ant Design、React Router 风格 `navigate` 回调、Node.js test runner。

## Global Constraints

- 只修改类目图片策略详情页及其直接测试，不重构无关模块。
- 不修改后端 API、数据库、权限、多租户、样本、发布或幂等规则。
- 清除的只是当前账号在浏览器 `sessionStorage` 中的自动恢复意图，不删除草稿或服务器数据。
- 精确导航目标为 `/ozon/tools/category-strategies`，不得保留 `draftId`、`from` 或其他查询参数。

---

### Task 1: 详情页返回策略列表

**Files:**
- Modify: `app/src/CategoryStrategyPage.jsx`
- Test: `app/tests/category-strategy-page.test.mjs`

**Interfaces:**
- Consumes: `clearStrategyResumeDraft(storage, accountId)`；现有 `clearBundle()`；现有 `navigate(path)`。
- Produces: 详情页按钮“返回策略列表”和本地处理函数 `returnToStrategyList()`。

- [ ] **Step 1: 写入失败测试**

在页面契约测试中加入一个用例，要求详情页：

```js
test("detail view returns to the list without restoring the old draft", () => {
  assert.match(page, /clearStrategyResumeDraft/u);
  assert.match(page, /const returnToStrategyList/u);
  assert.match(page, /loadRequestRef\.current \+= 1/u);
  assert.match(page, /clearBundle\(\)/u);
  assert.match(page, /navigate\("\/ozon\/tools\/category-strategies"\)/u);
  assert.match(page, /返回策略列表/u);
});
```

该测试应在生产代码缺少按钮与处理函数时失败。

- [ ] **Step 2: 运行测试确认 RED**

运行：

```bash
node --test app/tests/category-strategy-page.test.mjs
```

预期：新增用例因找不到 `clearStrategyResumeDraft` 或“返回策略列表”而失败，既有用例继续通过。

- [ ] **Step 3: 写入最小实现**

在 `CategoryStrategyPage.jsx`：

```jsx
import { clearStrategyResumeDraft } from "./category-strategy-model.js";

const returnToStrategyList = () => {
  loadRequestRef.current += 1;
  actionRequestRef.current = null;
  clearStrategyResumeDraft(globalThis.sessionStorage, accountId);
  setResumeRevision((current) => current + 1);
  clearBundle();
  navigate("/ozon/tools/category-strategies");
};
```

并仅在 `detail` 存在时，在页头右侧加入：

```jsx
{detail ? <Button icon={<ArrowLeftOutlined />} onClick={returnToStrategyList}>
  返回策略列表
</Button> : null}
```

- [ ] **Step 4: 运行相关测试确认 GREEN**

运行：

```bash
node --test app/tests/category-strategy-page.test.mjs app/tests/category-strategy-model.test.mjs app/tests/category-strategy-bootstrap.test.mjs
```

预期：全部通过，无失败。

- [ ] **Step 5: 构建并做浏览器验收**

运行：

```bash
node node_modules/vite/bin/vite.js build
```

在本地页面打开一个策略详情，确认按钮仅在详情页出现；点击后 URL 不带查询参数、自动恢复记录被删除且列表稳定显示。

- [ ] **Step 6: 提交**

```bash
git add app/src/CategoryStrategyPage.jsx app/tests/category-strategy-page.test.mjs
git commit -m "fix: return category strategy details to list"
```
