# DocMind API — Rules

Backend API and orchestration layer: **NestJS (Fastify adapter) + TypeScript strict**. Contract: `../docmind-web-service/01-docmind-rag-platform.md`
(spec Sections 5–9, 11). The spec's Fastify plugins map to Nest equivalents below. If something is in neither the spec nor the code, ASK before inventing it.

## Hard rules
- This service owns users, data, auth and orchestration. It is the ONLY service that touches Postgres and Redis.
- The AI service is stateless and internal. Call it with header `X-Internal-Key: $INTERNAL_API_KEY`; pass file BYTES (multipart), never paths.
- The browser only talks to this API. Base path `/api/v1`.
- Response and error shapes: see "Response envelope" below. Error codes are PascalCase (`NotFound`, `ApiRouteFailed`, ...), not the spec's SCREAMING_CASE.
- Every response carries `X-Request-Id` (generate if absent) and it appears in every log line.
- No hardcoded secrets. Config is validated with zod at startup in `src/config`; crash with a clear message if anything is missing.
- Never log `password`, `authorization`, `cookie`.
- Time is UTC everywhere: `timestamptz` columns, and timestamps in responses are `date.toISOString()` (ends in `Z`). Never format times or apply a time zone in the API; the web app converts to the viewer's local time (`utils/local-time.ts`).
- Validate every request body/param. Ownership filter on every query; foreign resources return 404, not 403.
- Every phase ships with tests (spec Section 13) and a README update.

## Stack
Node 22+ (`.nvmrc`) · NestJS 11 (CommonJS; Nest 12 is ESM-only, so we stay on 11) on `@nestjs/platform-fastify` · TypeScript strict (no `any`)
Drizzle ORM + drizzle-kit on `pg` · Postgres 16 + pgvector · zod 3 (own `ZodValidationPipe`, schemas mirrored from the web app) · BullMQ via `@nestjs/bullmq` + Redis 7
`@fastify/helmet`, `@fastify/cookie`, `@fastify/multipart` (Phase 3) · `@nestjs/throttler` (Redis store, Phase 8) · `@nestjs/jwt` + argon2 (Phase 2)
`nestjs-pino` (logging, redaction) · Vitest with SWC (unit + e2e via `app.inject`, no supertest) · npm

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
API types/zod schemas are mirrored in the web repo's `src/types` and `src/schemas`. Keep DTOs and response shapes in sync with them (copy per phase).

## Response envelope (differs from spec 8.1)
Every response, success or failure, has the same keys in the same order (see `common/http/api-response.ts`):
```
success: { code: "OK", data, message, resourceId, requestId }
failure: { code: "NotFound", error: { status, details? }, debug?, message, resourceId, requestId }     (no `data` on failures)
```
- `code` says what happened: `OK` for EVERY success (201/202 too; the HTTP status and `message` differ). On failure it is the error code:
  `ValidationFailed` 400 · `Unauthorized` 401 · `NotFound` 404 (a resource) · `ApiRouteFailed` 404 (the URL) · `DuplicateDocument` 409 · `LimitReached` 422 ·
  `RateLimited` 429 · `InternalError` 500 · `AiServiceFailed` 502 · `ServiceUnavailable` 503. Add new ones in `common/errors/error-codes.ts` (PascalCase).
- `message` is human readable and sits OUTSIDE `error`. `error.details` carries structured info (e.g. zod `fieldErrors`). `debug` (original message, first stack frames, method, path) is
  developer-only and is never sent when `NODE_ENV=production`. `resourceId` is the id of the created/affected resource, else `null`. `requestId` equals the `X-Request-Id` header.
- Success helpers: `respond.ok(obj)` → `data: { ...obj }` · `respond.list(rows, { total?, nextCursor? })` → `data: { result: [ ... ], total?, nextCursor? }` (lists ALWAYS use `data.result`)
  · `respond.created(obj, id)` (201) · `respond.accepted(obj, id)` (202, queued work) · `respond.of({ status, code, message, data })` for anything else.
- A plain returned value is wrapped as `respond.ok`; returning nothing (`@HttpCode(204)`) sends no body; streams and downloads use `@RawResponse()`.
- Failures: throw `AppError.notFound("Collection")`, `AppError.validation(...)` etc.; the global `AllExceptionsFilter` builds the envelope. Never `throw new NotFoundException` for a missing resource (that means "route not found").

## Auth (spec 6.1, 11)
Built: register, login, refresh, logout, `GET/PATCH/DELETE /auth/me`, `POST /auth/change-password`.
- Routes are protected by default (global `JwtAuthGuard`); `@Public()` opens one. `@CurrentUser()` gives `{ id, role }`. The guard only verifies the token (stateless); `/auth/me` checks the user still exists.
- register/login return `data: { accessToken, tokenType: "Bearer", expiresIn: 900, user: { id, name, email, role, createdAt } }` (register is 201 with `resourceId` = user id). The web app sends `Authorization: Bearer <accessToken>`.
- argon2id hashing (`@node-rs/argon2`). Login failure is always "Invalid email or password." (unknown email costs the same time as a wrong password). Emails are lowercased. Duplicate email → `EmailAlreadyRegistered` 409 with `error.details.fieldErrors.email`.
- Access JWT: HS256, 15 min, `{ sub, role }`. Refresh token: 48 random bytes base64url, only its sha256 is stored (`refresh_tokens`); it goes to the browser ONLY as an httpOnly cookie `dm_refresh` (`SameSite=Lax`, `secure` in production, path `/api/v1/auth`), never in the JSON.
- CORS: `WEB_ORIGIN` is a comma-separated allowlist (e.g. `http://localhost:3000,http://localhost:8080`); credentials on. Mutations are JSON-only except the upload route.
- `/auth/refresh` and `/auth/logout` are `@Public()` (the access token has usually expired; the httpOnly cookie is the credential). Refresh ROTATES: the old token is revoked atomically (`UPDATE ... WHERE revoked_at IS NULL`, so only one of two racing calls wins).
  A revoked token shown again after `AUTH.REFRESH_REUSE_GRACE_MS` (10 s) = theft → revoke ALL of the user's tokens; inside the window it is a benign race → 401 only.
- NEVER answer a wrong CURRENT PASSWORD with 401: the web app treats any 401 as "session over" and signs the user out. Use `ValidationFailed` (400) with `fieldErrors.currentPassword`.
- CORS must list every method the API uses (`app.setup.ts`): Fastify's default (GET, HEAD, POST) silently blocks PATCH and DELETE from the browser.
- Deleting an account relies on the foreign-key cascades in the schema; when uploads are stored on disk (Phase 3), `AuthService.deleteAccount` must also remove the user's files.

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
`npm run start:dev` · `npm run infra:up` (Postgres + Redis) · `npm run db:generate` then `npm run db:migrate` · `npm test` · `npm run lint` · `npm run typecheck`
Schema changes: edit `src/database/schema.ts`, run `db:generate`, review the SQL, then `db:migrate`. Never edit an applied migration.
Run typecheck, lint and tests before finishing any change. `app.setup.ts` holds the shared app setup, so e2e tests exercise the real one.
