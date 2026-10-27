# Search endpoints

Chemotion exposes five `/search/*` endpoints that share a common
request skeleton but diverge on what goes inside `selection`. All
POST, all return JSON. All read `collection_id` at the **top level
of the body** (not inside `selection`).

## Shared body skeleton

```
POST /api/v1/search/<variant>
Content-Type: application/json

{
  "selection": { ... variant-specific ... },
  "collection_id": "10",         ← Grape wants String, JSON number also OK
  "page": 1,
  "per_page": 25,
  "page_size": 25                ← required for /search/by_ids specifically
}
```

**Gotchas that bit us during reverse-engineering:**

- `collection_id` inside `selection` is **silently ignored**. The
  server reads only the top-level key. Putting it in selection
  guarantees a 400 "collection_id is missing".
- `collection_id` = the literal string `"all"` is rejected with 400
  "collection_id is invalid". Resolve it client-side to the numeric
  "All" id from the collection list. See
  [`collections.md`](./collections.md).
- Server returns a per-kind bucket response:
  `{samples: {elements, totalElements, page, perPage, pages, error},
  reactions: {...}, wellplates: {...}, screens: {...},
  research_plans: {...}}`. Even variants that only produce one kind
  return the full envelope with empty buckets.
- `error` is a per-bucket string; empty when the query ran. Don't
  treat a bucket's `error` as fatal unless you know it should've
  matched.

## `/search/all` — free-text across all kinds

```json
{
  "selection": {
    "search_by_method": "substring",
    "name_column": "name",
    "name": "DMSN",
    "elementType": "all"
  },
  "collection_id": "10",
  "page": 1,
  "per_page": 25
}
```

- `search_by_method`: `"substring"` is the usual choice.
- `name_column`: the column to match on. `"name"` works for every
  kind; `"short_label"` for labels.
- `name`: the literal substring. Do not wildcard — see "Wildcarding"
  below.
- `elementType`: `"all"` to hit every kind, or a **plural** form
  (`"samples"`, `"reactions"`, `"wellplates"`, `"screens"`,
  `"research_plans"`) to scope. **Singular forms (`"sample"`) are
  rejected** with "selection[elementType] does not have a valid
  value".

## `/search/<plural>` — scoped free-text

Same body as `/search/all`, but post to `/search/samples`,
`/search/reactions`, etc. `selection.elementType` should still be
the plural.

## `/search/structure` — substructure / similarity (verified wire)

```json
{
  "selection": {
    "elementType": "samples",
    "search_type": "sub",                  (or "similar")
    "molfile": "...V2000 or V3000...",
    "tanimoto_threshold": 0.7              (used by "similar", ignored for "sub")
  },
  "collection_id": "10",
  "page": 1,
  "per_page": 25
}
```

- `search_type: "sub"` — substructure match, fingerprint-filtered.
- `search_type: "similar"` — Tanimoto similarity over Morgan-like
  fingerprints. `tanimoto_threshold` ∈ [0, 1], defaults reasonable
  ≈ 0.7.
- Grape validates `search_type` against exactly `similar` / `sub`;
  `"sim"` is rejected with a 400. (Our tool sent `"sim"` until this was
  caught in review, so similarity search never worked.)
- Accepts **molfile only**. For SMILES, preconvert via
  `POST /molecules/smiles` → `{molfile, molecule, svg}` →
  forward the returned molfile.
- Reactions are also searchable by structure (`elementType:
  "reactions"`) — matches on reaction participants.

## `/search/advanced` — structured filters (hard-won)

Shape is idiosyncratic; this took two rounds of live probing to get
right.

```json
{
  "selection": {
    "elementType": "samples",
    "advanced_params": [
      {
        "link": "",                                    ← "" on first clause, "AND"/"OR" after
        "match": "LIKE",                               ← or "ILIKE", "=", "<", ">"
        "table": "samples",                            ← REQUIRED
        "field": {
          "table": "samples",                          ← REQUIRED (both table keys)
          "column": "external_label",
          "label": "External Label"
        },
        "value": "DMSN"                                ← do NOT pre-wildcard
      }
    ]
  },
  "collection_id": "10",
  "page": 1,
  "per_page": 25
}
```

### Detail-level gate

`Usecases::Search::ConditionsForAdvancedSearch` gates every filter
via `whitelisted_table? && filter_with_detail_level?`. It reads
`filter.field.table` with fallback to `filter.table` — **both must
be set** on our payload or every column surfaces "Your search for
<column> is not allowed".

For `samples` table, allowed columns depend on collection
`sample_detail_level`:
- `external_label` — **always allowed**.
- `name`, `short_label`, `sum_formula`, `molecular_mass`, etc. —
  allowed only when `sample_detail_level > 0`. The whitelist is
  `API::WL_TABLES` in `app/api/api.rb`; there is no
  `molecular_weight` column.
- LIKE / ILIKE values are wrapped in `%…%` **and** run through
  `sanitize_sql_like`, so a `%` you send is matched literally.

For `reactions` table, `reaction_detail_level > -1` unlocks all
columns.

### Wildcarding

Chemotion's `sanitize_words` wraps the value with `%…%` automatically
for LIKE/ILIKE. **Do not pre-wildcard** — `value: "%DMSN%"` becomes
`%%DMSN%%` server-side and matches zero. Pass the bare substring.

### Match ops

- `"LIKE"` / `"ILIKE"` — substring (server auto-wildcards).
- `"="` — exact.
- `"<"`, `">"`, `"<="`, `">="` — numeric compare.

### `advanced_params` quirk

If the **first** param's `link` is non-empty (`"AND"` / `"OR"`),
Chemotion's route has special handling (`params.dig(..., 0).link !=
''`). The normal-case first clause has `link: ""`.

## `/search/by_ids` — fetch specific ids (verified — shape is weird)

Do not confuse with `/search/samples` or GET `/samples/:id`. This
endpoint exists for bulk-by-id fetch of summaries.

```json
{
  "selection": {
    "elementType": "by_ids",               ← literal string "by_ids", NOT the kind
    "id_params": {
      "model_name": "sample",              ← lowercase singular
      "ids": [8178, 8179, 8180],
      "total_elements": 3                  ← MUST equal ids.length (Kaminari pagination math)
    }
  },
  "collection_id": "10",
  "page": 1,
  "page_size": 25,                         ← required; per_page alone is not enough
  "per_page": 25
}
```

- `id_params.model_name` accepts lowercase singular kind names:
  `"sample"`, `"reaction"`, `"research_plan"`, `"wellplate"`,
  `"screen"`. Singular because it maps to the Ruby model class name
  via `.camelize.constantize`.
- **`total_elements` is required.** Without it, Kaminari hits a
  divide-by-zero inside the Rails app and returns a 500 HTML error
  page. Pass `ids.length` unless you already know a higher total
  (e.g. a paginated fetch from a previous call).
- **`page_size` is required.** The ByIds usecase reads
  `params[:page_size]` specifically, not `per_page`. Setting both
  avoids surprises.
- Response bucket key matches the pluralised model name, e.g.
  `response.samples.elements` for `model_name: "sample"`.

### Why `/search/by_ids` is borderline redundant

For most MCP use cases, parallel-fanned `GET /<plural>/:id` calls
(see `chem_get_bulk`) give you the same user outcome without
threading the `total_elements` needle. `chem_search_by_ids` exists
because the endpoint is first-party; prefer `chem_get_bulk` when
you want hydrated records rather than summaries.

## `/molecules/smiles` — SMILES → molfile conversion

Not a search endpoint but lives in the same "query" family.

```json
POST /api/v1/molecules/smiles
{"smiles": "CCO"}

→ {
    "molfile": "...",
    "molecule": {id, inchikey, sum_formular, ...},
    "svg": "<svg>..."
}
```

- Use as a preprocessing step before `/search/structure` (which only
  accepts molfiles) or before `POST /samples` when the caller has a
  SMILES but the server prefers molfile.
- Runs through OpenBabel/RDKit on the server.

## Response walking

Every `/search/*` response contains per-kind buckets even for variants
that logically only return one kind. The consistent shape:

```json
{
  "samples": {
    "elements": [ {id, name, short_label, molecule:{...}, ...}, ... ],
    "ids": [ ... ],
    "page": 1,
    "perPage": 25,
    "pages": 4,
    "totalElements": 97,
    "error": ""
  },
  "reactions": { ... },
  "wellplates": { ... },
  "screens": { ... },
  "research_plans": { ... }
}
```

Walk all five kinds; skip buckets where `elements` is empty.

## Reference

Client: `src/client/client.ts` (`searchAll`, `searchElementType`,
`searchStructure`, `searchAdvanced`, `searchByIds`,
`smilesToMolfile`).
Source: `app/api/chemotion/search_api.rb`,
`app/usecases/search/by_ids.rb`,
`app/usecases/search/conditions_for_advanced_search.rb`.
Probed: 2026-04-24 — all five variants plus SMILES conversion.
