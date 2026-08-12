# Authentication

Every `/v1` route requires a secret API key as a Bearer token:

```
Authorization: Bearer sk_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

`GET /health`, `GET /docs`, and `GET /openapi.json` are open and require no key.

## Secret keys

A key beginning `sk_live_` is a **secret key**. It has full read and write
access to its tenant's documents: it can list them, replace them, and delete
them.

> **Never ship a secret key to a browser, a mobile app, or any client you do not
> control.** Anyone holding it can read, overwrite, and delete every document
> you have pushed. Server-side only — your backend calls this service, your
> frontend calls your backend.
>
> CORS is deliberately disabled on this service, so a browser cannot call it
> cross-origin even if a key leaks into frontend code. Treat that as a
> backstop, not permission.

Browser-safe **publishable keys**, with a per-tenant domain allowlist and no
write access, arrive in Sprint 4 alongside the embeddable widget. Until then
there is no supported way to call this API from a browser.

## Publishable keys

Sprint 4 adds a second key type, `pk_live_…`, for the [embeddable
widget](embeddable-widget.md). Unlike the secret keys above, a publishable
key is meant to be public — it's restricted by a per-tenant domain
allowlist instead of by secrecy, and it cannot access any `/v1/*` route
(documents, search, tools, or the secret-key chat endpoint). See
[embeddable-widget.md](embeddable-widget.md) for the full explanation and
setup steps.

## Storage

Keys are stored as **SHA-256 hashes only**. The plaintext is returned exactly
once, when the key is created, and is never logged or recoverable afterwards.

The first 12 characters are also stored in the clear (`sk_live_a1b2`) so a
future dashboard can identify a key in a list without holding anything that
could authenticate a request.

SHA-256 rather than bcrypt or argon2 is deliberate. A key is 256 bits of
`crypto.randomBytes` — it has no dictionary surface for a slow KDF to protect
against — and verification runs on every single authenticated request, where a
deliberately slow hash is pure latency.

## Rotation

Issue first, revoke second. In that order there is never a window without a
working key:

1. Issue a new key for the tenant.
2. Deploy it to every caller.
3. Confirm traffic has moved (a revoked key fails closed, so verify before, not
   after).
4. Revoke the old key.

A revoked key stops working immediately and returns `401` with code
`unauthorized` — indistinguishable from a key that never existed. That is
intentional: the API gives an attacker no way to tell a wrong key from a
withdrawn one.

## Losing a key

There is no recovery path, by design. Revoke it and issue a new one. If you
suspect a key has leaked, revoke it _first_ and deal with the outage — a live
secret key is full write access to your corpus.
