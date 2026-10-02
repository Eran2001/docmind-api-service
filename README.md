# DocMind API

The backend of **DocMind**, an app where you upload your own documents and chat with them, getting answers that cite the exact
page they came from (retrieval-augmented generation, "RAG"). The product story and the full picture are in
`../docmind-web-service/README.md`; this README covers the API.

**What this service does:** it owns the users, the data and the rules. The web app talks only to it. It is a NestJS (Fastify) server that

- signs people in and protects every route,
- stores users, collections, documents, conversations, feedback, usage and eval results in Postgres (with pgvector for the embeddings),
- accepts uploads and hands the slow work (parsing, chunking, embedding) to background jobs on a Redis queue,
- runs the chat: finds the best passages with hybrid search, asks the AI service for an answer, streams it to the browser
  and turns the `[n]` markers into citations,
- tracks tokens and cost, and runs the eval sets.

It is the **only** service that touches Postgres and Redis. The Python AI service (`../docmind-ai-service`) is internal and stateless;
it does the model work when this service asks.

```
web (Next.js) ──HTTPS/SSE──► API (this) ──internal HTTP──► AI service (FastAPI)
                               │    │
                               ▼    ▼
                          Postgres  Redis
                          +pgvector (job queue, rate limits)
```

## Roadmap

| Phase | What                                                                                                                             | State                                           |
| ----- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1     | Foundation: config, errors, logging, database schema + migration, Redis + queues, health check                                   | Done                                            |
| 2     | Auth: register, login, current user, refresh (rotation + reuse detection), logout, edit profile, change password, delete account | Done                                            |
| 3     | Collections (create, list + search, rename, delete)                                                                              | Done                                            |
| 3     | Documents: upload, add URL, list, delete, reprocess (saved to disk, queued for ingestion)                                        | Done                                            |
| 4     | Ingestion pipeline: worker calls AI service, stores chunks and embedding usage, updates document status                          | Implemented; live embeddings need OpenAI credit |
| 5     | Chat: hybrid search, streaming answers, citations                                                                                | Implemented                                     |
| 6     | Feedback and usage/cost dashboards                                                                                               | Feedback, `/usage/me` and `/admin/usage` implemented        |
| GET        | `/api/v1/admin/usage/export`               | admin only (404 otherwise); `?days=30`. CSV download, one row per model call by any user, with `user_email` and `user_name` first. Capped at 100,000 rows. |
| 7     | Eval set/question CRUD, queued run API and run worker integration                                                                | CRUD ready; scores need the AI judge endpoint   |
| 8     | Rate limits, seed data, CI, deployment                                                                                           | Rate limits, seed, CI and demo done; deployment pending|

## Run it

Needs Node 22+ and Docker.

```bash
npm install
cp .env.example .env          # then set JWT_SECRET and INTERNAL_API_KEY (openssl rand -hex 32)
npm run infra:up              # Postgres 16 + pgvector and Redis 7, waits until healthy
npm run db:migrate            # creates all 13 tables, the vector/pgcrypto extensions and the indexes
npm run db:seed               # optional: admin + demo accounts, a demo collection and an eval set (see below)
npm run start:dev             # http://localhost:4000/api/v1/health
# in a second terminal, after the AI service is running
npm run worker:dev             # consumes document ingestion jobs from Redis
```

`npm run infra:down` stops the containers (data stays in Docker volumes).

### Seed data

`npm run db:seed` is safe to run twice (it skips what exists) and refuses to run when `NODE_ENV=production`. It creates:

- `demo@docmind.dev` / `demo1234`: the account behind the web app's "Try the demo" button, with a "Northwind Demo" collection
  (a sample handbook and product FAQ, queued for ingestion) and an eval set of 5 questions whose answers are in those two files.
- `admin@docmind.dev` with role `admin`. Its password is `SEED_ADMIN_PASSWORD` if set, otherwise a random one printed once.

Start the worker and the AI service afterwards so the two documents get processed.

### The demo ("Try the demo")

`POST /api/v1/auth/demo` (public, 5 per hour per IP) creates a private sandbox account for one visitor and signs them in, with the
same response as login. The sample collection of the seeded `demo@docmind.dev` account (documents, chunks with their embeddings,
stored files and the eval set) is copied into it, so the visitor can chat immediately and nothing is shared with other visitors.

- **Limits:** 5 chat messages and 1 upload (a file or a web page) per demo account. Over the limit the API answers 403
  `DemoLimitReached`. A rejected upload gives its unit back.
- **Restricted actions** (403 `DemoRestricted`): changing the profile, password or avatar, deleting the account, creating, renaming
  or deleting collections, and creating or running evals.
- **Lifetime:** demo accounts are deleted 24 hours after they were created, with their files, by the worker (once at start, then
  hourly). At most 200 exist at once; past that the endpoint answers 503 "busy".
- The accounts use an `@demo.docmind.invalid` address and a random password nobody knows. `GET /auth/me` returns `user.demo`
  (`questionsLeft`, `uploadsLeft`, `expiresAt`) for them and `null` for everyone else.
- It needs the seed: run `npm run db:seed` and let the worker process the two sample documents first.

### Rate limits

Counted in Redis (fixed window), answered as 429 `RateLimited` with a `Retry-After` header:

| Route                                                           | Limit              | Counted per |
| --------------------------------------------------------------- | ------------------ | ----------- |
| register, login, refresh, change-password (one shared counter)  | 10 per minute      | IP          |
| `POST /conversations/:resourceId/messages` (chat)               | 20 per minute      | user        |
| `POST .../documents` and `.../documents/url` (shared counter)   | 30 per hour        | user        |

If Redis is down the limiter lets requests through (and logs a warning) instead of blocking everyone. Behind a reverse proxy,
turn on Fastify's `trustProxy` so the IP is the client's and not the proxy's.

## Scripts

| Script                    | What it does                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `start:dev`               | Run with file watching                                                                                                                                                                           |
| `build` / `start`         | Compile to `dist/` / run the compiled server                                                                                                                                                     |
| `worker:dev` / `worker`   | Run the separate BullMQ ingestion worker (dev / compiled)                                                                                                                                        |
| `typecheck` / `lint`      | `tsc --noEmit` / ESLint                                                                                                                                                                          |
| `test` / `test:watch`     | Vitest. Most specs need nothing running; the collections spec runs against a real Postgres test database (`docmind_test`, created and migrated automatically) and is skipped if Postgres is down |
| `db:generate`             | Create a migration from changes to `src/database/schema.ts`                                                                                                                                      |
| `db:seed`                 | Create the demo and admin accounts and sample data (idempotent)                                                                                                                                  |
| `db:migrate`              | Apply migrations to `DATABASE_URL`                                                                                                                                                               |
| `db:studio`               | Browse the database in Drizzle Studio                                                                                                                                                            |
| `infra:up` / `infra:down` | Start / stop Postgres and Redis (docker compose)                                                                                                                                                 |

## Naming: `resourceId`, never `id`

Every entity the API returns identifies itself as **`resourceId`** (`{ "resourceId": "...", "name": "...", ... }` for a user, collection or document), and route params are
`:resourceId`. The same word is used at the top of every response for the record a request created or changed. Database columns stay `id` (internal), and references to
another entity keep their own names (`collectionId`, `userId`).

## Endpoints

| Method | Path                                            | Notes                                                                                                                                                                                                                                                                                                                                                             |
| ------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| POST   | `/api/v1/auth/register`                         | body `{ name, email, password }` → 201, `data: { accessToken, tokenType, expiresIn, user }`, `resourceId` = user id, sets the httpOnly `dm_refresh` cookie. Duplicate email → 409 `EmailAlreadyRegistered`.                                                                                                                                                       |
| POST   | `/api/v1/auth/login`                            | body `{ email, password }` → 200, same `data` and cookie. Any failure → 401 `Unauthorized` "Invalid email or password."                                                                                                                                                                                                                                           |
| POST   | `/api/v1/collections`                           | protected; body `{ name (1-60), description? (max 500) }` → 201, `data: { result: true }`, `resourceId` = the new id.                                                                                                                                                                                                                                             |
| GET    | `/api/v1/collections/:resourceId`               | protected; one collection (404 if missing, malformed or not yours).                                                                                                                                                                                                                                                                                               |
| GET    | `/api/v1/collections?search=`                   | protected; yours only, most recently updated first, each with `documentCount`. `search` matches name or description, case-insensitive. → `data: { result: [ ... ] }`                                                                                                                                                                                              |
| PATCH  | `/api/v1/collections/:resourceId`               | protected; body `{ name?, description? }` (`""` or `null` clears the description) → `data: { result: true }`. Someone else's or a missing id → 404 `NotFound`.                                                                                                                                                                                                    |
| DELETE | `/api/v1/collections/:resourceId`               | protected; deletes the collection and, by cascade, its documents, chunks and chats. 404 if it isn't yours.                                                                                                                                                                                                                                                        |
| GET    | `/api/v1/collections/:resourceId/documents`     | protected; the collection's documents, newest first, with their `status` (`queued`, `processing`, `ready`, `failed`).                                                                                                                                                                                                                                             |
| POST   | `/api/v1/collections/:resourceId/documents`     | protected; `multipart/form-data` with one `file` field. **202** `{ result: true }`, `resourceId` = the new document id. PDF, DOC, DOCX, TXT or MD (checked by the file's bytes), max `MAX_UPLOAD_MB`. Duplicate bytes in the collection → 409 `DuplicateDocument`; 50 documents → 422 `LimitReached`; bad/empty/oversize file → 400 `ValidationFailed` on `file`. |
| POST   | `/api/v1/collections/:resourceId/documents/url` | protected; body `{ url }` (http/https). 202, same response. Same page (any case, with or without `#fragment`) → 409.                                                                                                                                                                                                                                              |
| POST   | `/api/v1/documents/:resourceId/reprocess`       | protected; back to `queued` and re-queued (a document already queued/processing is left alone). 202.                                                                                                                                                                                                                                                              |
| DELETE | `/api/v1/documents/:resourceId`                 | protected; deletes the document, its chunks and its file on disk.                                                                                                                                                                                                                                                                                                 |
| GET    | `/api/v1/documents/:resourceId/chunks/:chunkId` | protected; returns the owned citation passage and its adjacent chunk context.                                                                                                                                                                                                                                                                                     |
| POST   | `/api/v1/collections/:resourceId/conversations` | protected; creates a conversation and returns its id in the top-level `resourceId`.                                                                                                                                                                                                                                                                               |
| GET    | `/api/v1/collections/:resourceId/conversations` | protected; lists the collection's conversations in `data.result`, newest activity first. Paged: `?limit=20` (1–100) and `?cursor=` (the previous page's `data.nextCursor`, null on the last page).                                                                                                                                                                                                                                                                                                 |
| GET    | `/api/v1/conversations/:resourceId`             | protected; conversation, messages, citations, usage and feedback.                                                                                                                                                                                                                                                                                                 |
| DELETE | `/api/v1/conversations/:resourceId`             | protected; deletes the conversation and cascades its messages.                                                                                                                                                                                                                                                                                                    |
| POST   | `/api/v1/conversations/:resourceId/messages`    | protected SSE; rewrites follow-ups, embeds and retrieves with RRF, streams grounded answer tokens, citations and usage.                                                                                                                                                                                                                                           |
| PUT    | `/api/v1/messages/:resourceId/feedback`         | protected; body `{ rating: 1                                                                                                                                                                                                                                                                                                                                      | -1, comment? }`; upserts feedback for an assistant message. |
| POST   | `/api/v1/auth/refresh`                          | public; the browser sends the httpOnly `dm_refresh` cookie. → `data`: a NEW access token (same shape as login) and a rotated cookie. Each refresh token works once.                                                                                                                                                                                               |
| POST   | `/api/v1/auth/logout`                           | public; revokes this browser's refresh token and clears the cookie. Always 200.                                                                                                                                                                                                                                                                                   |
| GET    | `/api/v1/auth/me`                               | needs `Authorization: Bearer <accessToken>` → `data: { user }`; otherwise 401 `Unauthorized`.                                                                                                                                                                                                                                                                     |
| PATCH  | `/api/v1/auth/me`                               | protected; body `{ name, email }` → `data: { user }`. Email taken by someone else → 409 `EmailAlreadyRegistered`.                                                                                                                                                                                                                                                 |
| POST   | `/api/v1/auth/change-password`                  | protected; body `{ currentPassword, newPassword }`. Wrong current password → **400** `ValidationFailed` on `currentPassword` (not 401). Signs out every other device.                                                                                                                                                                                             |
| POST       | `/api/v1/auth/me/avatar`                   | protected; multipart field `file`, a PNG, JPEG or WebP up to 2 MB (checked by its bytes). Replaces the old picture. `data: { result: true }`; the user then has `hasAvatar: true`. |
| GET        | `/api/v1/auth/me/avatar`                   | protected; the picture itself (image bytes, not JSON). 404 when there is none. |
| DELETE     | `/api/v1/auth/me/avatar`                   | protected; removes the picture and its file. |
| DELETE | `/api/v1/auth/me`                               | protected; deletes the account and everything it owns (foreign keys cascade) and clears the cookie.                                                                                                                                                                                                                                                               |
| GET    | `/api/v1/health`                                | `data: { status, db, redis, ai }`. 200 when ok or degraded (only the AI service is down), 503 (`code: ServiceUnavailable`) when the database or Redis is down.                                                                                                                                                                                                    |

### Eval routes

| Method     | Path                                       | Notes                                                                           |
| ---------- | ------------------------------------------ | ------------------------------------------------------------------------------- |
| GET/POST   | `/api/v1/evals/sets`                       | List owned sets or create one for an owned collection.                          |
| GET/DELETE | `/api/v1/evals/sets/:resourceId`           | Read details or delete an owned set.                                            |
| POST       | `/api/v1/evals/sets/:resourceId/questions` | Add a question, expected answer and optional document from the same collection. |
| DELETE     | `/api/v1/evals/questions/:resourceId`      | Delete an owned question.                                                       |
| POST       | `/api/v1/evals/sets/:resourceId/runs`      | Queue a run; scoring awaits the Python `/evals/judge` endpoint.                 |
| GET        | `/api/v1/evals/runs/:resourceId`           | Read status, progress, metrics and results.                                     |
| GET        | `/api/v1/usage/me`                         | protected; `?days=30` (1–365). Your cost, tokens, requests and average latency for the last N UTC days, the previous N days (`previous` is null with no earlier activity), a zero-filled `daily` list and `byKind`. |
| GET        | `/api/v1/usage/me/export`                  | protected; `?days=30`. Downloads a CSV (not the JSON envelope): one row per model call with UTC `created_at`, `kind`, `model`, tokens, `cost_usd` and `latency_ms`. Capped at 100,000 rows. |
| GET        | `/api/v1/admin/usage`                      | admin only (anyone else gets 404); `?days=30`. Same shape as `/usage/me` for all users, plus `topUsers` (10 biggest by cost: `resourceId`, `name`, `email`, `requests`, `tokens`, `costUsd`). |

**Sessions:** a short-lived access token (JWT, sent as `Authorization: Bearer`) plus a long-lived refresh token that only ever lives in an httpOnly cookie
(path `/api/v1/auth`, 7 days, only its sha256 is stored). Refreshing rotates it. If an already-used refresh token is shown again after more than 10 seconds,
it is treated as stolen and every session of that user is revoked; within 10 seconds it is treated as two tabs racing and just refused.
Changing the password signs out all other devices (their access tokens still work until they expire, at most 15 minutes).

Every response has an `X-Request-Id` header (a valid incoming one is reused).

### Response format

Every response has the same keys in the same order. `code` is `OK` for every success, and the error code on a failure.

```jsonc
// success: single object                          // success: list (rows the frontend maps over)
{ "code": "OK",                                    { "code": "OK",
  "data": { "status": "ok", "db": "up" },            "data": { "result": [ { "id": "..." }, { "id": "..." } ],
  "message": "OK",                                               "total": 12, "nextCursor": null },
  "resourceId": null,                                "message": "OK", "resourceId": null, "requestId": "..." }
  "requestId": "1e75d3c5-..." }

// failure: no data, an error object, and debug (never in production)
{ "code": "NotFound",
  "error": { "status": 404 },                     // details (e.g. field errors) go here when there are any
  "debug": { "name": "AppError", "message": "...", "stack": "...", "method": "GET", "path": "/api/v1/...", "timestamp": "..." },
  "message": "Collection not found.",
  "resourceId": null,
  "requestId": "1e75d3c5-..." }
```

**Writes don't send the record back.** A create, update or delete answers `data: { result: true }`; a create puts the new id in `resourceId`
(so `POST /collections` gives `201`, `data: { "result": true }`, `resourceId: "<new id>"`). Fetch the record, or refetch the list, if you need it.
Created (201) and accepted (202) responses are still `code: "OK"`.

| Failure `code`       | HTTP | Meaning                                          |
| -------------------- | ---- | ------------------------------------------------ |
| `ValidationFailed`   | 400  | bad input (`error.details` has the field errors) |
| `Unauthorized`       | 401  | not signed in                                    |
| `NotFound`           | 404  | the resource doesn't exist or isn't yours        |
| `ApiRouteFailed`     | 404  | the URL doesn't exist                            |
| `DuplicateDocument`  | 409  | same file already in the collection              |
| `LimitReached`       | 422  | e.g. 50 documents per collection                 |
| `RateLimited`        | 429  | too many requests                                |
| `InternalError`      | 500  | unexpected failure (details hidden)              |
| `AiServiceFailed`    | 502  | the AI service failed                            |
| `ServiceUnavailable` | 503  | health check: database or Redis is down          |

In controllers: `respond.ok(obj)`, `respond.list(rows, { total, nextCursor })`, `respond.created(obj, id)`, `respond.accepted(obj, id)`;
failures are thrown as `AppError.notFound("Collection")` etc. A plain returned value is wrapped as `ok`; `@RawResponse()` opts a stream out.
See `src/common/http/api-response.ts`.

## Configuration

Validated with zod at startup; the server refuses to start and lists every problem if something is wrong. See `.env.example`.

| Variable                        | Default                 | Notes                                                                                 |
| ------------------------------- | ----------------------- | ------------------------------------------------------------------------------------- |
| `DATABASE_URL`                  | (required)              | `postgres://user:pass@host:5432/db`                                                   |
| `REDIS_URL`                     | (required)              | `redis://host:6379`                                                                   |
| `JWT_SECRET`                    | (required)              | at least 32 characters; signs access tokens                                           |
| `ACCESS_TOKEN_TTL_SECONDS`      | `900`                   | access token lifetime (15 min). Set it to a few seconds to watch the refresh flow     |
| `INTERNAL_API_KEY`              | (required)              | at least 16 characters, shared with the AI service                                    |
| `API_PORT`                      | `4000`                  |                                                                                       |
| `WEB_ORIGIN`                    | `http://localhost:3000` | allowed CORS origin(s), comma-separated (credentials allowed)                         |
| `AI_SERVICE_URL`                | `http://localhost:8000` |                                                                                       |
| `STORAGE_DIR` / `MAX_UPLOAD_MB` | `./storage` / `20`      | uploads are saved at `STORAGE_DIR/<userId>/<documentId>.<ext>`; max upload size in MB |
| `LOG_LEVEL`                     | `info`                  | pretty logs in development, JSON otherwise                                            |

## Structure

```
src/
├── main.ts, app.module.ts, app.setup.ts   entry, root module, shared setup (used by main and the e2e tests)
├── config/          env schema, constants (retrieval settings, queue names)
├── common/          errors (AppError + exception filter), pipes (zod), utils
├── database/        Drizzle schema (all tables), database module, migrations/
├── integrations/    ai (Python client), redis, storage (uploaded files on disk)
├── queues/          BullMQ connection and the ingest / eval queues
└── modules/         one folder per feature: health, auth, users, collections, documents
test/                e2e tests
```

## What happens to an upload

1. The file's bytes decide what it is (PDF `%PDF-`, DOCX = a zip containing `word/document.xml`, TXT/MD = valid UTF-8 without NUL bytes); the name and the browser's mime type are only hints.
2. Duplicate check (sha256 of the bytes, per collection) and the 50-documents limit.
3. The file is saved under a name we generate (never the uploaded name), a `documents` row is created as `queued`, and an `ingest-document` job `{ documentId }` goes on the Redis queue.
   If the queue can't take it, everything is undone and the API answers 503.
4. **Nothing processes the job yet:** the worker and the AI service come in the next phase, so documents stay `queued` for now.

## Decisions

- **NestJS 11, not 12.** Nest 12 is ESM-only; 11 is the CommonJS line the docs and ecosystem still use.
- **Fastify** adapter, with `@fastify/helmet` and `@fastify/cookie`; `fastify` is pinned to `^5.12.5` (an `overrides` entry) because
  Nest 11's own pin has two published advisories.
- **`pg` + Drizzle**; migrations are generated, then the first one was edited by hand to create the `vector` and `pgcrypto` extensions.
- **Health is `degraded`, not failing, while the AI service is down**, so the API stays usable during development before that service exists.
- Remaining `npm audit` findings are dev-only tooling (drizzle-kit's esbuild, vitest's mocker).
