# Dashboard API

The `/dashboard/*` routes power the self-serve tenant dashboard (see the
`ai-chat-dashboard` frontend repo). Unlike `/v1/*` (secret key) and
`/widget/*` (publishable key), these routes are authenticated by a
**Supabase Auth session token** — the same token `supabase-js` hands you
after `signInWithPassword`, `signInWithOtp`, or a successful `signUp`.

Send it exactly like an API key:

```
Authorization: Bearer <supabase-access-token>
```

## First-time signup

A Supabase Auth account has no tenant until `POST /dashboard/signup` is
called once — typically right after the frontend detects `GET
/dashboard/tenant` returning 404. Signup mints the account's first secret
key in the same response; that plaintext key is shown exactly once and
cannot be retrieved again (see [authentication.md](authentication.md)).

## Routes

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/dashboard/tenant` | The tenant owned by the authenticated account. 404 before signup. |
| `POST` | `/dashboard/signup` | Create the tenant + mint its first secret key. 409 if one already exists. |
| `GET` / `PUT` | `/dashboard/documents` | Same behavior as `/v1/documents`, dashboard-session authenticated. |
| `DELETE` | `/dashboard/documents/:externalId` | Same behavior as `/v1/documents`, dashboard-session authenticated. |
| `GET` | `/dashboard/keys` | List this tenant's secret keys (never the raw key). |
| `POST` | `/dashboard/keys` | Issue a new named secret key. |
| `DELETE` | `/dashboard/keys/:id` | Revoke a secret key. |
| `GET` | `/dashboard/widget` | This tenant's widget config (allowed origins, publishable key prefix). |
| `PUT` | `/dashboard/widget/origins` | Replace the allowed-origins list. |
| `POST` | `/dashboard/widget/publishable-key` | Mint (or re-mint) the publishable key. |
| `GET` | `/dashboard/usage?days=30` | Messages/tokens over time plus all-time totals. |

## CORS

`/dashboard/*` is reachable from exactly one browser origin: the deployed
dashboard (`DASHBOARD_URL`), plus `http://localhost:5173` outside
production. Unlike `/widget/*`, this allowlist is not per-tenant — the
dashboard is one app, not something each tenant configures.

Full schemas and try-it-out are always available at `/docs`.
