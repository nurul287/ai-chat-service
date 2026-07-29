# Self-hosting

## Requirements

- Node **22+**
- Postgres with the **`pgvector`** extension available. Supabase and
  `pgvector/pgvector:pg16` both work out of the box; a stock `postgres:16`
  image does **not** — `create extension vector` in migration 001 will fail.
- A [Voyage AI](https://dash.voyageai.com) API key for embeddings.

## Environment

| Variable                 | Required | Default       | Notes                                                              |
| ------------------------ | -------- | ------------- | ------------------------------------------------------------------ |
| `DATABASE_URL`           | yes      | —             | Postgres connection string. Boot fails immediately if unreachable. |
| `VOYAGE_API_KEY`         | yes      | —             | Boot fails without it, rather than failing on the first ingest.    |
| `VOYAGE_EMBEDDING_MODEL` | no       | `voyage-3`    | Must produce **1024** dimensions — see the warning below.          |
| `PORT`                   | no       | `4000`        |                                                                    |
| `NODE_ENV`               | no       | `development` | `production` switches logging to JSON; `test` silences it.         |
| `LOG_LEVEL`              | no       | `info`        | Any pino level.                                                    |
| `PUBLIC_URL`             | no       | —             | Public base URL. Becomes the primary `servers` entry in the spec.  |

Configuration is validated by Zod at import time, so a missing or malformed
variable crashes the process at boot with the variable's name — never as an
`undefined` surprise on a live request.

> **Changing the embedding model is a migration, not a config change.** The
> `embedding` column is `vector(1024)`, fixed to `voyage-3`. A model with a
> different dimensionality requires altering the column _and_ re-embedding every
> existing chunk. Decide before you have real data.

## Database setup

Migrations are plain SQL in `supabase/migrations/`, applied in filename order.

With the Supabase CLI:

```bash
pnpm db:start    # local Docker stack on ports 55321-55324
pnpm db:reset    # DESTRUCTIVE: drops everything and re-applies all migrations
```

Against any other Postgres:

```bash
for f in supabase/migrations/*.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
```

### Why the non-default ports

The local stack uses **55321–55324**, not Supabase's default 54321–54324, so it
can run alongside another local Supabase project. If you only ever run one, the
defaults are fine — but sharing a port block risks something worse than a
conflict: the service silently connecting to the _other_ project's database.
The test suite truncates tables, so that mistake is not recoverable.

## Running

```bash
pnpm install
pnpm build
pnpm start          # node dist/server.js
```

The server listens on `0.0.0.0` rather than loopback, so it is reachable from
outside a container. It checks the database at boot and exits non-zero if it is
unreachable, and it drains in-flight requests on `SIGTERM`/`SIGINT` before
closing the connection pool.

## Creating tenants

There is no signup UI in Sprint 1 — tenants are created from the CLI, on a
machine with `DATABASE_URL` pointing at the target database:

```bash
pnpm create-tenant "Acme Pharmacy" acme-pharmacy
```

The API key is printed once and stored only as a hash. A self-serve dashboard
arrives in Sprint 5.

## Deploying to Railway

`railway.json` is committed and configures the build and healthcheck:

- Build: Nixpacks, `pnpm build`
- Start: `node dist/server.js`
- Healthcheck: `/health`, 30s timeout
- Restart: on failure, max 3 retries

Set `DATABASE_URL`, `VOYAGE_API_KEY`, `NODE_ENV=production`, and `PUBLIC_URL`
in the Railway service variables. Migrations are **not** run automatically —
apply them against the production database yourself before the first deploy.

## Operating notes

- **Logs** are JSON in production, one object per line, each carrying `reqId`.
  Every log line from a single request shares that id, including the error line
  if the request fails.
- **Rate limiting does not exist yet.** There are no per-tenant request or
  storage quotas in Sprint 1 — the service is single-tenant-by-trust. Do not
  expose it to an untrusted tenant before Sprint 6 adds limits.
- **Ingestion is synchronous.** A `PUT` embeds before it returns, so a large
  document takes as long as the Voyage call. There is no background queue.
