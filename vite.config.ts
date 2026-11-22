import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error type error without @types/node package
import { readdirSync, readFileSync } from "node:fs";
const host = process.env.TAURI_DEV_HOST;

// Data pendukung pdf.js (cMaps, font standar, wasm, profil ICC) dilayani dari
// /pdfjs/ saat dev dan disalin ke dist/pdfjs/ saat build. Aplikasi offline
// penuh dan CSP hanya mengizinkan 'self', jadi tidak boleh dari CDN.
// quickjs-eval hanya untuk JavaScript di dalam PDF, yang tidak dipakai Mira.
const PDFJS_DIRS = ["cmaps", "standard_fonts", "wasm", "iccs"];
const pdfjsRoot = new URL("./node_modules/pdfjs-dist/", import.meta.url);
const SAFE_NAME = /^[\w.-]+$/;

function pdfjsFiles(dir: string): string[] {
  return (readdirSync(new URL(`${dir}/`, pdfjsRoot)) as string[]).filter(
    (name) => SAFE_NAME.test(name) && !name.startsWith("quickjs-eval"),
  );
}

function pdfjsAssets(): Plugin {
  const mime: Record<string, string> = { wasm: "application/wasm", js: "text/javascript" };
  return {
    name: "mira-pdfjs-assets",
    configureServer(server) {
      server.middlewares.use("/pdfjs", (req, res, next) => {
        const [dir, name, ...rest] = ((req as { url?: string }).url ?? "").split("?")[0].replace(/^\//, "").split("/");
        if (rest.length || !PDFJS_DIRS.includes(dir) || !name || !pdfjsFiles(dir).includes(name)) return next();
        res.setHeader("Content-Type", mime[name.split(".").pop() ?? ""] ?? "application/octet-stream");
        res.end(readFileSync(new URL(`${dir}/${name}`, pdfjsRoot)));
      });
    },
    generateBundle() {
      for (const dir of PDFJS_DIRS) {
        for (const name of pdfjsFiles(dir)) {
          this.emitFile({ type: "asset", fileName: `pdfjs/${dir}/${name}`, source: readFileSync(new URL(`${dir}/${name}`, pdfjsRoot)) });
        }
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), pdfjsAssets()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
