// 仅供批注模块 e2e 使用的 Playwright 配置：独立端口 5321。
// npx playwright test -c tests/e2e/annotation.config.ts
// 设置 PAPERLENS_LITERATURE_DIR 时额外在真实论文上截图（输出到 PAPERLENS_SHOTS_DIR）。
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const root = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  testDir: ".",
  testMatch: "annotation*.spec.ts",
  timeout: 60_000,
  // 与其他模块并行跑 e2e 时互不覆盖结果目录（默认的 test-results 每次运行会被整个清空）
  outputDir: join(tmpdir(), "paperlens-e2e-annotation"),
  workers: 2,
  use: { locale: "zh-CN", baseURL: "http://localhost:5321", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: "npx vite --port 5321 --strictPort",
    url: "http://localhost:5321",
    cwd: root,
    // 不启用本地存储服务：否则会写入真实的 data/，或在空的 IndexedDB 里自动恢复 data/ 中的数据，破坏测试隔离
    env: { PAPERLENS_STORAGE: "off" },
    reuseExistingServer: false,
  },
});
