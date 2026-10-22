// 在临时目录上起一个真实的本地存储服务（只监听 127.0.0.1），供服务端测试和前端任务的集成测试使用。
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectRegistry } from "../../../../server/projects.ts";
import type { DataStoreOptions } from "../../../../server/storageFs.ts";
import { API_ROOT, createDataDirGuard, createStorageHandler, projectApiPrefix, type StorageLimits } from "../../../../server/storageHandler.ts";

export interface TestServer {
  /** 临时"项目根目录"，数据目录是其中的 data/ */
  root: string;
  /** data/ 根目录（projects.json、projects/、trash/） */
  dataRoot: string;
  /** default 项目的目录 data/projects/default（与旧版的 data/ 根目录结构相同） */
  dataDir: string;
  origin: string;
  /** default 项目的存储接口 */
  base: string;
  /** /__paperlens 的完整地址 */
  apiRoot: string;
  registry: ProjectRegistry;
  close(): Promise<void>;
}

export async function startTestServer(
  opts: { limits?: Partial<StorageLimits>; store?: Omit<Partial<DataStoreOptions>, "dir" | "ensureDir"> } = {},
): Promise<TestServer> {
  const root = mkdtempSync(join(tmpdir(), "paperlens-storage-test-"));
  const dataRoot = join(root, "data");
  const registry = new ProjectRegistry({ dir: dataRoot, store: opts.store });
  const handler = createStorageHandler({ registry, limits: opts.limits, dataDirLabel: "data/" });
  const guard = createDataDirGuard(root, dataRoot);
  const server: Server = createServer((req, res) => {
    guard(req, res, () =>
      handler(req, res, () => {
        res.statusCode = 200;
        res.end("fallthrough");
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  return {
    root,
    dataRoot,
    dataDir: registry.projectDir("default"),
    origin,
    base: `${origin}${projectApiPrefix("default")}`,
    apiRoot: `${origin}${API_ROOT}`,
    registry,
    close: async () => {
      await new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections(); // fetch 会保持连接
      });
      rmSync(root, { recursive: true, force: true });
    },
  };
}
