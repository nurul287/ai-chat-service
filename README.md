# ai-chat-service

Multi-tenant retrieval service. Tenants push arbitrary documents over HTTP and
search them with hybrid (vector + keyword) retrieval. Domain-agnostic — a
product catalog, a pharmacy inventory, and a docs site are all just documents.

> The name `ai-chat-service` is a working title. It appears only in
> `package.json` and this file.

## Local setup

```bash
pnpm install
cp .env.example .env       # add your VOYAGE_API_KEY
pnpm db:start              # local Supabase (Docker) on ports 55321-55324
pnpm db:reset              # apply migrations
pnpm create-tenant "Acme Pharmacy" acme-pharmacy
pnpm dev
```

Local Supabase deliberately runs on a **55321-55324** port block rather than
the Supabase default of 54321-54324, so it can coexist with another local
Supabase stack on the same machine. Sharing the default block risks silently
pointing this service — and its table-truncating test suite — at the wrong
database.

> **`pnpm test` truncates `tenants`, `api_keys`, `documents` and `chunks`.**
> It runs against the same local database as `pnpm dev`, so a test run wipes
> any tenant you created by hand for manual testing. If a manual `curl` starts
> returning `unauthorized` right after a test run, the key was not revoked —
> its tenant row was truncated. Re-run `pnpm create-tenant`.

> **Adding a required env var is a two-file change.** `src/config/index.ts`
> validates the environment at import time, so _every_ test file fails config
> validation the moment a new required variable exists but is not also added to
> `.github/workflows/ci.yml`'s `env:` block. A passing local build never
> catches this, because your `.env` already has it.

## API

All `/v1` routes require `Authorization: Bearer <api key>`.

| Method   | Path                        | Purpose                      |
| -------- | --------------------------- | ---------------------------- |
| `PUT`    | `/v1/documents`             | Create or replace a document |
| `GET`    | `/v1/documents`             | List this tenant's documents |
| `DELETE` | `/v1/documents/:externalId` | Delete a document            |
| `POST`   | `/v1/search`                | Hybrid search over documents |
| `GET`    | `/health`                   | Liveness probe (no auth)     |
| `GET`    | `/docs`                     | Swagger UI (no auth)         |
| `GET`    | `/openapi.json`             | OpenAPI spec (no auth)       |

```bash
curl -X PUT http://localhost:4000/v1/documents \
  -H "Authorization: Bearer sk_live_..." \
  -H "Content-Type: application/json" \
  -d '{"externalId":"sku-1","title":"Paracetamol","content":"Relieves fever and mild pain."}'

curl -X POST http://localhost:4000/v1/search \
  -H "Authorization: Bearer sk_live_..." \
  -H "Content-Type: application/json" \
  -d '{"query":"something for a fever"}'
```

Full guides live in [`docs/`](docs/); runnable examples in
[`examples/`](examples/).

## Scripts

| Script            | Purpose                                        |
| ----------------- | ---------------------------------------------- |
| `pnpm dev`        | Watch-mode server on `PORT` (default 4000)     |
| `pnpm build`      | `tsc` to `dist/` (excludes test files)         |
| `pnpm typecheck`  | `tsc --noEmit`, including test files           |
| `pnpm test`       | Vitest against real local Postgres             |
| `pnpm lint`       | ESLint (flat config, type-aware)               |
| `pnpm format`     | Prettier write                                 |
| `pnpm db:start`   | Start local Supabase                           |
| `pnpm db:reset`   | Re-apply all migrations (destructive)          |
| `pnpm create-tenant "<name>" <slug>` | Create a tenant, print its key |

## Tenant isolation

Every query against `documents` and `chunks` is filtered by `tenant_id`, taken
only from the authenticated API key — never from a request body, query param,
or path segment. `documents.routes.test.ts`, `documents.service.test.ts`, and
`retrieve.test.ts` all assert that one tenant cannot read or delete another's
data.

## Plans

The Sprint 1 plan this repo was built from, and the 6-sprint roadmap it belongs
to, are in [`docs/plans/`](docs/plans/).
