import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

/**
 * 开发态前端只做同源代理：浏览器不接触模型、MinIO 或 runtime 凭据。
 * /api/pi/* 的 Better Auth 鉴权与 Pi wire contract 均由 API 网关承接。
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ["MATHPILOT_API_URL"]);
  return {
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": new URL("./src", import.meta.url).pathname },
  },
  server: {
    port: 5174,
    proxy: {
      // 浏览器始终同源访问；Cookie 只由 Better Auth API 网关解释。
      "/api": {
        target: env.MATHPILOT_API_URL ?? "http://127.0.0.1:3001",
        changeOrigin: false,
      },
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  };
});
