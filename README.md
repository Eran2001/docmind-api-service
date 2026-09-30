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

| Phase | What | State |
|---|---|---|
| 1 | Foundation: config, errors, logging, database schema + migration, Redis + queues, health check | Done |
| 2 | Auth: register, login, current user | Done |
| 2 | Auth: refresh with rotation, logout, Settings endpoints (edit profile, change password, delete account) | Next |
| 3 | Collections and document upload (queues the ingest job) | |
| 4 | Ingestion pipeline (needs the AI service) | |
| 5 | Chat: hybrid search, streaming answers, citations | |
| 6 | Feedback and usage/cost dashboards | |
| 7 | Evals | |
| 8 | Rate limits, seed data, CI, deployment | |

## Run it

Needs Node 22+ and Docker.

```bash
npm install
cp .env.example .env          # then set JWT_SECRET and INTERNAL_API_KEY (openssl rand -hex 32)
npm run infra:up              # Postgres 16 + pgvector and Redis 7, waits until healthy
npm run db:migrate            # creates all 13 tables, the vector/pgcrypto extensions and the indexes
npm run start:dev             # http://localhost:4000/api/v1/health
```

`npm run infra:down` stops the containers (data stays in Docker volumes).

## Scripts

| Script | What it does |
|---|---|
| `start:dev` | Run with file watching |
| `build` / `start` | Compile to `dist/` / run the compiled server |
| `typecheck` / `lint` | `tsc --noEmit` / ESLint |
| `test` / `test:watch` | Vitest (unit and e2e; no Postgres or Redis needed) |
| `db:generate` | Create a migration from changes to `src/database/schema.ts` |
| `db:migrate` | Apply migrations to `DATABASE_URL` |
| `db:studio` | Browse the database in Drizzle Studio |
| `infra:up` / `infra:down` | Start / stop Postgres and Redis (docker compose) |

## Endpoints

| Method | Path | Notes |
|---|---|---|
| POST | `/api/v1/auth/register` | body `{ name, email, password }` → 201, `data: { accessToken, tokenType, expiresIn, user }`, `resourceId` = user id, sets the httpOnly `dm_refresh` cookie. Duplicate email → 409 `EmailAlreadyRegistered`. |
| POST | `/api/v1/auth/login` | body `{ email, password }` → 200, same `data` and cookie. Any failure → 401 `Unauthorized` "Invalid email or password." |
| GET | `/api/v1/auth/me` | needs `Authorization: Bearer <accessToken>` → `data: { user }`; otherwise 401 `Unauthorized`. |
| GET | `/api/v1/health` | `data: { status, db, redis, ai }`. 200 when ok or degraded (only the AI service is down), 503 (`code: ServiceUnavailable`) when the database or Redis is down. |

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

Created (201) and accepted (202) responses are still `code: "OK"`, with the new id in `resourceId`.

| Failure `code` | HTTP | Meaning |
|---|---|---|
| `ValidationFailed` | 400 | bad input (`error.details` has the field errors) |
| `Unauthorized` | 401 | not signed in |
| `NotFound` | 404 | the resource doesn't exist or isn't yours |
| `ApiRouteFailed` | 404 | the URL doesn't exist |
| `DuplicateDocument` | 409 | same file already in the collection |
| `LimitReached` | 422 | e.g. 50 documents per collection |
| `RateLimited` | 429 | too many requests |
| `InternalError` | 500 | unexpected failure (details hidden) |
| `AiServiceFailed` | 502 | the AI service failed |
| `ServiceUnavailable` | 503 | health check: database or Redis is down |

In controllers: `respond.ok(obj)`, `respond.list(rows, { total, nextCursor })`, `respond.created(obj, id)`, `respond.accepted(obj, id)`;
failures are thrown as `AppError.notFound("Collection")` etc. A plain returned value is wrapped as `ok`; `@RawResponse()` opts a stream out.
See `src/common/http/api-response.ts`.

## Configuration

Validated with zod at startup; the server refuses to start and lists every problem if something is wrong. See `.env.example`.

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | (required) | `postgres://user:pass@host:5432/db` |
| `REDIS_URL` | (required) | `redis://host:6379` |
| `JWT_SECRET` | (required) | at least 32 characters; signs access tokens |
| `INTERNAL_API_KEY` | (required) | at least 16 characters, shared with the AI service |
| `API_PORT` | `4000` | |
| `WEB_ORIGIN` | `http://localhost:3000` | allowed CORS origin(s), comma-separated (credentials allowed) |
| `AI_SERVICE_URL` | `http://localhost:8000` | |
| `STORAGE_DIR` / `MAX_UPLOAD_MB` | `./storage` / `20` | used from Phase 3 |
| `LOG_LEVEL` | `info` | pretty logs in development, JSON otherwise |

## Structure

```
src/
├── main.ts, app.module.ts, app.setup.ts   entry, root module, shared setup (used by main and the e2e tests)
├── config/          env schema, constants (retrieval settings, queue names)
├── common/          errors (AppError + exception filter), pipes (zod), utils
├── database/        Drizzle schema (all tables), database module, migrations/
├── integrations/    ai (Python client), redis
├── queues/          BullMQ connection and the ingest / eval queues
└── modules/         one folder per feature (health so far)
test/                e2e tests
```

## Decisions

- **NestJS 11, not 12.** Nest 12 is ESM-only; 11 is the CommonJS line the docs and ecosystem still use.
- **Fastify** adapter, with `@fastify/helmet` and `@fastify/cookie`; `fastify` is pinned to `^5.12.5` (an `overrides` entry) because
  Nest 11's own pin has two published advisories.
- **`pg` + Drizzle**; migrations are generated, then the first one was edited by hand to create the `vector` and `pgcrypto` extensions.
- **Health is `degraded`, not failing, while the AI service is down**, so the API stays usable during development before that service exists.
- Remaining `npm audit` findings are dev-only tooling (drizzle-kit's esbuild, vitest's mocker).
