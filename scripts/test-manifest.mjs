import { readdirSync } from "node:fs";
import path from "node:path";

const TEST_ROOTS = [
  "app/tests",
  "app/src",
  "scripts",
  "server/tests",
  "extension/tests",
  "extension/background/__tests__",
  "extension/popup/__tests__",
  "desktop/tests",
];

export const requiredActiveTestFiles = Object.freeze([
  "server/tests/collect-category-auto-resolution.integration.mjs",
  "scripts/dev.test.mjs",
  "scripts/package-extension.test.mjs",
  "server/tests/ai-listing-audit-runtime.test.mjs",
  "server/tests/ai-listing-repair.test.mjs",
  "server/tests/ai-listing-submission-recovery.test.mjs",
  "server/tests/ozon-write-rate-limit.test.mjs",
  "server/tests/formal-persistence-incremental.test.mjs",
  "server/tests/local-state-reader.test.mjs",
  "server/tests/account-shared-ozon-category-repository-legacy-read.test.mjs",
  "server/tests/account-shared-ozon-category-repository-source-categories.test.mjs",
  "server/tests/ozon-category-exact-search.test.mjs",
  "server/tests/ozon-key-expiry.test.mjs",
  "server/tests/listing-worker-stock-flow.test.mjs",
  "server/tests/listing-direct-rfbs.test.mjs",
  "server/tests/listing-current-source-shape.test.mjs",
  "server/tests/listing-pipeline-warehouse-boundary.test.mjs",
  "server/tests/collector-auth-service.test.mjs",
  "server/tests/collector-auth-runtime.test.mjs",
  "app/tests/ai-listing-preset-actions.test.mjs",
  "app/tests/ai-listing-audit.browser.test.mjs",
  "app/tests/ai-listing-page.browser.test.mjs",
  "desktop/tests/collector-authorization.test.mjs",
]);

// The AI-listing browser fixtures run against isolated Vite/API fixtures with
// Chrome/Chromium (CI sets JZ_BROWSER_PATH); they remain in the active app/tests gate.

// Report 16 retired source/tests were removed together; discoverTestFiles follows the
// remaining files. Keep shared and explicit CLI/experiment regressions in this gate.
// Exact deletion and retention evidence: docs/reports/2026-09-10-audit16-cleanup.md.
export const historicalTestExclusions = {
  "server/tests/listing-source-identity-postgres.test.mjs": "专用 PostgreSQL 真实上架准备边界、来源 SKU 保留与删除后去重验收；显式指定测试库并清理独立账号，不访问外部付费服务",
  "server/tests/collector-sku-history-postgres.test.mjs": "专用 PostgreSQL 成功保存、变体、上架历史与删除释放验收，显式指定测试库，事务回滚",
  "desktop/tests/collector-dedup-postgres.test.mjs": "专用 PostgreSQL 与真实 HTTP 的桌面连续三轮去重、入箱和自动 AI 选择验收；Seller 页面和系统浏览器使用代表性夹具，不调用外部付费服务",
  "server/tests/collector-sku-claims-postgres.test.mjs": "专用 PostgreSQL 并发 SKU 占用、租约释放、逐商品保存和账号边界验收；仅 SONLI_POSTGRES_TESTS=1 和明确指定可丢弃测试库时运行，UUID 账号最终清理",
  "server/tests/collector-desktop-locks-and-projection-postgres.test.mjs": "专用PostgreSQL真实并发锁及任务运行投影回归，会提交独占UUID账号/任务供多连接读取并在finally清理；仅SONLI_POSTGRES_TESTS=1且显式指定SONLI_MIGRATION_TEST_DATABASE_URL时手工运行",
  "desktop/tests/collector-http-recovery.test.mjs": "专用PostgreSQL真实HTTP及双进程桌面恢复验收，会写入账号/任务并清理；仅SONLI_DESKTOP_HTTP_POSTGRES_TESTS=1且SONLI_ENV_FILE=/private/tmp/sonli-audit-test.env时手工运行",
  "server/tests/collect-identity-preservation-postgres.test.mjs": "专用PostgreSQL采集identity保留验收，会写入账号/采集资料并验证唯一约束后事务回滚；仅SONLI_POSTGRES_TESTS=1且显式指定SONLI_MIGRATION_TEST_DATABASE_URL时手工运行",
  "server/tests/listing-direct-rfbs-postgres.test.mjs": "迁移123专用克隆库验收，会读取显式私库env、执行迁移及写入账号/仓库/快照后事务回滚；仅通过SONLI_DIRECT_RFBS_POSTGRES_TESTS显式启用，不在普通组运行",
  "server/tests/scoped-restore-function-search-path.test.mjs": "迁移122专用数据库恢复验收，会创建多个临时schema、执行SQL迁移并事务回滚；仅显式指定可丢弃测试库后单独运行",
  "server/tests/listing-stock-subset-postgres.test.mjs": "专用数据库库存子集验收，显式启用后写入测试账号/提交及执行迁移并事务回滚；不得在普通测试组运行",
  "server/tests/ai-listing-repair-postgres.integration.test.mjs": "专用数据库 AI 修复验收，写入来源证据与额度预留后清理；仅显式指定可丢弃测试库后单独运行",
  "server/tests/database-restore-compatibility.integration.test.mjs": "专用数据库恢复兼容验收，会写入账号并事务回滚；仅显式指定可丢弃测试库后单独运行，不纳入普通测试组",
  "server/tests/account-scoped-collection-migration.integration.mjs": "会创建临时 schema、执行迁移并验证失败关闭行为，只能在明确指定的专用 PostgreSQL 测试库中手工运行",
  "server/tests/account-deletion-postgres.integration.mjs": "会读取数据库配置并执行迁移、写入和删除，只能在明确指定的专用 PostgreSQL 测试库中手工运行",
  "server/tests/collection-pipeline-v4.integration.mjs": "会读取数据库配置并执行迁移、写入和删除，只能在明确指定的专用 PostgreSQL 测试库中手工运行",
  "server/tests/collector-desktop.integration.mjs": "会读取数据库配置并执行迁移、写入和删除，只能在明确指定的专用 PostgreSQL 测试库中手工运行",
  "server/tests/listing-pipeline-v3.integration.mjs": "会读取数据库配置并执行迁移、写入和删除，只能在明确指定的专用 PostgreSQL 测试库中手工运行",
  "server/tests/pricing-config.integration.mjs": "会读取数据库配置并执行迁移、写入和删除，只能在明确指定的专用 PostgreSQL 测试库中手工运行",
  "server/tests/pricing-fx.integration.mjs": "会读取数据库配置并写入、更新和删除数据，只能在明确指定的专用 PostgreSQL 测试库中手工运行",
  "extension/tests/1688-image-search-flow.test.js": "需要尚未纳入本项目依赖的 Playwright 浏览器运行时",
  "extension/tests/ai-wizard-agent1-actions.test.js": "需要尚未纳入本项目依赖的 Playwright 浏览器运行时",
  "extension/tests/ai-wizard-attr-context.test.js": "需要尚未纳入本项目依赖的 Playwright 浏览器运行时",
  "extension/tests/ai-wizard-store-category-warehouse.test.js": "需要尚未纳入本项目依赖的 Playwright 浏览器运行时",
  "extension/tests/alibaba-1688-scraper.test.js": "需要尚未纳入本项目依赖的 Playwright 浏览器运行时",
  "extension/tests/cn-source-panel.test.js": "需要尚未纳入本项目依赖的 Playwright 浏览器运行时",
  "extension/tests/follow-sell-modal.test.js": "需要尚未纳入本项目依赖的 Playwright 浏览器运行时",
};

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.posix.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

export function discoverTestFiles() {
  return TEST_ROOTS
    .flatMap((directory) => walk(directory))
    .filter((file) => /\.(?:test|integration)\.(?:mjs|js)$/.test(file))
    .sort();
}

export const activeTestFiles = discoverTestFiles()
  .filter((file) => !historicalTestExclusions[file]);

for (const file of requiredActiveTestFiles) {
  if (!activeTestFiles.includes(file)) {
    throw new Error(`必跑测试未纳入现行门禁：${file}`);
  }
}
