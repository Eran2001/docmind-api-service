# DocMind API — Rules

Backend API and orchestration layer: **NestJS (Fastify adapter) + TypeScript strict**. Contract: `../docmind-web-service/01-docmind-rag-platform.md`
(spec Sections 5–9, 11). The spec's Fastify plugins map to Nest equivalents below. If something is in neither the spec nor the code, ASK before inventing it.

## Hard rules
- This service owns users, data, auth and orchestration. It is the ONLY service that touches Postgres and Redis.
- The AI service is stateless and internal. Call it with header `X-Internal-Key: $INTERNAL_API_KEY`; pass file BYTES (multipart), never paths.
- The browser only talks to this API. Base path `/api/v1`.
- Error shape everywhere: `{ "error": { "code", "message", "details"? } }`. Codes: VALIDATION_ERROR 400, UNAUTHORIZED 401, NOT_FOUND 404,
  DUPLICATE_DOCUMENT 409, LIMIT_REACHED 422, RATE_LIMITED 429, AI_SERVICE_ERROR 502, INTERNAL_ERROR 500.
- Every response carries `X-Request-Id` (generate if absent) and it appears in every log line.
- No hardcoded secrets. Config is validated with zod at startup in `src/config`; crash with a clear message if anything is missing.
- Never log `password`, `authorization`, `cookie`.
- Validate every request body/param. Ownership filter on every query; foreign resources return 404, not 403.
- Every phase ships with tests (spec Section 13) and a README update.

## Stack
Node 22 LTS · NestJS 11 on `@nestjs/platform-fastify` · TypeScript strict (no `any`) · Drizzle ORM + drizzle-kit · Postgres 16 + pgvector
zod (validation, via `nestjs-zod`) · BullMQ via `@nestjs/bullmq` + Redis 7 · `@nestjs/throttler` (Redis store) · `@fastify/helmet`, `@fastify/cookie`, `@fastify/multipart`
`@nestjs/jwt` + argon2 · `nestjs-pino` (logging, redact `password`, `authorization`, `cookie`) · Vitest / Jest + supertest · pnpm

## Layout
```
docmind-api-service/
├── src/
│   ├── main.ts                 API entry (Fastify adapter, helmet, cookies, CORS = WEB_ORIGIN, global prefix /api/v1)
│   ├── worker.ts               BullMQ worker entry (same codebase, separate process)
│   ├── app.module.ts           root module
│   ├── config/                 env.schema.ts (zod), config.module.ts, constants (RRF_K, CANDIDATES, TOP_K)
│   ├── database/               drizzle.module.ts, schema.ts (all tables), migrations/, seed.ts
│   ├── common/
│   │   ├── decorators/         @CurrentUser, @Roles, @Public
│   │   ├── filters/            AllExceptionsFilter → standard error shape
│   │   ├── guards/             JwtAuthGuard, RolesGuard
│   │   ├── interceptors/       logging
│   │   ├── middleware/         request-id
│   │   ├── pipes/              zod validation pipe
│   │   └── errors/             AppError + error codes
│   ├── modules/                one folder per domain; each has *.module.ts, *.controller.ts, *.service.ts, *.repository.ts, dto/
│   │   ├── auth/  (tokens.service.ts for JWT + refresh rotation)
│   │   ├── users/  collections/  documents/  conversations/
│   │   ├── chat/  (chat.controller.ts SSE, retrieval.service.ts hybrid RRF SQL, citations.ts)
│   │   ├── feedback/  usage/  (pricing.ts)  evals/  health/
│   ├── queues/                 queue.module.ts, processors/ (ingest-document, run-eval)
│   └── integrations/
│       ├── ai/                 typed client for the Python service (X-Internal-Key, streaming, abort)
│       ├── storage/            local disk storage (STORAGE_DIR)
│       └── redis/
├── test/  (unit/, e2e/, fixtures/)
├── scripts/
├── drizzle.config.ts · nest-cli.json · tsconfig.json · .env.example
```
Rules: controllers are thin (parse DTO → call service → return). Business logic in services, ALL SQL in repositories (Drizzle). Modules never import each
other's repositories; go through the exporting module's service. Cross-cutting behaviour (auth, errors, request-id, rate limits) is global via guards/filters/middleware.
Shared API types/zod schemas come from `@docmind/shared` (defined in the web repo's `packages/shared`); decide how it is linked (workspace, git dep or copy) before Phase 1.

## Auth (spec 6.1, 11)
- argon2id password hashing; login failure is always "Invalid email or password".
- Access JWT (HS256, 15 min, `{sub, role}`) in cookie `dm_access`; refresh token = 48 random bytes base64url in `dm_refresh`, store only its sha256.
- Cookies: httpOnly, `secure` in production, `sameSite=lax`, refresh cookie `path=/auth`.
- `/auth/refresh` rotates: revoke old, issue new. Reuse of a revoked token revokes ALL of that user's refresh tokens.
- CORS: only `WEB_ORIGIN`, credentials on. Mutations are JSON-only except the upload route.
- Settings endpoints needed by the web: `PATCH /auth/me {name,email}`, `POST /auth/change-password {currentPassword,newPassword}` (revoke other sessions), `DELETE /auth/me`.

## Documents & ingestion (spec 6.2)
- Upload: allow pdf/docx/txt/md, check magic bytes, max 20 MB, max 50 docs per collection, sha256 dedupe → 409 `DUPLICATE_DOCUMENT`.
- Store at `STORAGE_DIR/{userId}/{documentId}{ext}` (random name, never the user's filename). Insert doc `status='queued'`, enqueue job, return 202.
- Worker: `processing` → call AI `/ingest/file|url` → in ONE transaction delete old chunks, bulk insert chunks (batches of 200), set `ready`, `chunk_count`, `page_count`, insert `usage_events` (kind `embed`).
- 3 retries with backoff 5s/25s/125s; final failure → `status='failed'` with a friendly `error_message` mapped from AI codes (PARSE_FAILED, EMPTY_DOCUMENT, URL_FETCH_FAILED, URL_BLOCKED, LLM_ERROR).
- Deleting a collection/document also deletes files from disk.

## Chat (spec 6.3, 7.2, 7.3, 8.3)
- Save user msg, create assistant msg `status='streaming'`. Rewrite query (last 6 msgs, skip on first message) → `/embed` → hybrid RRF SQL exactly as spec 7.2 → top 8.
- Constants `RRF_K=60`, `CANDIDATES=30`, `TOP_K=8` live in config so evals can vary them.
- Zero chunks → stream the fixed "I couldn't find anything in your documents about that." with NO LLM call.
- Proxy AI SSE to the browser as public events: `meta`, `status{searching|generating}`, `token`, `done{citations,usage,latencyMs}`, `error`.
- Extract citations with `/\[(\d+)\]/`, map to chunks, dedupe; drop markers with no matching chunk.
- Client disconnect → cancel the AI request (AbortController), mark message `status='error'`, keep partial content.
- First exchange → background title generation (fast model, ≤6 words).
- Usage cost from a pricing map (USD per MTok); unknown model → cost 0 + warn log.

## Rate limits (Redis-backed)
Chat 20/min/user · uploads 30/hour/user · auth 10/min/IP. Security headers on all responses.

## Database (spec Section 5)
Postgres 16 + pgvector (`vector`, `pgcrypto` extensions). All tables + indexes come from migrations; never alter schema by hand.
Chunks carry `tsv` for keyword search and `embedding vector(1536)`.

## Commands
Add as scripts are created: `pnpm start:dev` · `pnpm worker:dev` · `pnpm test` · `pnpm lint` · `pnpm db:migrate` · `pnpm db:seed`. Run lint + typecheck before finishing any change.
