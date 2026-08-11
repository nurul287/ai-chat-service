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
| `CHAT_MODEL_PROVIDER`   | no          | `openrouter` | `openrouter` \| `anthropic`                                  |
| `CHAT_MODEL_ID`         | no          | `deepseek/deepseek-r1:free` | See the delisting runbook below                |
| `OPENROUTER_API_KEY`    | conditional | —            | Required when `CHAT_MODEL_PROVIDER=openrouter` (the default) |
| `ANTHROPIC_API_KEY`     | conditional | —            | Required when `CHAT_MODEL_PROVIDER=anthropic`                |
| `TOOL_SECRETS_ENCRYPTION_KEY` | yes   | —            | **64 hex characters (32 bytes).** Encrypts custom-tool secrets at rest — see below |

Configuration is validated by Zod at import time, so a missing or malformed
variable crashes the process at boot with the variable's name — never as an
`undefined` surprise on a live request.

### `TOOL_SECRETS_ENCRYPTION_KEY`

Required at boot, with no default — the service will not start without it.
It is the AES-256-GCM key for per-tenant custom-tool secrets (each tool's
HMAC signing secret and its optional static auth header value). Unlike API
keys, those must be readable back to sign an outgoing request, so they are
encrypted rather than hashed.

Generate one:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> **Back this up, and do not rotate it casually.** Changing it makes every
> already-stored tool secret **permanently undecryptable** — there is no
> re-encryption path. Tools whose secrets can no longer be read are skipped
> at chat time (chat itself keeps working; those tools simply disappear from
> the model's toolset), and recovering means revoking and re-registering each
> affected tool — which issues a new `hmacSecret` that the tenant then has to
> deploy to their own endpoint.

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

### Changing the schema

Migrations are generated from `src/db/schema.ts`, not hand-written:

1. Edit `src/db/schema.ts` — add or change a table, column, or index.
2. Run `pnpm db:generate`. This produces a new file under
   `supabase/migrations/`, named to match Supabase's own convention.
3. Open the generated file and skim it — you're reviewing, not authoring.
4. Apply it exactly like any other migration: `pnpm db:reset` locally,
   `pnpm db:push` (via a linked project) in production.

Supabase CLI still owns applying and tracking migrations, in both
environments — nothing about `db:start`/`db:reset`/`db:push`/`db:link` changes.
Only the *authoring* step moved from hand-written SQL to a generated diff.

### Why the non-default ports

The local stack uses **55321–55324**, not Supabase's default 54321–54324, so it
can run alongside another local Supabase project. If you only ever run one, the
defaults are fine — but sharing a port block risks something worse than a
conflict: the service silently connecting to the _other_ project's database.
The test suite truncates tables, so that mistake is not recoverable.

### When `CHAT_MODEL_ID` stops working

OpenRouter's free-tier models rotate and get delisted without warning — this
is a known, expected occurrence, not a bug in this service. If chat requests
start failing with a model-not-found or similar error from the provider:

1. Check <https://openrouter.ai/models?supported_parameters=tools&free> for a
   current replacement that supports tool calling (`search_knowledge` requires
   it).
2. Update `CHAT_MODEL_ID`, redeploy. No code change needed — this is exactly
   why the model id is a config value rather than a constant.

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

- Build: **Railpack** (Railway's successor to Nixpacks, and the default for new
  services)
- Start: `node dist/server.js`
- Healthcheck: `/health`, 30s timeout
- Restart: on failure, max 3 retries

### Why the pnpm version is pinned three ways

Builders infer the toolchain, and a builder that picks a different pnpm than
you run locally fails in ways that look nothing like a version problem. This
repo saw both:

- pnpm 9 cannot read a lockfile written by pnpm 11 (`ERR_PNPM_BROKEN_LOCKFILE`).
- Nixpacks pinned `corepack@0.24.1`, too old to load pnpm 11's entrypoint
  (`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`).

So the version is declared explicitly (`packageManager` in `package.json`, which
Railpack honours via Corepack), **and** the repo is kept installable under
pnpm 9, 10 and 11 alike — `pnpm-workspace.yaml` carries a `packages` field so
older pnpm does not reject it, and the lockfile is a single YAML document.
Belt and braces, because each failed guess costs a deploy cycle to discover.

### Docker fallback

`docker/Dockerfile` is a fully working alternative build, kept deliberately
outside the repo root so Railway's Dockerfile auto-detection cannot override
the Railpack setting above. It pins pnpm explicitly, runs as a non-root user,
and ships production dependencies only.

Use it if Railpack ever misbehaves — switch `railway.json` to:

```json
"build": { "builder": "DOCKERFILE", "dockerfilePath": "docker/Dockerfile" }
```

It can also be verified locally, which no builder-inferred image can:

```bash
docker build -f docker/Dockerfile -t ai-chat-service .
```

Create a **new, dedicated Railway project** — do not add this service to an
existing project. Point it at this GitHub repo and set these service variables:

| Variable         | Value                                     |
| ---------------- | ----------------------------------------- |
| `DATABASE_URL`   | Your Supabase connection string           |
| `VOYAGE_API_KEY` | Your Voyage key                           |
| `OPENROUTER_API_KEY` | Your OpenRouter key (the default chat provider) |
| `TOOL_SECRETS_ENCRYPTION_KEY` | 64 hex characters — generate as above, and back it up |
| `NODE_ENV`       | `production`                              |
| `PUBLIC_URL`     | The Railway public domain, once generated |

Leave `PORT` unset initially — Railway injects a port dynamically and the
service reads it, which is correct for a fresh domain that auto-tracks the
port the app actually binds. **If the healthcheck fails with `502 Application
failed to respond` despite deploy logs showing a clean boot**, the domain has
a fixed `targetPort` (check with `railway domain list`) that isn't tracking
the dynamic assignment — set `PORT` explicitly to that same value (this
repo's default is `4000`) so the app always binds where the domain expects.
This was the actual fix needed the first time this repo was deployed.

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
