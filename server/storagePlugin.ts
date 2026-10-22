// Vite 插件：在开发服务器（npm run dev）和预览服务器（vite preview）上挂载本地存储服务，
// 把浏览器里的数据镜像到 <项目根目录>/data/projects/<项目 id>/（项目登记在 data/projects.json，见 projects.ts）。
//   PAPERLENS_DATA_DIR=<目录>  改用其他数据目录（相对路径相对项目根目录）
//   PAPERLENS_STORAGE=off      完全不启用（前端按"无本地服务"处理）
// 只在第一次写入时创建目录；启动服务器本身不会碰 data/。
// 数据目录（以及迁移脚本放在旁边的 data-backup-before-projects-*）不能经 Vite 的静态文件服务读到：
// 加入 server.fs.deny、关闭 Vite 的 CORS（本应用只有同源请求），再加一道中间件拦截（createDataDirGuard）。
import path from "node:path";
import type { Connect, Plugin, UserConfig } from "vite";
import { MIGRATION_BACKUP_PREFIX, ProjectRegistry } from "./projects.ts";
import { createDataDirGuard, createStorageHandler, type StorageLimits } from "./storageHandler.ts";

/** Vite 8 的 server.fs.deny 默认值：设置 deny 会整个替换默认值，所以要带上 */
export const VITE_DEFAULT_FS_DENY = [".env", ".env.*", "*.{crt,pem,key,p12,pfx,cer,der}", ".npmrc", ".yarnrc.yml", "**/.git/**"];

export interface StoragePluginOptions {
  /** 缺省为 <root>/data；环境变量 PAPERLENS_DATA_DIR 优先 */
  dataDir?: string;
  limits?: Partial<StorageLimits>;
  /** 显式开关（测试用）；缺省按环境变量决定 */
  enabled?: boolean;
}

export interface ResolvedStorageSettings {
  enabled: boolean;
  dataDir: string;
}

export function resolveStorageSettings(root: string, options: StoragePluginOptions = {}, env: NodeJS.ProcessEnv = process.env): ResolvedStorageSettings {
  const dataDir = path.resolve(root, env.PAPERLENS_DATA_DIR || options.dataDir || "data");
  // Vitest 也会加载 vite.config.ts：单元测试里不挂载
  const enabled = options.enabled ?? (env.PAPERLENS_STORAGE !== "off" && !env.VITEST);
  return { enabled, dataDir };
}

const globEscape = (p: string) => p.replace(/[\\()[\]{}*?!+@]/g, "\\$&");

export function paperlensStorage(options: StoragePluginOptions = {}): Plugin {
  let root = process.cwd();
  let settings: ResolvedStorageSettings = resolveStorageSettings(root, options);
  const active = () => options.enabled === true || !process.env.VITEST;

  const install = (middlewares: Connect.Server, log: (msg: string) => void) => {
    if (!active()) return;
    // 两个中间件都放在 Vite 自带的中间件（CORS、主机检查、静态文件、模块转换）之前
    const guard = createDataDirGuard(root, settings.dataDir);
    if (!settings.enabled) {
      // 目录可能是之前留下的：服务关闭时也拦住静态访问
      middlewares.stack.unshift({ route: "", handle: guard as Connect.NextHandleFunction });
      log("[paperlens] 本地存储服务未启用（PAPERLENS_STORAGE=off），数据只保存在浏览器中");
      return;
    }
    const registry = new ProjectRegistry({ dir: settings.dataDir });
    void registry.cleanupTemp().catch(() => {});
    void registry.layout().then((l) => {
      if (l.kind === "legacy") log(`[paperlens] ${settings.dataDir} 还是旧版目录结构，迁移前不会写入：请运行 npm run migrate:projects`);
    });
    const rel = path.relative(root, settings.dataDir);
    const label = `${rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : settings.dataDir}/`;
    const handler = createStorageHandler({ registry, limits: options.limits, dataDirLabel: label });
    middlewares.stack.unshift({ route: "", handle: handler as Connect.NextHandleFunction }, { route: "", handle: guard as Connect.NextHandleFunction });
    log(`[paperlens] 数据自动保存到 ${settings.dataDir}`);
  };

  return {
    name: "paperlens-storage",
    config(userConfig): UserConfig {
      root = path.resolve(userConfig.root ?? process.cwd());
      settings = resolveStorageSettings(root, options);
      const dirGlob = globEscape(settings.dataDir);
      const backupGlob = `${globEscape(path.dirname(settings.dataDir))}/${MIGRATION_BACKUP_PREFIX}*`;
      const userDeny = userConfig.server?.fs?.deny;
      return {
        server: {
          // 数据目录里的文件频繁写入，不需要 Vite 监听；迁移前的完整备份可能很大，也不监听
          watch: { ignored: [`${dirGlob}/**`, `${backupGlob}/**`] },
          // mergeConfig 会把数组拼接到用户配置上；用户没设时要带上 Vite 的默认值
          fs: { deny: [...(userDeny ? [] : VITE_DEFAULT_FS_DENY), dirGlob, `${dirGlob}/**`, backupGlob, `${backupGlob}/**`] },
          // 本应用只有同源请求；Vite 默认允许任何 localhost 源跨源读取，会让其他本地网页读到源码和数据
          cors: false,
        },
        preview: { cors: false },
      };
    },
    configResolved(config) {
      root = config.root;
      settings = resolveStorageSettings(root, options);
    },
    configureServer(server) {
      install(server.middlewares, (m) => server.config.logger.info(m));
    },
    configurePreviewServer(server) {
      install(server.middlewares, (m) => server.config.logger.info(m));
    },
  };
}
