# Sprint 5: Tenant Dashboard — Design

## Context

Per `docs/plans/roadmap.md`, Sprint 5's theme is **"Tenant dashboard"**: self-serve signup → create key → upload docs → see usage, with no CLI required. Today, every one of those steps requires direct terminal access to `create-tenant`, `issue-publishable-key`, and `set-allowed-origins`, run against a database connection only the operator has. This sprint replaces that with a real web UI a tenant can use on their own.

**Exit gate (unchanged from the roadmap):** a new tenant signs up, gets a key, uploads a document, configures the widget, and sees usage — entirely through the dashboard, no terminal.

## Scope

**In scope:**
- Self-serve signup/login via Supabase Auth (single login per tenant — no team/multi-user support yet)
- Document management (create/replace, list, delete)
- Secret-key management (list, create additional named keys, revoke)
- Widget setup (mint/re-mint a publishable key, manage allowed origins, pick a widget color, copy a ready-to-embed `<script>` snippet) — the Sprint 4 capability that was previously CLI-only
- A usage view: messages and tokens over time, sourced from the existing `chat_metrics` table

**Explicitly out of scope, deferred:**
- **Multi-user teams** (invites, roles) — parked in the backlog; today's design uses a single owner-per-tenant model, not a membership table
- **Billing / cost estimates** — no billing system exists yet (already flagged unscoped in the roadmap); the usage view shows real counts, not money
- **File upload parsing** (PDF/docx) — documents are created via a title+content form, same shape as the existing `PUT /v1/documents` API
- **Rate limiting / signup abuse protection** — Sprint 6's responsibility per the roadmap; Supabase Auth's own email-confirmation gate is the only guard for now
- Any change to the existing `/v1/*` or `/widget/*` contracts — Sprint 5 only adds new surface, nothing existing moves

## Data model

One new column, nothing else:

```sql
alter table tenants add column owner_user_id uuid unique references auth.users(id);
```

Every other table (`api_keys`, `documents`, `chunks`, `conversations`, `messages`, `chat_metrics`) is reused as-is. The dashboard is a new *client* of existing tenant-scoped data, not a new data model. `owner_user_id` is how a Supabase-authenticated request resolves to a tenant, mirroring how a hashed API key resolves to a tenant today.

## Backend — `dashboardAuthPlugin` + `/dashboard/*` routes (in `ai-chat-service`)

### Why a new auth mechanism

Dashboard users authenticate via Supabase Auth (a JWT), not an API key. API keys are SHA-256 hashed at rest and can never be retrieved once issued (a deliberate Sprint 1 decision, carried through Sprint 4's publishable keys) — so the dashboard cannot simply "use the tenant's key" to call the existing `/v1/*` API on the user's behalf. Two alternatives were considered and rejected:

- **Minting and storing a reversibly-encrypted key for the dashboard to use** would reverse the Sprint 1 hashing invariant — a DB breach would then yield usable full-access keys instead of just hashes.
- **Having the user paste their own secret key into the browser** doesn't satisfy "no CLI" (there's still no way to get that first key without a terminal) and contradicts `docs/authentication.md`'s existing warning to never put a secret key in a browser.

Instead, the backend gets a **new auth plugin** that verifies the Supabase-issued session token directly, following the same `decorateRequest`/preHandler shape as the existing `authPlugin` (Sprint 1) and `publishableAuthPlugin` (Sprint 4) — a third auth mechanism in an already-established pattern, not a new one.

### Auth verification

The preHandler calls Supabase's own `auth.getUser(token)` via `supabase-js` — the officially recommended pattern for a backend verifying a client-issued Supabase session token. It works identically for password and magic-link sessions, and needs only the project's public anon key, not a service-role secret. Two new env vars: `SUPABASE_URL`, `SUPABASE_ANON_KEY`.

On success, the plugin resolves `request.tenant` by looking up `tenants.owner_user_id = user.id`.

### Routes

New `/dashboard/*` prefix, structurally separate from `/v1/*` — mirroring how `/widget/*` was kept separate in Sprint 4.

| Route | Purpose |
|---|---|
| `GET /dashboard/tenant` | Current tenant's record. 404 if this Supabase user has no tenant yet → frontend shows onboarding. |
| `POST /dashboard/signup` | `{ tenantName, tenantSlug }` → creates the tenant + mints the first secret key (named `"default"`, same as the CLI). 409 if this user already owns a tenant. Returns the plaintext key **once**, same UX as `create-tenant.ts` today. |
| `GET` / `PUT` / `DELETE /dashboard/documents` | Thin wrappers over the existing `documents.service.ts` — same functions Sprint 1 already built, just resolved from a JWT instead of an API key. No service-layer duplication. |
| `GET /dashboard/keys` | Lists secret keys: name, prefix, `lastUsedAt`, `revokedAt` — never the hash. New `listApiKeys(tenantId)` service function. |
| `POST /dashboard/keys` | `{ name }` → new named secret key, plaintext shown once. |
| `DELETE /dashboard/keys/:id` | Revokes a key, tenant-scoped (can't touch another tenant's key). New `revokeApiKey(tenantId, keyId)`. |
| `GET /dashboard/widget` | `{ allowedOrigins, publishableKeyPrefix, hasPublishableKey }`. |
| `POST /dashboard/widget/publishable-key` | Mints (or re-mints) the publishable key — plaintext shown once, same hashing-at-rest as today, so a lost key means re-minting, not retrieval. |
| `PUT /dashboard/widget/origins` | `{ origins: string[] }` → calls the existing `setAllowedOrigins`. |
| `GET /dashboard/usage?days=30` | Aggregates `chat_metrics`/`conversations`/`messages`, tenant-scoped, grouped by day. New `getUsageSummary(tenantId, days)` — pure query, no new tables. |

**Widget color:** Sprint 4's widget already reads `data-color`/`data-position` straight off the `<script>` tag, entirely client-side — so "picking a color" is just the dashboard's snippet generator choosing what to print in the copy-pasteable tag it shows the tenant. No backend storage, no new route.

**Signup abuse:** protection is Supabase Auth's own concern (email confirmation, captcha) — no new rate limiting here, consistent with the roadmap's existing decision to defer all rate limiting to Sprint 6.

## Frontend — new `ai-chat-dashboard` repo

A separate repo, mirroring the existing `Aurevo.BE`/`Aurevo.UI` split rather than a directory inside `ai-chat-service`.

**Stack:** React + Vite + TypeScript + Tailwind + `@supabase/supabase-js` for auth (password signup/login, magic-link `signInWithOtp`, session persisted via Supabase's own client-side storage) + **shadcn/ui** for components — matching `Aurevo.UI`'s existing convention (Radix-based components copied into the repo as owned code, not an opaque dependency). Charts for the usage view via a lightweight library such as `recharts`, which shadcn's own chart component wraps.

**Pages:**

| Route | Purpose |
|---|---|
| `/login` | Email+password form, with a magic-link option |
| `/signup` | Supabase Auth registration (email/password) |
| `/onboarding` | Tenant name/slug form → `POST /dashboard/signup` → shows the plaintext secret key **once**, with a copy button and a "store this now" warning |
| `/` | Dashboard home — usage summary card + quick links |
| `/documents` | List, create/replace (externalId/title/content form), delete |
| `/keys` | List secret keys, create named keys, revoke (with a confirm dialog) |
| `/widget` | Allowed-origins editor, publishable-key mint/re-mint, color picker, live copy-pasteable `<script>` snippet |
| `/usage` | The detailed messages/tokens-over-time view |

**Auth guard:** any route but `/login`/`/signup` redirects to `/login` with no Supabase session; any route but `/onboarding` redirects there if the session is valid but `GET /dashboard/tenant` 404s (no tenant yet).

**API client:** a small typed fetch wrapper reads the current Supabase access token (`supabase.auth.getSession()`) and attaches it as `Authorization: Bearer …` on every `/dashboard/*` call — token refresh is handled by `supabase-js` itself, not hand-rolled.

**Deploy:** Vercel. Env vars: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_BASE_URL` (pointing at the Railway-deployed `ai-chat-service`).

## Error handling

- Backend `/dashboard/*` errors follow the same `{ error: { code, message } }` contract as `/v1/*` and `/widget/*` — no new error shape to document.
- Supabase Auth errors (invalid credentials, unconfirmed email, expired magic link) are surfaced from `supabase-js` client-side and shown inline on the form — the backend never sees password-related failures at all.
- A 401 from any `/dashboard/*` call (expired/invalid session) redirects to `/login` rather than showing a raw error.
- Key revocation and document deletion both get a confirm dialog (shadcn `AlertDialog`), since both are hard-to-reverse from the tenant's perspective — a revoked key breaks whatever was using it, a deleted document is gone.

## Testing

- **Backend:** Vitest, same conventions as the rest of `ai-chat-service` — `dashboardAuthPlugin` tested against a real local Postgres tenant with a mocked Supabase `getUser()` response (matching how Voyage is mocked today), route tests via `app.inject()` for every new `/dashboard/*` endpoint, plus the tenant-isolation pattern already proven three times (Sprints 1/3/4): a second tenant must never see the first tenant's keys/documents/usage.
- **Frontend:** component/integration tests with Vitest + React Testing Library for the forms and auth-guard logic. No e2e framework for a first version — manual verification against the real local Supabase + local API, the same way Sprint 4's widget was verified.
