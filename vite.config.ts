import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  build: { outDir: "../dist", emptyOutDir: true, target: "es2022" },
  define: { "process.env": {} },
  server: {
    // Local dev: `npx wrangler dev` serves /rpc on 8787; the Vite page proxies to it.
    proxy: { "/rpc": "http://127.0.0.1:8787", "/health": "http://127.0.0.1:8787" },
  },
  test: { include: ["../test/**/*.test.ts"] },
});
