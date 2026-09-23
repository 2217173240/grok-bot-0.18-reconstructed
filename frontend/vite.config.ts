import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sirv from "sirv";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererAssetRoot = path.join(here, "assets");
const controlPort = process.env.SAND_DEV_CONTROL_PORT ?? "62150";
let rendererHealth: unknown = null;

function verifyRendererAssets() {
  const manifest = JSON.parse(readFileSync(path.join(here, "manifests", "renderer-runtime-assets.json"), "utf8")) as {
    schemaVersion?: number;
    artifactRoot?: string;
    assets?: { file: string; sha256: string }[];
  };
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.assets) || manifest.assets.length === 0) {
    throw new Error("Renderer development asset manifest is invalid.");
  }
  const missing = manifest.assets.filter(({ file }) => !existsSync(path.join(rendererAssetRoot, file))).map(({ file }) => file);
  if (missing.length > 0) {
    throw new Error(`Renderer development requires tracked frontend/assets files: ${missing.join(", ")}`);
  }
  if (manifest.artifactRoot !== "frontend/assets") {
    throw new Error(`Renderer development asset manifest must use frontend/assets, found ${manifest.artifactRoot ?? "missing root"}`);
  }
  for (const { file, sha256 } of manifest.assets) {
    if (!/^[A-Za-z0-9_.-]+$/.test(file) || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`Invalid renderer development asset entry: ${file}`);
    const digest = createHash("sha256").update(readFileSync(path.join(rendererAssetRoot, file))).digest("hex");
    if (digest !== sha256) throw new Error(`Renderer development asset hash drifted: ${file}`);
  }
}

export default defineConfig({
  root: here,
  // Electron loads the packaged renderer from file://. Keep every emitted
  // script, stylesheet, font, and lazy chunk relative to index.html so the
  // normal frontend:build -> package:recovered-frontend path does not depend
  // on an HTTP origin. The production-build helper already enforces this;
  // putting it in the canonical Vite config closes the direct build path too.
  base: "./",
  plugins: [
    react(),
    {
      name: "serve-source-renderer-assets",
      configureServer(server) {
        verifyRendererAssets();
        server.middlewares.use((request, response, next) => {
          if (request.url === "/__reconstructed_manifest" && request.method === "GET") {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ entry: "/src/main.tsx", styles: [] }));
            return;
          }
          if (request.url !== "/__reconstructed_health") return next();
          if (request.method === "GET") {
            response.writeHead(rendererHealth == null ? 503 : 200, { "content-type": "application/json" });
            response.end(JSON.stringify(rendererHealth ?? { ready: false }));
            return;
          }
          if (request.method !== "POST") {
            response.writeHead(405).end();
            return;
          }
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk) => {
            body += chunk;
          });
          request.on("end", () => {
            try {
              rendererHealth = JSON.parse(body);
              response.writeHead(204).end();
            } catch {
              response.writeHead(400).end();
            }
          });
        });
        server.middlewares.use("/renderer-assets", sirv(rendererAssetRoot, { dev: true, etag: true }));
      }
    }
  ],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: false,
    proxy: {
      "/__sand_control": {
        target: `http://127.0.0.1:${controlPort}`,
        changeOrigin: false,
        rewrite: (requestPath) => requestPath.replace(/^\/__sand_control/, "")
      }
    }
  },
  build: {
    outDir: path.resolve(here, "../.build/frontend-shell"),
    emptyOutDir: true,
    sourcemap: true
  }
});
