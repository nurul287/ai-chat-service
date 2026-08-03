# Concepts

Four ideas, and one of them you never touch.

## Tenant

A tenant is one isolated corpus. Every API key belongs to exactly one tenant,
and **every** query the service runs is filtered by the tenant resolved from
the key you authenticated with — never from anything in the request itself.

Practically: two tenants can both push a document with `externalId` of `sku-1`
and neither will ever see the other's. Searching with tenant B's key over
tenant A's content returns an empty list, not an error — from B's point of
view, A's data does not exist.

## Document

What you push. A document is:

| Field        | Notes                                                                    |
| ------------ | ------------------------------------------------------------------------ |
| `externalId` | **Your** id. Required. Re-pushing the same one replaces the document.    |
| `title`      | Optional. Returned with every search hit.                                |
| `content`    | Required. The text that gets embedded and searched. Up to 200,000 chars. |
| `metadata`   | Optional arbitrary JSON. Stored as-is and returned with every hit.       |

`externalId` being _yours_ is the important part. It means your sync job can be
a dumb loop — read your own records, `PUT` each one — and running it twice is
harmless. There is no create-vs-update decision to get wrong, and no way to end
up with duplicates.

`metadata` is a good place for anything you need to render a result but do not
want influencing the search: prices, URLs, image paths, category ids. It is not
searched and not filtered on in Sprint 1.

## Chunk

**You never manage chunks.** They are mentioned here only so the behaviour is
not surprising.

Long documents do not embed well as a single vector — meaning gets averaged
away. So the service splits `content` into chunks, embeds each one, and
searches over chunks. Splitting is paragraph-first, so a chunk rarely cuts
mid-idea; only a paragraph longer than the limit is hard-split, with a small
overlap carried across the cut so a fact spanning the boundary is still
retrievable.

Two consequences worth knowing:

- A search hit returns the **chunk** that matched, in `content`, alongside the
  `externalId` and `title` of its parent document. For a short document that is
  the whole thing; for a long one it is the relevant passage.
- Re-pushing a document replaces all of its chunks. Editing one sentence
  re-embeds the document. That is deliberate — a content edit shifts every
  offset after it, so replacing is both simpler and strictly correct.

## Retrieval

Search runs two independent legs and fuses them:

- **The vector leg** embeds your query and finds chunks with similar meaning.
  This is what matches "reduce a high temperature" to a document about
  paracetamol that never uses either word.
- **The keyword leg** is Postgres full-text search. This is what reliably
  matches an exact product code, a part number, or a surname — the cases where
  embeddings are weakest because the token carries no semantic content.

Results are combined with **Reciprocal Rank Fusion**: each leg contributes
`1 / (60 + rank)` to a chunk's score, and the combined ranking wins. A chunk
that both legs like beats one that only one leg loves.

Neither leg is a fallback for the other — they run concurrently and always
both contribute. If the keyword leg matches nothing (common for a natural
language question), fusion simply reduces to the vector ordering.

**Reranking is not in Sprint 1.** A cross-encoder rerank pass measurably
improves ordering, but it is only worth shipping alongside an evaluation
harness that can prove it helps on _your_ data rather than on a benchmark. Both
arrive in Sprint 2.

## Conversation

A conversation belongs to a **tenant and one of that tenant's own end users**
(`externalUserId` — your identifier for them, not ours). One end user can have
many conversations; omit `conversationId` to start a new one, or send one back
to continue an existing thread.

Every message — yours and the assistant's — is preserved in full,
indefinitely (retention lands in a later sprint). A short rolling summary is
kept alongside the full log purely to bound how much context gets sent to the
model on long conversations; it never replaces the underlying messages.

The assistant can call `search_knowledge` mid-reply — the same retrieval
`POST /v1/search` exposes directly, with a reranking pass added on top. What
it found is returned as a `sources` event, so you can show citations without
re-querying separately.
