// 在线版（静态部署）冒烟测试：构建 `npm run build:web`，放在 /paperlens/ 子路径下用静态服务器提供（模拟 GitHub Pages），
// 没有本地存储服务。独立端口 5197。
// npx playwright test -c tests/e2e/static.config.ts
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const root = fileURLToPath(new URL("../..", import.meta.url));
const site = join(tmpdir(), "paperlens-static-site");

export default defineConfig({
  testDir: ".",
  testMatch: "static*.spec.ts",
  outputDir: join(tmpdir(), "paperlens-e2e-static"),
  timeout: 60_000,
  use: { baseURL: "http://localhost:5197", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: `npm run build:web && rm -rf "${site}" && mkdir -p "${site}" && cp -R dist "${site}/paperlens" && python3 -m http.server 5197 --bind 127.0.0.1 -d "${site}"`,
    url: "http://localhost:5197/paperlens/",
    cwd: root,
    timeout: 180_000,
    reuseExistingServer: false,
  },
});
