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

## Production topology

This service owns its infrastructure end to end. It shares **nothing** with any
other project — not a database, not a Railway project, not a Supabase
organisation's resources beyond its own project.

```
GitHub: nurul287/ai-chat-service
   │  push to main
   ▼
Railway project "ai-chat-service"   ──────►   Supabase project "ai-chat-service"
  └── service: api (this repo)                  └── Postgres + pgvector
      Nixpacks build, /health check                 migrations from supabase/migrations/
```

The only external dependency is the **Voyage AI** API key for embeddings.

### Applying migrations to the hosted database

Link once, then push. The Supabase CLI tracks which migrations have been
applied, so re-running is safe.

```bash
pnpm db:link --project-ref <your-project-ref>   # prompts for the DB password
pnpm db:push                                     # applies pending migrations
```

`--project-ref` is the subdomain of your Supabase project URL
(`https://<ref>.supabase.co`). Verify afterwards:

```sql
select extname from pg_extension where extname = 'vector';
select tablename from pg_tables where schemaname = 'public' order by 1;
-- expect: api_keys, chunks, documents, tenants
```

Migrations are **not** applied automatically on deploy. Run `pnpm db:push`
before the deploy that needs them.

### Connection string: which one to use

Supabase offers several. **Use a pooler string.** The direct host,
`db.<ref>.supabase.co`, resolves to an **IPv6 address only** unless you pay for
the IPv4 add-on — on an IPv4-only network it fails with `ENOTFOUND`, which
looks like a bad password or a dead project and is neither.

| Connection         | Host                                 | Port | When                                         |
| ------------------ | ------------------------------------ | ---- | -------------------------------------------- |
| Session pooler     | `aws-N-<region>.pooler.supabase.com` | 5432 | Default. IPv4-reachable.                     |
| Transaction pooler | `aws-N-<region>.pooler.supabase.com` | 6543 | Many instances, or hitting connection limits |
| Direct             | `db.<ref>.supabase.co`               | 5432 | Only with the IPv4 add-on                    |

Pooler connections use `postgres.<ref>` as the username, not plain `postgres`.

The service enables TLS for any non-private host, and disables prepared
statements when it detects the transaction pooler — that pooler multiplexes one
server connection across many clients, so a prepared statement from one is
invisible to the next. Getting this wrong produces intermittent
`prepared statement does not exist` errors under load rather than a clean
failure at startup, which is why it is derived from the URL rather than left to
a flag someone can set inconsistently. See `src/db/connection-options.ts`.

## Deploying to Railway

`railway.json` is committed and configures the build and healthcheck:

- Build: Nixpacks, `pnpm build`
- Start: `node dist/server.js`
- Healthcheck: `/health`, 30s timeout
- Restart: on failure, max 3 retries

Create a **new, dedicated Railway project** — do not add this service to an
existing project. Point it at this GitHub repo and set these service variables:

| Variable         | Value                                     |
| ---------------- | ----------------------------------------- |
| `DATABASE_URL`   | Your Supabase connection string           |
| `VOYAGE_API_KEY` | Your Voyage key                           |
| `NODE_ENV`       | `production`                              |
| `PUBLIC_URL`     | The Railway public domain, once generated |

Do **not** set `PORT` — Railway injects it, and the service reads it.

`PUBLIC_URL` is chicken-and-egg: the domain does not exist until the first
deploy. Deploy without it, generate the domain, then set it and redeploy. Its
only effect is the `servers` entry in `/openapi.json`, so the first deploy is
fully functional without it.

A step-by-step version of all of this is in
[deployment-checklist.md](deployment-checklist.md).

## Operating notes

- **Logs** are JSON in production, one object per line, each carrying `reqId`.
  Every log line from a single request shares that id, including the error line
  if the request fails.
- **Rate limiting does not exist yet.** There are no per-tenant request or
  storage quotas in Sprint 1 — the service is single-tenant-by-trust. Do not
  expose it to an untrusted tenant before Sprint 6 adds limits.
- **Ingestion is synchronous.** A `PUT` embeds before it returns, so a large
  document takes as long as the Voyage call. There is no background queue.
