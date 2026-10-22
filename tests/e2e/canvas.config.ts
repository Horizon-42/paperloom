// 仅供笔记画布 e2e 使用的 Playwright 配置：独立端口 5332。
// npx playwright test -c tests/e2e/canvas.config.ts
// PAPERLENS_STORAGE=off：不让存储模块把测试数据写进 data/（用户的真实数据目录）。
// 为保证这个环境变量生效，不复用已在运行的开发服务器。
// 真实论文截图：PAPERLENS_LITERATURE_DIR=<你的论文目录> PAPERLENS_SHOTS_DIR=<目录>
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const root = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  testDir: ".",
  testMatch: "canvas*.spec.ts",
  outputDir: join(tmpdir(), "paperlens-e2e-canvas"),
  timeout: 60_000,
  workers: 2,
  // 并行开发时其他模块改文件会触发 Vite 整页重载，打断正在运行的用例；重试一次
  retries: 1,
  use: { baseURL: "http://localhost:5332", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: "npx vite --port 5332 --strictPort",
    url: "http://localhost:5332",
    cwd: root,
    env: { PAPERLENS_STORAGE: "off" },
    reuseExistingServer: false,
  },
});
