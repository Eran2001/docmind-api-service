import { z } from "zod";

const LOG_LEVELS = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
] as const;

export const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  // One origin, or several separated by commas (e.g. the web app on 3000 and on 8080).
  WEB_ORIGIN: z
    .string()
    .default("http://localhost:3000")
    .transform((v) =>
      v
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().url()).min(1)),

  DATABASE_URL: z
    .string({
      required_error: "is required (postgres://user:pass@host:5432/db)",
    })
    .regex(
      /^postgres(ql)?:\/\//,
      "must start with postgres:// or postgresql://",
    ),
  REDIS_URL: z
    .string({ required_error: "is required (redis://host:6379)" })
    .regex(/^rediss?:\/\//, "must start with redis:// or rediss://"),

  // Lifetime of an access token. 15 minutes in production; shorter values are handy for testing the refresh flow.
  ACCESS_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(86_400)
    .default(900),
  JWT_SECRET: z
    .string({
      required_error: "is required (generate with: openssl rand -hex 32)",
    })
    .min(32, "must be at least 32 characters"),
  INTERNAL_API_KEY: z
    .string({ required_error: "is required (shared with the AI service)" })
    .min(16, "must be at least 16 characters"),

  STORAGE_DIR: z.string().min(1).default("./storage"),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(20),
  AI_SERVICE_URL: z.string().url().default("http://localhost:8000"),

  // Behind a reverse proxy or load balancer (nginx, Caddy, a cloud LB): trust its X-Forwarded-For header, so rate limits count the
  // real client IP instead of the proxy's. Leave it off when the API is reachable directly, or anyone could fake their IP.
  TRUST_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // Reranking: fetch RERANK_CANDIDATES passages, let the AI service's rerank model put the best 8 first. On the docs benchmark
  // it raised "right passage in the top 8" from 91% to 94% and ranking quality (MRR) from 0.56 to 0.87, for about 5,000 extra
  // tokens per question on a small model, so it is OFF by default. The AI service needs LLM_RERANK_MODEL (or a good fast model).
  RERANK_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  RERANK_CANDIDATES: z.coerce.number().int().min(4).max(30).default(12),
});

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvValidationError";
  }
}

/** Parses and validates the environment. Throws one readable error listing every problem. */
export function loadEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  - ${i.path.join(".")}: ${i.message}`,
    );
    throw new EnvValidationError(
      `Invalid environment configuration:\n${lines.join("\n")}\nFix your .env file (see .env.example).`,
    );
  }
  return result.data;
}
