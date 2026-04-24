# Collections

Collections are the primary scoping container for every element
(samples, reactions, research plans, wellplates, screens). Everything
interesting about Chemotion's API routes through a `collection_id`.

## There is no `GET /collections`

**`GET /api/v1/collections` returns 405.** The collection tree is
split across four routes, each returning its own bank. To get the
full picture, call all four and merge.

| Route | Returns | Notes |
|---|---|---|
| `GET /collections/roots` | Caller's own collections (tree with `children`) | Always 200 |
| `GET /collections/shared_roots` | Collections shared **with** the caller | 200, often empty |
| `GET /collections/remote_roots` | Federated / remote collections | 200 or 404 on older builds |
| `GET /collections/locked` | Synthetic `All` + repository sync pseudo-collections | 200 |

Response shape: `{collections: [Collection, ...]}`. Each `Collection`
carries `id`, `label`, `permission_level`, the five
`*_detail_level` fields (one per element kind), optional `children`,
optional `is_locked` / `is_shared` / `is_remote` booleans.

Implementation: `ChemotionClient.listCollections()` fans out all four
in parallel and exposes the merged list plus the per-bank breakdown.

## The "All" pseudo-collection (verified)

Every user has a synthetic `All` collection that aggregates every
element visible to them (own + shared). This is a **real row** in
the `collections` table on the server, not a global sentinel — **its
id is per-user** and is only discoverable by reading
`/collections/locked`.

On the test deployment, the current user's `All` collection resolved
to numeric id `10`. Expect a different value on every account.

### Why `collection_id=all` fails

Strings are not accepted by the REST endpoints:

```
GET /api/v1/samples?collection_id=all
→ 400 {"error":"collection_id is invalid"}
```

The string only makes sense inside the React UI's URL router. Every
API call must resolve to a numeric id. Our client resolves
automatically — callers can still pass `'all'` or omit
`collection_id`; see `ChemotionClient.resolveAllCollectionId()`.

## Single collection

```
GET /api/v1/collections/:id
→ 200 {"collection": {id, label, children?, permission_level, ...}}
```

- Walks one level at a time. `children` is a shallow array — for
  deep traversal, call again with each child id.
- Plain integer id; no string fallback.

## Pagination

None — Chemotion assumes the tree is small enough to return in one
round-trip.

## Detail levels

Each collection exposes per-kind detail levels that gate what data
flows through search filters:

- `sample_detail_level` — 0 means restricted; `> 0` unlocks
  name/short_label/etc. in advanced search. `external_label` is
  always searchable regardless.
- `reaction_detail_level` — `> -1` unlocks reaction fields.
- `wellplate_detail_level`, `screen_detail_level`,
  `researchplan_detail_level` — similar.

A caller with `sample_detail_level: 0` on a shared collection will
hit `{"error":"Your search for <column> is not allowed"}` from
`/search/advanced` — this is server-side policy, not a shape bug.

## Permission levels

Integer, 0 = owner. Higher values restrict what the caller can do.
Chemotion's permission check lives server-side; the client just
surfaces 401/403s when they fire.

## Reference

Client: `src/client/client.ts` (`listCollections`, `getCollection`,
`resolveAllCollectionId`).
Source: `app/api/chemotion/collection_api.rb`,
`app/api/chemotion/element_api.rb`.
Probed: 2026-04-24.
