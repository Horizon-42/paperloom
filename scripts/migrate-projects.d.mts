// migrate-projects.mjs 的类型声明（供 tests/unit/storage/node/migrate.test.ts 使用）
export const MIGRATION_BACKUP_PREFIX: string;
export const MIGRATING_MARKER: string;
export const DEFAULT_PROJECT_ID: string;
export const DEFAULT_PROJECT_NAME: string;
export const DEFAULT_PORTS: number[];

export type DataDirState =
  | "missing"
  | "symlink"
  | "not-dir"
  | "nested"
  | "empty"
  | "migrated"
  | "registry-broken"
  | "in-progress"
  | "interrupted"
  | "inconsistent"
  | "legacy";

export function inspectDataDir(dataDir: string): Promise<{ state: DataDirState; entries: string[]; strays?: string[] }>;

export interface ServiceCheckOptions {
  ports?: number[];
  /** false：不扫描其他端口上的 node 进程；{ pids }：只看这些进程 */
  scan?: boolean | { pids: number[] };
  /** 工作目录在这些目录下、回应又不像 Paperloom 的进程会被拦下 */
  repoRoots?: string[];
  force?: boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function checkServices(dataDir: string, opts?: ServiceCheckOptions): Promise<{ blocking: string[]; unsure: string[]; notes: string[] }>;

export interface MigrateOptions extends ServiceCheckOptions {
  dataDir: string;
  name?: string;
  apply?: boolean;
  now?: Date;
  log?: (line: string) => void;
  hooks?: {
    afterBackup?: () => Promise<void>;
    beforeMoveEntry?: (name: string) => Promise<void>;
    afterMove?: () => Promise<void>;
  };
}

export function migrate(opts: MigrateOptions): Promise<number>;

export function parseArgs(
  argv: string[],
  repoRoot: string,
): { dataDir: string; name: string; apply: boolean; force: boolean; ports: number[]; scan: boolean; repoRoots: string[]; help?: boolean };
