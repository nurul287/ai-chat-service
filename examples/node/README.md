# Node example

A complete integration in one dependency-free file: ingests three documents,
runs three semantic searches, prints the results, and cleans up after itself.

## Run it

```bash
pnpm create-tenant "Example Co" example-co   # prints an sk_live_… key, once
API_KEY=sk_live_... node examples/node/index.js
```

Against a different host:

```bash
API_KEY=sk_live_... BASE_URL=https://your-service.example node examples/node/index.js
```

## Expected output

```
→ http://localhost:4000

Ingesting…
  sku-1  Paracetamol
  sku-2  Loratadine
  sku-3  Sterile bandage

3 document(s) in this tenant.

"reduce a high temperature"
  1. Paracetamol  [sku-1]
  ...

"my nose runs in spring"
  1. Loratadine  [sku-2]
  ...

"I cut my finger"
  1. Sterile bandage  [sku-3]
  ...

Cleaning up…
Done.
```

Each query matches its document without sharing a single word with it. That is
the vector leg working — a keyword search would return nothing for any of the
three.

## What to look at

- `call()` is the whole HTTP layer. Note that it branches on
  `payload.error.code`, never on the message — see
  [`docs/errors.md`](../../docs/errors.md).
- `PUT` is an upsert on `externalId`. Run the script twice: you still get three
  documents, not six.
