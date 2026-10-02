import { describe, expect, it } from "vitest";

import { EnvValidationError, loadEnv } from "./env.schema";

const valid = {
  DATABASE_URL: "postgres://docmind:docmind@localhost:5432/docmind",
  REDIS_URL: "redis://localhost:6379",
  JWT_SECRET: "x".repeat(32),
  INTERNAL_API_KEY: "y".repeat(16),
};

describe("loadEnv", () => {
  it("applies defaults for optional values", () => {
    const env = loadEnv(valid);
    expect(env.API_PORT).toBe(4000);
    expect(env.NODE_ENV).toBe("development");
    expect(env.WEB_ORIGIN).toEqual(["http://localhost:3000"]);
    expect(env.MAX_UPLOAD_MB).toBe(20);
    expect(env.AI_SERVICE_URL).toBe("http://localhost:8000");
  });

  it("coerces numeric strings", () => {
    expect(
      loadEnv({ ...valid, API_PORT: "5050", MAX_UPLOAD_MB: "5" }),
    ).toMatchObject({ API_PORT: 5050, MAX_UPLOAD_MB: 5 });
  });

  it("accepts several web origins separated by commas", () => {
    expect(
      loadEnv({
        ...valid,
        WEB_ORIGIN: "http://localhost:3000, http://localhost:8080",
      }).WEB_ORIGIN,
    ).toEqual(["http://localhost:3000", "http://localhost:8080"]);
    expect(() => loadEnv({ ...valid, WEB_ORIGIN: "not-a-url" })).toThrow(
      /WEB_ORIGIN/,
    );
  });

  it("lists every missing required variable in one error", () => {
    const run = () => loadEnv({});
    expect(run).toThrow(EnvValidationError);
    try {
      run();
    } catch (err) {
      const message = (err as Error).message;
      for (const name of [
        "DATABASE_URL",
        "REDIS_URL",
        "JWT_SECRET",
        "INTERNAL_API_KEY",
      ]) {
        expect(message).toContain(name);
      }
    }
  });

  it("rejects weak secrets and malformed urls", () => {
    expect(() => loadEnv({ ...valid, JWT_SECRET: "short" })).toThrow(
      /JWT_SECRET/,
    );
    expect(() => loadEnv({ ...valid, DATABASE_URL: "mysql://x" })).toThrow(
      /DATABASE_URL/,
    );
    expect(() => loadEnv({ ...valid, REDIS_URL: "localhost:6379" })).toThrow(
      /REDIS_URL/,
    );
  });
});
