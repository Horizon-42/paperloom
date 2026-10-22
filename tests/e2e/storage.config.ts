// 存储模块（自动保存到 data/、导出导入）e2e 的 Playwright 配置。
// npx playwright test -c tests/e2e/storage.config.ts
//   5331：本地存储服务开启，PAPERLENS_DATA_DIR 指向每次运行新建的临时目录（绝不碰项目里真实的 data/）
//   5338：服务关闭（PAPERLENS_STORAGE=off），测"未连接本地服务"
// 两个服务器都不复用已在运行的进程，保证环境变量生效。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { assertSafeE2EDataDir, E2E_DATA_DIR_PREFIX } from "./storageSafety";

const root = fileURLToPath(new URL("../..", import.meta.url));
// 配置文件在主进程和每个 worker 进程里都会加载：只在主进程建目录，worker 经环境变量继承同一个。
// 外部传入的目录必须是临时目录（用例会清空它）
process.env.PAPERLENS_E2E_DATA_DIR ??= mkdtempSync(join(tmpdir(), E2E_DATA_DIR_PREFIX));
const dataDir = assertSafeE2EDataDir(process.env.PAPERLENS_E2E_DATA_DIR);

export default defineConfig({
  testDir: ".",
  testMatch: "storage*.spec.ts",
  outputDir: join(tmpdir(), "paperlens-e2e-storage"),
  timeout: 90_000,
  // 用例共用一个服务和数据目录，串行执行
  workers: 1,
  use: { baseURL: "http://localhost:5331", trace: "retain-on-failure", acceptDownloads: true },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: [
    {
      command: "npx vite --port 5331 --strictPort",
      url: "http://localhost:5331",
      cwd: root,
      env: { PAPERLENS_DATA_DIR: dataDir, PAPERLENS_STORAGE: "on" },
      reuseExistingServer: false,
    },
    {
      command: "npx vite --port 5338 --strictPort",
      url: "http://localhost:5338",
      cwd: root,
      env: { PAPERLENS_STORAGE: "off" },
      reuseExistingServer: false,
    },
  ],
});
