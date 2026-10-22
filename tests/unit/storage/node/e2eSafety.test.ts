// @vitest-environment node
// 存储 e2e 的数据目录检查：外部传入的 PAPERLENS_E2E_DATA_DIR 不能指向真实数据（评审 M4 第 14 项）
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertSafeE2EDataDir, E2E_DATA_DIR_PREFIX } from "../../../e2e/storageSafety.ts";

describe("assertSafeE2EDataDir", () => {
  it("接受临时目录下的 paperlens-e2e-storage-* 目录", () => {
    const dir = mkdtempSync(join(tmpdir(), E2E_DATA_DIR_PREFIX));
    try {
      expect(assertSafeE2EDataDir(dir)).toBe(resolve(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    resolve("data"),
    resolve(process.cwd()),
    join(tmpdir(), "something-else"),
    join(tmpdir(), E2E_DATA_DIR_PREFIX),
    join(tmpdir(), "nested", `${E2E_DATA_DIR_PREFIX}x`),
    "/",
    `${process.env.HOME ?? "/Users/x"}/${E2E_DATA_DIR_PREFIX}abc`,
  ])("拒绝 %s", (dir) => {
    expect(() => assertSafeE2EDataDir(dir)).toThrow(/PAPERLENS_E2E_DATA_DIR/);
  });
});
