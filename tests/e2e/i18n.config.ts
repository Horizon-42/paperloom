// 界面多语言 e2e 的 Playwright 配置：独立端口 5471。
// npx playwright test -c tests/e2e/i18n.config.ts
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const root = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  testDir: ".",
  testMatch: "i18n*.spec.ts",
  outputDir: join(tmpdir(), "paperlens-e2e-i18n"),
  timeout: 90_000,
  workers: 2,
  // 语言由各用例自己设（test.use({ locale })）
  use: { baseURL: "http://localhost:5471", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: "npx vite --port 5471 --strictPort",
    url: "http://localhost:5471",
    cwd: root,
    // 不启用本地存储服务：否则会写入真实的 data/
    env: { PAPERLENS_STORAGE: "off" },
    reuseExistingServer: false,
  },
});
