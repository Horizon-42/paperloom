import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// 两个服务：5199 默认语言设成中文（现有用例按中文界面断言）；5198 用真实的默认语言（英文），跑界面多语言用例。
// 在线版冒烟测试要先构建，用 tests/e2e/static.config.ts 单独跑
export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: ["static*.spec.ts"],
  outputDir: join(tmpdir(), "paperlens-e2e-default"),
  timeout: 30_000,
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "chromium", testIgnore: ["i18n*.spec.ts"], use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:5199" } },
    {
      name: "i18n",
      testMatch: ["i18n*.spec.ts"],
      timeout: 90_000,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, baseURL: "http://localhost:5198" },
    },
  ],
  // 不启用本地存储服务：否则会写入真实的 data/，或在空的 IndexedDB 里自动恢复 data/ 中的数据，破坏测试隔离
  webServer: [
    {
      command: "npx vite --port 5199 --strictPort",
      url: "http://localhost:5199",
      env: { VITE_PAPERLENS_DEFAULT_LOCALE: "zh", PAPERLENS_STORAGE: "off" },
      reuseExistingServer: false,
    },
    {
      command: "npx vite --port 5198 --strictPort",
      url: "http://localhost:5198",
      env: { PAPERLENS_STORAGE: "off" },
      reuseExistingServer: false,
    },
  ],
});
