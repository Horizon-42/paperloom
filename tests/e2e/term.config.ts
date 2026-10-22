// 仅供术语前台 e2e 使用的 Playwright 配置：独立端口 5322。
// npx playwright test -c tests/e2e/term.config.ts
// 真实论文测试：PAPERLENS_LITERATURE_DIR=<你的论文目录>；截图：PAPERLENS_SHOTS_DIR=<目录>
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const root = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  testDir: ".",
  testMatch: "term*.spec.ts",
  // 各模块并行跑 e2e 时不共用 test-results（每次运行会清空）
  outputDir: join(tmpdir(), "paperlens-e2e-term"),
  timeout: 60_000,
  workers: 2,
  // 并行开发时其他模块改文件会触发 Vite 整页重载，打断正在运行的用例；重试一次
  retries: 1,
  use: { locale: "zh-CN", baseURL: "http://localhost:5322", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: "npx vite --port 5322 --strictPort",
    url: "http://localhost:5322",
    cwd: root,
    // 不启用本地存储服务：否则会写入真实的 data/，或在空的 IndexedDB 里自动恢复 data/ 中的数据，破坏测试隔离
    env: { PAPERLENS_STORAGE: "off" },
    reuseExistingServer: false,
  },
});
