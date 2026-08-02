import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

// argon2-browser's default entry imports argon2.wasm as an ESM module, which vite
// cannot serve (500 on `argon2.wasm?import`). The bundled build inlines the wasm.
// Under vitest crypto.ts loads the wasm from disk itself, so keep the default there.
const argon2Alias = process.env.VITEST
  ? {}
  : {
      "argon2-browser": path.resolve(
        __dirname,
        "./node_modules/argon2-browser/dist/argon2-bundled.min.js"
      ),
    };

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src"), ...argon2Alias },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": { target: "http://backend:8000", changeOrigin: true },
    },
  },
});
