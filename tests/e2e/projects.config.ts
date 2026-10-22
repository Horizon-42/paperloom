// 项目（notebook）e2e 的 Playwright 配置。npx playwright test -c tests/e2e/projects.config.ts
//   5401：本地存储服务开启，数据目录 <临时目录>/a/data（新建、切换、隔离、两个标签页、重命名、删除）
//   5402：本地存储服务开启，数据目录 <临时目录>/b/data（旧版结构 → 迁移提示 → 运行迁移脚本 → 恢复）
//   5403：服务关闭（PAPERLENS_STORAGE=off）：只在浏览器里的多项目
// 临时目录是每次运行新建的（名字以 paperlens-e2e-storage- 开头），迁移脚本的完整备份也落在里面；绝不碰真实的 data/。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { assertSafeE2EDataDir, E2E_DATA_DIR_PREFIX } from "./storageSafety";

const root = fileURLToPath(new URL("../..", import.meta.url));
// 配置文件在主进程和每个 worker 进程里都会加载：只在主进程建目录，worker 经环境变量继承同一个
process.env.PAPERLENS_E2E_PROJECTS_ROOT ??= mkdtempSync(join(tmpdir(), E2E_DATA_DIR_PREFIX));
const tmpRoot = assertSafeE2EDataDir(process.env.PAPERLENS_E2E_PROJECTS_ROOT);

export default defineConfig({
  testDir: ".",
  testMatch: "projects.spec.ts",
  outputDir: join(tmpdir(), "paperlens-e2e-projects"),
  timeout: 120_000,
  // 用例共用服务和数据目录，串行执行
  workers: 1,
  use: { locale: "zh-CN", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: [
    {
      command: "npx vite --port 5401 --strictPort",
      url: "http://localhost:5401",
      cwd: root,
      env: { PAPERLENS_DATA_DIR: join(tmpRoot, "a", "data"), PAPERLENS_STORAGE: "on" },
      reuseExistingServer: false,
    },
    {
      command: "npx vite --port 5402 --strictPort",
      url: "http://localhost:5402",
      cwd: root,
      env: { PAPERLENS_DATA_DIR: join(tmpRoot, "b", "data"), PAPERLENS_STORAGE: "on" },
      reuseExistingServer: false,
    },
    {
      command: "npx vite --port 5403 --strictPort",
      url: "http://localhost:5403",
      cwd: root,
      env: { PAPERLENS_STORAGE: "off" },
      reuseExistingServer: false,
    },
  ],
});
