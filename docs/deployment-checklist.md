# Deployment checklist

Everything that has to be done by a human, in order. Each step says how to know
it worked before you move on.

This service is **standalone**: its own Supabase project, its own Railway
project, its own GitHub repo. The only thing it borrows from anywhere else is a
Voyage AI API key.

Budget about 30–40 minutes for a first run.

---

## 0. Before you start

- [ ] A **Supabase** account — https://supabase.com
- [ ] A **Railway** account — https://railway.app
- [ ] A **Voyage AI** API key — https://dash.voyageai.com
      (reusing the key from another project of yours is fine; it is billed per
      request, not per project)
- [ ] Repo access: https://github.com/nurul287/ai-chat-service

Nothing below touches any other project's database, Railway project, or
deployment.

---

## 1. Create the Supabase project

- [ ] Supabase dashboard → **New project**
- [ ] Name: `ai-chat-service`
- [ ] Generate a strong database password and **save it in your password
      manager now** — Supabase shows it once
- [ ] Region: pick the one nearest your Railway region (they talk to each other
      on every request; a mismatched pair adds latency to every query)
- [ ] Wait for provisioning to finish (~2 minutes)

**Verify:** the project dashboard loads and shows a Postgres version.

> Do not reuse an existing project. A shared database is exactly what this
> checklist exists to avoid — and this project's test suite truncates tables.

---

## 2. Collect the connection details

From **Project Settings → Database**:

- [ ] Copy the **connection string** (URI format)
- [ ] Substitute your saved password for the `[YOUR-PASSWORD]` placeholder
- [ ] Note the **project ref** — the subdomain in `https://<ref>.supabase.co`

Either the direct connection (port 5432) or the transaction pooler (6543) works;
the service detects which one you gave it and configures the driver
accordingly. Start with **direct (5432)** — it is simpler, and one Railway
instance will not exhaust the connection limit.

**Verify:** your connection string looks like
`postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres`

---

## 3. Apply the migrations

From a local clone, with the repo installed (`pnpm install`):

```bash
pnpm db:link --project-ref <your-project-ref>
pnpm db:push
```

`db:link` prompts for the database password from step 1.

**Verify** in Supabase → **SQL Editor**:

```sql
select extname from pg_extension where extname = 'vector';
select tablename from pg_tables where schemaname = 'public' order by 1;
```

Expect `vector`, and the four tables `api_keys`, `chunks`, `documents`,
`tenants`. If `vector` is missing, migration 001 did not run — stop and fix
that before deploying, because nothing will work without it.

---

## 4. Create the Railway project

- [ ] Railway → **New Project** → **Deploy from GitHub repo**
- [ ] Authorise Railway for the `nurul287/ai-chat-service` repo if prompted
- [ ] Select the repo. Railway detects `railway.json` and uses Nixpacks
- [ ] Rename the project to `ai-chat-service`

> Create a **new project**, not a new service inside an existing one. Separate
> projects keep billing, environment variables, and blast radius separate.

The first build will likely fail or crash-loop until step 5 — that is expected,
since the service refuses to boot without its configuration.

---

## 5. Set the environment variables

Railway → your service → **Variables**:

- [ ] `DATABASE_URL` — the connection string from step 2
- [ ] `VOYAGE_API_KEY` — your Voyage key
- [ ] `NODE_ENV` — `production`

**Do not set `PORT`.** Railway injects it and the service reads it. Setting it
yourself will bind the wrong port and every healthcheck will fail.

**Verify:** deployment logs show single-line JSON, including
`{"level":30,...,"msg":"database connection ok"}`. If you instead see
`Invalid configuration — …`, the message names the exact variable that is
missing or malformed.

---

## 6. Generate the public domain

- [ ] Railway → **Settings → Networking → Generate Domain**
- [ ] Copy the resulting `https://<something>.up.railway.app`
- [ ] Add it back as a variable: `PUBLIC_URL` = that URL
- [ ] Let it redeploy

`PUBLIC_URL` only affects the `servers` entry in the published OpenAPI spec, so
the service is fully functional before you set it. It is a second pass because
the domain does not exist until the first successful deploy.

**Verify:**

```bash
curl -s https://<your-domain>/health
# {"status":"ok"}
```

---

## 7. Create your first tenant

Tenants are created from the CLI against the production database. There is no
signup UI until Sprint 5.

From your local clone, with `DATABASE_URL` **temporarily** pointed at
production:

```bash
DATABASE_URL="postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres" \
  pnpm create-tenant "Acme Pharmacy" acme-pharmacy
```

- [ ] **Copy the printed `sk_live_…` key immediately.** It is stored only as a
      SHA-256 hash and can never be displayed again.
- [ ] Put it in your password manager.

> Afterwards, make sure your local `.env` still points at **localhost**.
> `pnpm test` truncates `tenants`, `api_keys`, `documents` and `chunks` — with
> a production `DATABASE_URL` in `.env`, a routine test run wipes production.
> This is the single most dangerous step in this document.

---

## 8. Smoke test the deployment

```bash
export API_KEY=sk_live_...
export BASE_URL=https://<your-domain>

curl -s -X PUT "$BASE_URL/v1/documents" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"externalId":"sku-1","title":"Paracetamol","content":"Paracetamol 500mg relieves fever and mild pain."}'

curl -s -X POST "$BASE_URL/v1/search" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"query":"reduce a high temperature"}'
```

- [ ] The `PUT` returns the document with ISO-8601 timestamps
- [ ] The search returns `sku-1`

That second call is the real proof the deployment works end to end. The query
shares no word with the document, so a hit means the Voyage key is valid, the
embedding round-trip succeeded, and pgvector is indexing — all three at once.

- [ ] `https://<your-domain>/docs` renders the API reference
- [ ] `https://<your-domain>/openapi.json` returns the spec

Or run the whole example suite against production:

```bash
API_KEY=sk_live_... BASE_URL=https://<your-domain> node examples/node/index.js
```

---

## 9. Before anyone else uses it

- [ ] **Do not hand the URL to an external tenant yet.** There is no rate
      limiting and no per-tenant quota until Sprint 6 — the service is
      single-tenant-by-trust, and an abusive or buggy caller can run up your
      Voyage bill without limit.
- [ ] Set a **spend alert** on your Voyage account.
- [ ] Consider enabling Supabase **Point-in-Time Recovery** if the corpus
      becomes hard to rebuild. The free tier keeps daily backups only.
- [ ] Decide the embedding model **now** if you ever intend to change it:
      the column is `vector(1024)`, pinned to `voyage-3`, and changing it later
      means a migration plus a full re-embed of every tenant's corpus.

---

## Recurring: deploying a change

1. Push to `main` — CI runs lint, typecheck and tests.
2. If the change includes a new migration, run `pnpm db:push` **before** the
   deploy that needs it.
3. Railway auto-deploys from `main`.
4. Confirm `/health` still returns `{"status":"ok"}`.

## If something is wrong

| Symptom                                        | Cause                                                           |
| ---------------------------------------------- | --------------------------------------------------------------- |
| `Invalid configuration — …` at boot            | A required env var is missing; the message names it             |
| Boot exits immediately, `database unreachable` | Wrong `DATABASE_URL`, or the password was not substituted       |
| Healthcheck fails but logs look fine           | `PORT` was set manually — remove it                             |
| `type "vector" does not exist`                 | Migrations were not applied; run `pnpm db:push`                 |
| `prepared statement ... does not exist`        | Should be handled automatically — file a bug with the URL shape |
| Search returns `[]` for everything             | Voyage key invalid or out of quota; check the deploy logs       |
| `401 unauthorized` on a key that worked        | Its tenant row was truncated by a test run against this DB      |
