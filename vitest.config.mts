import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// SWC compiles the TypeScript so Nest's decorator metadata (constructor injection) works under Vitest.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts", "test/**/*.e2e-spec.ts"],
    setupFiles: ["reflect-metadata"],
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: "postgres://docmind:docmind@localhost:5432/docmind_test",
      REDIS_URL: "redis://localhost:6379",
      JWT_SECRET: "test-jwt-secret-test-jwt-secret-test-jwt-secret",
      INTERNAL_API_KEY: "test-internal-key-1234",
      WEB_ORIGIN: "http://localhost:3000",
      AI_SERVICE_URL: "http://localhost:8000",
    },
  },
  plugins: [swc.vite({ module: { type: "es6" } })],
});
