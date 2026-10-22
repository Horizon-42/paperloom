import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  // 在线版冒烟测试要先构建、界面语言测试要用真实的默认语言（英文），各自用 static.config.ts / i18n.config.ts 跑
  testIgnore: ["static*.spec.ts", "i18n*.spec.ts"],
  outputDir: join(tmpdir(), "paperlens-e2e-default"),
  timeout: 30_000,
  use: { baseURL: "http://localhost:5199", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npx vite --port 5199 --strictPort",
    url: "http://localhost:5199",
    // 不启用本地存储服务：否则会写入真实的 data/，或在空的 IndexedDB 里自动恢复 data/ 中的数据，破坏测试隔离
    env: { VITE_PAPERLENS_DEFAULT_LOCALE: "zh", PAPERLENS_STORAGE: "off" },
    reuseExistingServer: false,
  },
});
