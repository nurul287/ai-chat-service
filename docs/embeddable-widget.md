# Embeddable widget

Paste one `<script>` tag onto any page and get a working chat bubble,
backed by this service's chat engine.

## Quick start

```bash
pnpm create-tenant "Acme Pharmacy" acme-pharmacy
pnpm set-allowed-origins acme-pharmacy https://acme.com https://www.acme.com
pnpm issue-publishable-key acme-pharmacy
```

Paste the printed key into a script tag on your page:

```html
<script src="https://your-instance/widget.js"
        data-key="pk_live_..."
        data-color="#4f46e5"
        data-position="bottom-right"></script>
```

That's it — a chat bubble appears, backed by whatever documents and
custom tools you've already configured for this tenant.

## Publishable vs. secret keys

A **publishable** key (`pk_live_…`) is meant to be public — it's going to
sit in your page's HTML source, visible to anyone who views it, exactly
like a Stripe publishable key or a Google Maps API key. That's by design,
not an oversight: the security boundary isn't secrecy of the key, it's the
**domain allowlist** you set with `pnpm set-allowed-origins`.

A publishable key only works from a browser sending one of those origins
as its `Origin` header, when read through this service's CORS
configuration. The server also independently checks that same header on
every request, which closes a real gap CORS alone would leave — a
disallowed origin is rejected even if a misconfigured CORS setup would
have let it through. But `Origin` is an ordinary request header, not a
cryptographic proof of origin, so this is **not** a defense against a
deliberate attacker who already has the key and can set any header they
like with a tool like `curl`.

There is no rate limiting or usage quota on this yet (that lands in
Sprint 6) — until then, treat a published `pk_live_…` key as effectively
enabling anonymous, unmetered access to your tenant's chat engine, billed
to you.

A publishable key also cannot read or write documents, register custom
tools, or do anything a secret key can — it only works against the
`/widget/*` routes. Never put a **secret** key (`sk_live_…`) anywhere a
browser can see it; that one really is a secret. See
[authentication.md](authentication.md) for the full contrast.

## Customization

Read from attributes on the widget's own script tag — no dashboard, no
separate configuration step:

| Attribute | Default | Notes |
|---|---|---|
| `data-key` | — | Required. Your `pk_live_…` key. |
| `data-color` | `#4f46e5` | Bubble and accent color, any valid CSS color. |
| `data-position` | `bottom-right` | `bottom-right` or `bottom-left`. |

## How it works

- The widget mints a session once (`POST /widget/session`) and persists
  the returned id in `localStorage`, so a returning visitor keeps their
  conversation history across page loads.
- Every message goes to `POST /widget/chat` — the same SSE framing as
  `POST /v1/chat` (see [errors.md](errors.md)), authenticated by the
  publishable key and restricted to allowed origins instead of a secret
  key, but with a narrower event set: only `token`, `done`, and `error`
  are streamed. `/v1/chat`'s `sources` and `tool_call` events are
  withheld here, since they carry verbatim document content and raw
  custom-tool responses that aren't meant for public display.
- CORS is configured per-request based on your tenant's allowed origins,
  but that's only what lets a browser *read* the response. The same
  `Origin` header is also checked server-side on every request,
  independent of CORS — so a real browser on an unauthorized origin is
  rejected either way, and a CORS misconfiguration alone can't open the
  route up. That check reads a header the client sends, though: a
  non-browser client that ignores CORS can also just set `Origin` to an
  allowed value, so it stops honest misuse and misconfiguration, not a
  deliberate attacker holding the key.

## What's not here yet

No dashboard for managing keys or origins visually — everything above is
CLI-driven for now. No color-scheme presets, no custom CSS injection, no
avatar/logo upload. A tenant dashboard is a later sprint.
