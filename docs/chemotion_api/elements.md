# Elements — CRUD surface

Every Chemotion primary entity (sample, reaction, research plan,
wellplate, screen) follows the same URL pattern but with per-kind
quirks. This doc captures the contract, not the schema — full field
lists live in `src/client/types.ts`.

## URL pattern

```
GET    /api/v1/<plural>?collection_id=<int>&page=<n>&per_page=<n>
GET    /api/v1/<plural>/:id
POST   /api/v1/<plural>
PUT    /api/v1/<plural>/:id
DELETE /api/v1/<plural>/:id        (except research_plans — see below)
```

Where `<plural>` is `samples`, `reactions`, `research_plans`,
`wellplates`, `screens`.

## Listing (verified)

```
GET /api/v1/samples?collection_id=10&page=1&per_page=25
```

- Pass `collection_id` (the client resolves `all` to the "All" id).
  v4 lists everything the user can see when it is omitted.
- `from_date` / `to_date` are **Integer Unix seconds** (the Grape desc
  says "ms", the code calls `Time.zone.at`). They filter `updated_at`
  unless `filter_created_at=true`. An ISO string gets a 400.
- Samples-only: `product_only`, `molecule_sort`.
- Response body: `{samples: [...]}` (v4 adds `samples_count`). Totals
  come from grape-kaminari **headers**: `X-Total`, `X-Total-Pages`,
  `X-Page`, `X-Per-Page`. The client copies them into `pagination`.

Same shape applies to `reactions`, `research_plans`, `wellplates`,
`screens` — just swap the plural.

## Single entity hydration (verified)

```
GET /api/v1/samples/:id
→ {sample: {...}}
```

- **All related data hydrates in one round-trip.** There is no
  `include` arg. A single `GET /samples/8178` returns the full
  molecule, analyses container tree, literatures, and linked
  molecule record.
- Same for reactions (scheme + materials + analyses),
  research_plans (body blocks + container), wellplates, screens.

## `findByShortLabel` — envelope gotcha

```
GET /api/v1/samples/findByShortLabel/:short_label
→ {sample_id: 8178, collection_id: 10}
```

**The id field is `sample_id`, NOT `id`.** Reactions follow the same
pattern with `reaction_id`. This is the only Chemotion endpoint
we've found that renames the primary key in the response envelope.
Our client's `findSampleByShortLabel` / `findReactionByShortLabel`
normalise by copying `sample_id → id` (or `reaction_id → id`) so
downstream handlers see both.

There is no `findByShortLabel` for research plans, wellplates, or
screens — they don't have short labels in the UI.

## Creating

```
POST /api/v1/samples
Content-Type: application/json

{
  "collection_id": 13,                (or omitted → goes to "All")
  "description": "DMSN test batch",
  "purity": 1.0,                      (decimal 0..1, NOT percent)
  "target_amount_value": 1.5,
  "target_amount_unit": "g",
  "location": "lab-bench-B",
  "is_top_secret": false,
  "xref": {},                         (REQUIRED in practice — see below)
  "container": { ...empty-root shape... },  (REQUIRED)
  "molfile": "...",                   (or molecule_id if already known)
  ...
}
→ 201 {sample: {...hydrated...}}
```

- **`container` is required even on create.** Pass
  `EMPTY_ROOT_CONTAINER` (exported from the client) if you don't care
  about analyses. Shape: `{name:"new", container_type:"root",
  description:"", extended_metadata:{}, attachments:[], children:[]}`.
- **`xref` must be present even if empty.** Chemotion's create
  handler reads `params[:xref][:inventory_label]` without a nil-check
  (see [`upstream-bugs.md`](./upstream-bugs.md)), so omitting `xref`
  crashes the handler with 500. Passing `xref: {}` makes the lookup
  return nil safely. Grape says it's optional; the handler disagrees.
- **Purity is decimal 0..1, not percent.** Chemotion UI renders it as
  `purity * 100%`.
- **IUPAC / InChI / InChIKey / SMILES / molecular_weight hydrate
  server-side** from the molfile you pass — you don't compute them.
  Sending just `molfile: "<ketcher molfile>"` is enough; a subsequent
  GET returns the full chemistry view.
- **Sample `description` is a plain string** (markdown-ish allowed,
  rendered as text).
- Expected field list for samples (Grape `requires`):
  `target_amount_value`, `target_amount_unit`, `description`,
  `purity`, `location`, `is_top_secret`, `container`, (+ `xref` de
  facto). Everything else is optional — Grape silently drops unknown
  params.

### Reactions

```
POST /api/v1/reactions
{
  "collection_id": 13,
  "name": "My reaction",
  "status": "Planned",                  ("Planned"/"Running"/"Done"/...)
  "description": {"ops":[{"insert":"..."}]},   (Quill delta, NOT a string)
  "observation": {"ops":[{"insert":"..."}]},   (Quill delta)
  "materials": {
    "starting_materials": [{"id": 8182, "reference": true, "equivalent": 1, "position": 0, "real_amount_value": 0.2416, "real_amount_unit": "g"}],
    "reactants": [{"id": 8184, "reference": false, "equivalent": 0.6667, "position": 0, "real_amount_value": 0.1408, "real_amount_unit": "g"}],
    "products": [],
    "solvents": [{"id": 8185, "reference": false, "position": 0, "real_amount_value": 4, "real_amount_unit": "ml"}]
  },
  "container": { ...empty-root shape... }
}
→ 201 {reaction: {...hydrated with derived short_label...}}
```

- **`description` and `observation` are Quill deltas**, not plain
  strings. Wrap plain text as `{ops:[{insert:"hello"}]}`. This was a
  live gotcha — our first formatter tried to `.slice()` them and
  crashed. Relevant for both create AND read.
- `status` values: `"Planned"`, `"Running"`, `"Done"`, `"Analyses
  Pending"`, `"Successful"`, `"Not Successful"`.
- Sample refs inside `materials`: `{id, reference: bool, equivalent:
  number, position: integer, real_amount_value, real_amount_unit,
  target_amount_value, target_amount_unit, molarity_value,
  molarity_unit, density}`. The singular field name is
  **`equivalent`** on modern Chemotion readback. `reference: true`
  marks the reference compound used to calculate yields/equivalents.
- Solvent volumes use the same amount fields as reagents. In practice
  this means `real_amount_value: 4, real_amount_unit: "ml"` for a
  4 mL solvent row.
- `short_label` is derived server-side (e.g. `RXN-2` for a user's
  second reaction); caller can override by sending explicit
  `short_label`.

### Research plans

```
POST /api/v1/research_plans
{
  "collection_id": 13,
  "name": "My plan",
  "body": [
    {"id":"<uuid>","type":"richtext","value":{"ops":[{"insert":"hello\n"}]},"title":""}
  ],
  "container": { ...empty-root shape... }
}
→ 201 {research_plan: {...}}
```

- `body` block types: `richtext`, `text`, `table`, `image`, `sample`,
  `reaction`, `ketcher`, `attachment`.
- Each block has its own `value` shape. `richtext` / `text` use
  Quill deltas; `table` uses an ag-grid style payload
  `{columns:[...], rows:[...]}`; `sample` / `reaction` reference by id
  via `{sample_id}` / `{reaction_id}`; `ketcher` stores
  `{sdf_file, svg_file}`.
- UI defaults from `app/javascript/src/models/ResearchPlan.js`:
  - `table` starts with 6 columns (`a`..`f`) and 3 blank rows.
  - `sample` starts as `{sample_id:null}`.
  - `reaction` starts as `{reaction_id:null}`.
  - `ketcher` starts as `{svg_file:null, preview_attachment:null}` and
    later gains `sdf_file` after the structure editor saves.
- Empty `body: []` is legal for a blank plan.
- Ketcher SVG persistence is a separate upstream endpoint:

```
POST /api/v1/research_plans/svg
{
  "svg_file": "<raw svg markup>",
  "is_chemdraw": false
}
→ 200 {"svg_path":"<digest>.svg"}
```

Store the returned `svg_path` inside the Ketcher block's `value.svg_file`.

## Updating (PUT)

```
PUT /api/v1/samples/:id
→ {sample: {...hydrated...}}
```

**Grape's `requires :container, type: Hash` is enforced on PUT too.**
If you don't pass `container`, the server will either reject with
400 or — worse on some builds — overwrite the existing analyses tree
with `{}`. The safe pattern:

1. `GET /samples/:id` first.
2. Read `response.sample.container`.
3. Pass it back untouched in the PUT body alongside whatever you're
   changing.

Reactions similarly require `container` + `materials` on PUT.
Research-plan PUTs likewise require `container`; if you send `body`,
it replaces the entire block array in one shot.

## Deleting

```
DELETE /api/v1/samples/:id
→ {}  (soft delete via acts_as_paranoid, no restore route)
DELETE /api/v1/reactions/:id
→ {}
DELETE /api/v1/wellplates/:id
→ {}
DELETE /api/v1/screens/:id
→ {}
```

Every element model uses `acts_as_paranoid`: rows get a
`deleted_at` and vanish from the API, but nothing in the API or UI
restores them, so treat deletes as permanent. On v4 only the owner can
delete. (There is no per-id DELETE for screens either; see below.)

### Research plans: no per-id DELETE

Chemotion does not expose `DELETE /research_plans/:id`. Delete goes
through the bulk `ui_state` endpoint:

```
DELETE /api/v1/ui_state/
Content-Type: application/json

{
  "currentCollection": {"id": 0},            (0 = Collection.get_all_collection_for_user sentinel)
  "options": {"deleteSubsamples": false},
  "research_plan": {
    "checkedIds": [42],
    "uncheckedIds": [],
    "checkedAll": false
  },
  "selecteds": []
}
→ {}
```

Scoping to `currentCollection.id: 0` wipes the plan regardless of
which collection the caller is viewing. Our client wraps this as
`deleteResearchPlanByUiState(id)`.

Samples and reactions can also reach `/ui_state/` for bulk delete but
we don't surface that — the per-id DELETE is simpler.

## Attachments

```
GET /api/v1/attachments/:id              → raw bytes
GET /api/v1/attachments/image/:id        → rendered image bytes
GET /api/v1/attachments/zip/:container_id → zip of a container's attachments
```

Returned as `Response` from the client so callers can stream or
buffer. Attachment ids are discoverable via the analyses container
tree inside a sample/reaction hydration.

## Reference

Client: `src/client/client.ts` (sample/reaction/research_plan/
wellplate/screen methods).
Source: `app/api/chemotion/{sample,reaction,research_plan,wellplate,
screen}_api.rb`.
Probed: 2026-04-24 — reads verified, writes gated off pending
verification.
