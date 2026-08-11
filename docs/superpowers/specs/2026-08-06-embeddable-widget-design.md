# Sprint 4: Embeddable Widget — Design

**Status:** Approved, ready for implementation planning.

## Goal

Let a tenant paste one `<script>` tag onto any page and get a working chat
bubble, backed by this service's existing chat engine — without ever
exposing a secret key to a browser. This is Sprint 4 of the 6-sprint
roadmap (`docs/plans/roadmap.md`), depending on Sprint 2 (merged).

**Exit gate** (from the roadmap, unchanged): a publishable key cannot
read/write documents; a domain allowlist actually blocks a disallowed
origin.

## Non-goals (explicitly deferred)

- **A tenant-facing dashboard.** Sprint 5 owns all self-serve UI
  (signup, key management, visual settings). Sprint 4's only interface for
  issuing a publishable key or setting the domain allowlist is the CLI,
  extending the existing `create-tenant` tooling — matching how every
  credential-management operation in this project has worked so far.
- **Rich widget customization.** Color/position are read from `data-*`
  attributes on the embed script tag itself. No settings API, no stored
  per-tenant widget config beyond what's needed for Sprint 4's own
  security requirements (the domain allowlist).
- **Per-key domain scoping.** One tenant has one shared `allowed_origins`
  list; every publishable key that tenant issues is checked against it.
  Simpler than per-key lists, and nothing in the exit gate asks for more.
- **Server-side session expiry/rotation.** The widget session endpoint
  mints an id; nothing about it is stored or tracked server-side until
  it's actually used in a conversation (which already persists via
  `conversations`/`messages`). Revisit if abuse patterns ever require it.

## Publishable keys

A new key type, parallel to the existing `sk_live_…` secret keys:

- Prefix `pk_live_…`, same random-token-then-hash storage pattern as
  `generateApiKey`/`hashApiKey` (`src/auth/api-key.ts`) — SHA-256, not a
  slow KDF, for the same reason: it's 256 bits of random entropy, not a
  human password.
- The `api_keys` table gets a `kind` column (`'secret' | 'publishable'`),
  defaulting existing rows to `'secret'` via the migration. `verifyApiKey`
  is extended to optionally filter by kind, so a publishable key
  presented to any `/v1/*` route is rejected exactly as if it were absent
  — the existing secret-key auth plugin never needs to know publishable
  keys exist.
- Publishable keys are safe to embed in page source by design — the
  security boundary is the domain allowlist below, not secrecy of the key
  itself. `docs/authentication.md` gets a new section making this
  distinction explicit (the existing warning about never shipping a
  *secret* key to a browser stays unchanged and now has something to
  contrast against).

## Domain allowlist

A new `allowed_origins` jsonb array column on `tenants` (default `[]`) —
one shared list per tenant, set via CLI. Exact-origin matching (scheme +
host + port, e.g. `https://acme.com`), no wildcard/subdomain matching in
this sprint — YAGNI until a real tenant needs it.

Enforced in **two places**, deliberately redundant:

1. **Dynamic CORS**, so a legitimate browser request from an allowed
   origin actually works: `@fastify/cors`'s `origin` option becomes a
   function that looks up the tenant (from the presented publishable key)
   and checks the request's `Origin` against `allowed_origins`.
2. **A server-side check in the route handler itself**, independent of
   CORS. CORS is a browser-enforced mechanism — it controls whether a
   browser's JS may *read* a response, not whether the server processes
   the request at all, and it provides no protection against a non-browser
   client that simply ignores or spoofs the `Origin` header. The
   allowlist's actual enforcement is this server-side check; CORS is only
   what makes the legitimate case usable.

A missing `Origin` header, or one not on the allowlist, is rejected with
`401 unauthorized` (indistinguishable from a bad key — this project's
existing anti-probing convention).

## A new route group, structurally outside `/v1`

`src/plugins/auth.ts`'s `authPlugin` is `fp`-wrapped specifically so its
preHandler attaches to the **enclosing** scope — `app.ts` registers it
inside the `/v1` wrapper, so every route nested inside that wrapper
inherits secret-key auth and closed CORS, including any new sub-route
added there. A widget route nested under `/v1` would incorrectly inherit
that.

So Sprint 4 adds a sibling top-level prefix, registered in `app.ts`
alongside (not inside) the `/v1` block:

```
POST /widget/session
POST /widget/chat
```

with their own `publishableAuthPlugin` (resolves `pk_live_…` → tenant,
checks `Origin` against `allowed_origins`) and their own dynamic-CORS
registration, scoped only to `/widget/*` — `/v1/*` keeps its closed CORS
and secret-key auth completely unchanged.

### `POST /widget/session`

Mints a fresh UUID and returns `{ externalUserId }`. No request body.
Nothing is persisted — the id only becomes meaningful once used in an
actual conversation.

### `POST /widget/chat`

Same auth (publishable key + Origin check) as `/widget/session`. Body:
`{ externalUserId, conversationId?, message }` — structurally identical
to `/v1/chat`'s body. The handler calls the **existing**
`runChat()` from `src/chat/chat.service.ts` directly, unchanged — zero
duplication of Sprint 2/3's chat logic, tool loop, or SSE event shapes.
Same `@fastify/sse` streaming response as `/v1/chat`.

## The widget bundle

New top-level `widget/` directory (sibling to `src/`, not inside it) —
this is browser-targeted code with a different runtime and build step
than the Node/Fastify server, so it gets its own source tree rather than
living inside `src/`, which the existing `tsconfig.build.json` compiles
for Node/CommonJS.

```
widget/
├── src/
│   ├── index.ts       entry point: reads config, mints/persists session, renders bubble
│   ├── session.ts      pure: generate/read/persist the externalUserId in localStorage
│   └── ui.ts           minimal DOM rendering: bubble toggle, message list, input
└── build.mjs           esbuild script → single dependency-free bundle
```

Config is read from `data-*` attributes on the widget's own `<script>`
tag (found via `document.currentScript`):

```html
<script src="https://your-instance/widget.js"
        data-key="pk_live_..."
        data-color="#4f46e5"
        data-position="bottom-right"></script>
```

`build.mjs` bundles `widget/src/index.ts` to a single file; a new
`app.get("/widget.js", ...)` route in `app.ts` serves it with
`Content-Type: application/javascript` and a long cache lifetime (it's
static per deploy).

**UI scope for this sprint**: a closed bubble icon; clicking opens a
minimal panel (message list + text input); sends via `POST
/widget/chat`, consuming its SSE stream the same way `examples/node/chat.js`
already demonstrates client-side event handling, adapted for the DOM
instead of the console. No typing indicators, no read receipts, no
persistence of scroll position — the exit gate is "produces a working
chat bubble," not a polished product.

## Testing

- **Route tests** (`src/widget/widget.routes.test.ts`, mirroring the
  existing `chat.routes.test.ts` pattern — real Postgres, `app.inject()`):
  a publishable key on `/v1/documents` is rejected; a secret key on
  `/widget/chat` is rejected; a request from a disallowed `Origin` is
  rejected even with a valid key; a request from an allowed `Origin`
  succeeds and streams the same event shapes `/v1/chat` does.
- **`session.ts` unit tests**: run under Vitest's `jsdom` environment
  (selected per-file via a `// @vitest-environment jsdom` docblock, not a
  project-wide change) so `localStorage` is real rather than mocked —
  generates once, persists, returns the same id on a second call.
- **Domain allowlist isolation**: two tenants, two different
  `allowed_origins` — tenant A's key from tenant B's allowed origin is
  still rejected (the key resolves to a tenant, and *that* tenant's list
  is what's checked, not any list containing the origin).

## Documentation

New `docs/embeddable-widget.md` (ships with this sprint, not after, per
the roadmap's own rule): how to issue a publishable key via CLI, how to
set the domain allowlist, the exact `<script>` tag to paste, and the
explicit "publishable keys are meant to be public, secret keys are not"
distinction. `docs/authentication.md` gets a short cross-reference.
