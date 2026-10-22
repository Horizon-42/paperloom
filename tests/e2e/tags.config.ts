// 论文标签 e2e 的 Playwright 配置：独立端口 5411。
// npx playwright test -c tests/e2e/tags.config.ts
// 截图：PAPERLENS_SHOTS_DIR=<截图目录>
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const root = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  testDir: ".",
  testMatch: "tags*.spec.ts",
  // 各模块的配置各用一个输出目录，并行运行时不会互相清空
  outputDir: join(tmpdir(), "paperlens-e2e-tags"),
  timeout: 60_000,
  workers: 2,
  use: { locale: "zh-CN", baseURL: "http://localhost:5411", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: "npx vite --port 5411 --strictPort",
    url: "http://localhost:5411",
    cwd: root,
    // 不启用本地存储服务：否则会写入真实的 data/，或在空的 IndexedDB 里自动恢复 data/ 中的数据，破坏测试隔离
    env: { PAPERLENS_STORAGE: "off" },
    reuseExistingServer: false,
  },
});
