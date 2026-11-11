import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  build: { outDir: "../dist", emptyOutDir: true, target: "es2022" },
  define: { "process.env": {} },
  server: {
    // Local dev: `npx wrangler dev` serves /rpc on 8787 and the Vite page proxies to it. With RPC_DIRECT set to an
    // RPC URL, Vite proxies /rpc straight to that provider instead (no Worker needed; the key, if any, stays local).
    proxy: process.env.RPC_DIRECT
      ? {
          "/rpc": {
            target: process.env.RPC_DIRECT, changeOrigin: true,
            rewrite: () => new URL(process.env.RPC_DIRECT!).pathname + new URL(process.env.RPC_DIRECT!).search,
            // Public RPCs refuse browser-looking requests from unknown sites; the relay in production sends neither header.
            configure: (proxy) => proxy.on("proxyReq", (req) => { req.removeHeader("origin"); req.removeHeader("referer"); }),
          },
        }
      : { "/rpc": "http://127.0.0.1:8787", "/health": "http://127.0.0.1:8787" },
  },
  test: { include: ["../test/**/*.test.ts"] },
});
