// 存储 e2e 会递归删除数据目录里的内容：只接受系统临时目录下、名字以 paperlens-e2e-storage- 开头的目录，
// 防止外部设置的 PAPERLENS_E2E_DATA_DIR 指向真实数据（例如项目的 data/）。
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";

export const E2E_DATA_DIR_PREFIX = "paperlens-e2e-storage-";

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

export function assertSafeE2EDataDir(dir: string): string {
  const abs = resolve(dir);
  const tmpRoots = new Set([resolve(tmpdir()), real(tmpdir())]);
  const parents = new Set([dirname(abs), dirname(real(abs))]);
  const underTmp = [...parents].some((p) => tmpRoots.has(p));
  if (!underTmp || !basename(abs).startsWith(E2E_DATA_DIR_PREFIX) || basename(abs) === E2E_DATA_DIR_PREFIX) {
    throw new Error(`PAPERLENS_E2E_DATA_DIR 必须是系统临时目录下名为 ${E2E_DATA_DIR_PREFIX}* 的目录，收到：${dir}`);
  }
  return abs;
}
