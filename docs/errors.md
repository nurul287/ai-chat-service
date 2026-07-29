# Errors

Every failure returns the same shape, with the same HTTP status semantics:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "/content Too small: expected string to have >=1 characters"
  }
}
```

## The contract

| Code              | HTTP | When                                                        |
| ----------------- | ---- | ----------------------------------------------------------- |
| `unauthorized`    | 401  | Missing, malformed, unknown, or revoked API key             |
| `invalid_request` | 400  | Body, query string, or path params failed schema validation |
| `not_found`       | 404  | No such document for your tenant — or no such route         |
| `internal_error`  | 500  | Unexpected server failure                                   |

**`code` is a stable public contract. `message` is not.**

Branch on `code`. It will not change without a major version bump, because
changing it is a breaking change for every consumer. `message` exists to help a
human debug and its wording may change at any time — do not parse it, do not
match on it, do not show it to end users verbatim.

## Two behaviours worth knowing

**`not_found` is deliberately ambiguous.** Deleting a document belonging to
another tenant returns exactly the same `404` as deleting one that never
existed. The API will not confirm or deny that another tenant's `externalId`
exists, so it cannot be used to probe for someone else's data.

**Search never 404s.** A query matching nothing returns `200` with
`{"data": []}`. An empty result is a valid answer, not an error — and it is
also what you get when searching a corpus that belongs to a different tenant.

## Validation errors

`invalid_request` messages name the offending field with a JSON-pointer-style
path, so `/content` means the `content` property of the request body. Multiple
failures are joined with `; `.

Common causes:

- `content` empty or missing (required, 1–200,000 characters)
- `externalId` empty or missing (required, 1–255 characters)
- `query` empty (required, 1–2,000 characters)
- `topK` above 20, or `limit` above 100

The exact constraints for every field are in the OpenAPI spec at
`GET /openapi.json`, generated from the same schemas that perform the
validation — so they cannot drift from what the server actually enforces.
