/// <reference types="vitest/config" />
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { paperlensStorage } from "./server/storagePlugin.ts";

/** 把 pdf.js 的 wasm、cmaps、标准字体、ICC 资源复制到 public/pdfjs/（版本变化时重新复制） */
function pdfjsAssets(): Plugin {
  return {
    name: "paperlens-pdfjs-assets",
    buildStart() {
      const src = fileURLToPath(new URL("./node_modules/pdfjs-dist/", import.meta.url));
      const dest = fileURLToPath(new URL("./public/pdfjs/", import.meta.url));
      const version = JSON.parse(readFileSync(`${src}package.json`, "utf8")).version as string;
      const marker = `${dest}.version`;
      if (existsSync(marker) && readFileSync(marker, "utf8") === version) return;
      for (const dir of ["wasm", "cmaps", "standard_fonts", "iccs"]) {
        cpSync(`${src}${dir}`, `${dest}${dir}`, { recursive: true });
      }
      writeFileSync(marker, version);
    },
  };
}

/**
 * 依赖预打包的缓存目录：放在项目目录下（不在 node_modules 里），并按端口分开。
 * worktree 用软链接共用主仓库的 node_modules；缓存在 node_modules/.vite 时，测试或其他 worktree 的服务器重新打包依赖，
 * 会覆盖正在运行的开发服务器用着的文件，页面里混进两份 React（画布懒加载时白屏）
 */
function depsCacheDir(argv = process.argv): string {
  const i = argv.findIndex((a) => a === "--port" || a.startsWith("--port="));
  const port = i < 0 ? "default" : (argv[i].split("=")[1] ?? argv[i + 1] ?? "default");
  return fileURLToPath(new URL(`./.vite/deps-${port.replace(/\W/g, "")}/`, import.meta.url));
}

export default defineConfig({
  cacheDir: depsCacheDir(),
  // paperlensStorage：本地存储服务，把数据自动镜像到 data/（见 server/storagePlugin.ts）
  plugins: [react(), tailwindcss(), pdfjsAssets(), paperlensStorage()],
  // 端口被占用时直接报错，不悄悄换到 5174：IndexedDB 按源隔离，换端口会看到一个空文库（命令行 --port 仍可覆盖）
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  worker: { format: "es" },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/engine/**/*.test.ts", "tests/unit/**/*.test.{ts,tsx}"],
  },
});
