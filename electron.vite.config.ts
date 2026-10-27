import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const projectRoot = import.meta.dirname;

export default defineConfig(({ command }) => {
  const development = command === "serve";
  const contentSecurityPolicy = [
    "default-src 'self'",
    `script-src 'self'${development ? " 'unsafe-inline'" : ""}`,
    `style-src 'self'${development ? " 'unsafe-inline'" : ""}`,
    development ? "connect-src 'self' dai-resource: ws://127.0.0.1:*" : "connect-src dai-resource:",
    "img-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
  ].join("; ");

  return {
    main: {
      plugins: [externalizeDepsPlugin()],
      build: {
        outDir: resolve(projectRoot, "dist/main"),
        rollupOptions: {
          input: {
            index: resolve(projectRoot, "src/desktop/main/index.ts"),
            backend: resolve(projectRoot, "src/backend/index.ts"),
            "cad-mcp": resolve(projectRoot, "resources/mcp/cad/server.ts"),
            "alignment-mcp": resolve(projectRoot, "resources/mcp/alignment/server.ts"),
          },
          output: { format: "es", entryFileNames: "[name].js" },
        },
      },
    },
    preload: {
      build: {
        outDir: resolve(projectRoot, "dist/preload"),
        rollupOptions: {
          input: resolve(projectRoot, "src/desktop/preload/index.ts"),
          output: { format: "cjs", entryFileNames: "index.cjs" },
        },
      },
    },
    renderer: {
      root: resolve(projectRoot, "src/renderer"),
      server: { host: "127.0.0.1" },
      plugins: [
        react(),
        {
          name: "desktop-content-security-policy",
          transformIndexHtml: () => [
            {
              tag: "meta",
              attrs: {
                "http-equiv": "Content-Security-Policy",
                content: contentSecurityPolicy,
              },
              injectTo: "head-prepend",
            },
          ],
        },
      ],
      build: {
        outDir: resolve(projectRoot, "dist/renderer"),
        rollupOptions: { input: resolve(projectRoot, "src/renderer/index.html") },
      },
    },
  };
});
