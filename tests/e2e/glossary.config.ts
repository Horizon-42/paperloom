// 术语后台（索引 Worker + 术语表）e2e 的 Playwright 配置：独立端口 5323。
// npx playwright test -c tests/e2e/glossary.config.ts
// 真实论文检查：PAPERLENS_LITERATURE_DIR=<你的论文目录> PAPERLENS_SHOTS_DIR=<截图目录> npx playwright test -c tests/e2e/glossary.config.ts glossary-real
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const root = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  testDir: ".",
  testMatch: "glossary*.spec.ts",
  // 独立的输出目录：其他模块并行跑 e2e 时会清空 test-results/
  outputDir: join(tmpdir(), "paperlens-e2e-glossary"),
  timeout: 120_000,
  workers: 2,
  use: { baseURL: "http://localhost:5323", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: "npx vite --port 5323 --strictPort",
    url: "http://localhost:5323",
    cwd: root,
    // 不启用本地存储服务：否则会写入真实的 data/，或在空的 IndexedDB 里自动恢复 data/ 中的数据，破坏测试隔离
    env: { PAPERLENS_STORAGE: "off" },
    reuseExistingServer: false,
  },
});
