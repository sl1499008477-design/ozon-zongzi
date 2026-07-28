import { readdirSync } from "node:fs";
import path from "node:path";

const TEST_ROOTS = [
  "app/tests",
  "server/tests",
  "extension/tests",
  "extension/background/__tests__",
  "extension/popup/__tests__",
  "desktop/tests",
];

export const historicalTestExclusions = {
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
