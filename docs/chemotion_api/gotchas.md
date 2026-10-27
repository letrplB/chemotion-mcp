# Gotchas — read this once before writing code

Concentrated list of non-obvious Chemotion behaviours that cost us
time. If you add an endpoint and it feels weird, check here first.

## Authentication

### `user[email]` is silently ignored

Chemotion's Devise uses a custom `:login` field. The login param is
`user[login]` — accepts email OR `name_abbreviation`,
**case-sensitive**. `user[email]` is dropped silently and Warden
returns the generic "You need to sign in" message, not the Devise
"Invalid Email or password" message. Symptom: 3ms response time
(bcrypt never runs).

### The CSRF token lives in HTML, not a cookie

Some Chemotion builds do not set a `CSRF-TOKEN` cookie. The
authenticity token must be scraped from the sign-in HTML form's
hidden field or the `<meta name="csrf-token">` tag. Read the HTML,
extract, then POST with it.

### Form login route returns 406 on JSON Accept

`Accept: application/json` on `POST /users/sign_in` → 406 Not
Acceptable. Use `Accept: text/html` for the form path. There's a
separate JSON-API Devise path but it's inconsistent across builds.

### Successful login rotates the session cookie via 302

Use `redirect: 'manual'` on the fetch so you capture the Set-Cookie
from the 302 directly. Auto-following may lose the rotated cookie
on some HTTP clients.

## Collections

### The collection routes changed in v4

Before v4, `GET /collections` returns 405 and the tree is split
across `/collections/roots`, `/shared_roots`, `/remote_roots`, and
`/locked`. v4 removed all four and serves `GET /collections` →
`{own, shared_with_me}` as flat rows linked by `ancestry`. The client
tries v4 first. See [`collections.md`](./collections.md).

### `collection_id=all` is not a valid API value

The string `"all"` is UI-only. The API always wants a numeric id.
The "All" pseudo-collection id is **per-user**: it is the locked row
labelled `All` in the collection list. Resolve it client-side and
cache per session.

### The "All" id is not stable across users

Don't hardcode the number you see on your own account. Every user
has their own row. On the test instance, user 6 sees `All` at id 10;
another user on the same instance would see a different number.

## Search

### `collection_id` inside `selection` is silently ignored

Every `/search/*` endpoint reads `collection_id` at the **top level**
of the request body. Older docs put it inside `selection.collectionId`
— ignored, and the server complains "collection_id is missing".

### `selection.elementType` is plural, not singular

`"samples"`, `"reactions"`, `"wellplates"`, `"screens"`,
`"research_plans"`. Singular (`"sample"`) triggers
"selection[elementType] does not have a valid value".

### `/search/by_ids` breaks the elementType pattern

`elementType: "by_ids"` literally — the kind moves into
`selection.id_params.model_name` (which is singular lowercase).
`total_elements` is required (else divide-by-zero 500). Body wants
`page_size` in addition to `per_page`.

### Advanced-search filter needs `table` in two places

Every `advanced_params` entry needs `table` at the filter level AND
inside `field.table`. Missing either triggers
`Your search for <column> is not allowed` because the detail-level
gate falls through on an empty table name.

### Advanced-search auto-wildcards LIKE/ILIKE

Do NOT pre-wildcard the `value` for LIKE/ILIKE matches. Chemotion's
`sanitize_words` wraps with `%…%` automatically. Passing `%X%`
becomes `%%X%%` and matches zero.

### Advanced-search column whitelist depends on detail_level

Even with correct shape, `sample_detail_level: 0` restricts to
`external_label` only. Reactions need `reaction_detail_level > -1`.
This is server policy, not a client bug.

## Element CRUD

### `findByShortLabel` renames the primary key

Response envelope is `{sample_id, collection_id}` for samples and
`{reaction_id, collection_id}` for reactions — **not** `{id, ...}`.
Our client normalises by copying to `.id`.

### `POST /samples` crashes without `xref: {}`

Chemotion's sample create handler (`app/api/chemotion/sample_api.rb`
L608 on `main` as of 2026-04) reads
`params[:xref][:inventory_label]` with no nil guard. If you omit
`xref` from the POST body the Rails app hits a NoMethodError on
`nil[:inventory_label]` and returns 500 + a Rails 5xx HTML page (NOT
a JSON error — confusing to diagnose). Always send `xref: {}` on
create. See [`upstream-bugs.md`](./upstream-bugs.md) for the file
reference. The update handler on the same file uses `&.fetch` safely,
so PUT is fine.

### Non-reference reaction materials get "absorbed" into the reaction

When you POST a reaction with `materials.<role>: [{id, reference:
false, ...}]`, Chemotion silently:

1. Rewrites the sample's `short_label` from its user-facing value
   (e.g. `SMP-8`) to the role marker (`reactant`, `solvent`,
   `product`).
2. Removes the sample from its collection's sample listing — it
   becomes visible only through the reaction's materials UI.

The sample still exists (`GET /samples/:id` works, chemistry and
external_label are intact) but `GET /samples?collection_id=X` no
longer returns it. Reference samples (`reference: true`) stay in
the collection listing with their labels preserved.

**Practical impact:** If you need a sample to remain first-class in
the user's collection view (browsable, listable, searchable by its
original short label), make it `reference: true`. Use
`reference: false` only when you want the sample to live exclusively
as part of the reaction (typical for solvents and single-use
reactants). This is intentional Chemotion behaviour, not a bug,
but it's surprising enough to bite any caller who didn't know.

### `PUT /wellplates/:id` — `wells` is a full replacement that destroys samples

`WellplateUpdater#update_wells` updates the wells you send, then runs
`Sample.where(id: current_sample_ids - included_sample_ids).destroy_all`.
Every sample that sat in the plate but is missing from `wells` is
**deleted**. `"wells": []` therefore deletes all of the plate's samples.
Omitting `wells` crashes older builds on nil (see
[`upstream-bugs.md`](./upstream-bugs.md)).

The client's `updateWellplate()` sends the current wells back (from a
GET) when the caller omits them. An earlier version defaulted to
`"wells": []`, which turned every rename into a mass delete.

### Wellplate `description` and Screen `description` are Quill deltas too

Same hazard as reaction description/observation: the fields are Hashes
with a Quill-delta shape, not strings. Formatters must pipe them
through a delta-aware renderer before truncating. Sample.description
is a plain string; every other entity's description is a delta. Easy
trap.

### Reaction `description` and `observation` are Quill deltas

Not strings. Shape: `{ops: [{insert: "text\n"}]}`. Creating a reaction
with `description: "my notes"` (a bare string) may silently round-trip
as empty or crash depending on the Grape version — always wrap as
`{ops: [{insert: "my notes\n"}]}`. Reading them and feeding straight
into a `.slice()`-based truncator will throw `text.slice is not a
function` — hydrate through a Quill-delta-aware renderer.

**Contrast:** `Sample.description` is a plain string.
`Reaction.description` / `Reaction.observation` are deltas. Research
plans use deltas inside typed `richtext` / `text` body blocks but the
block wrapper is a plain object.

### `container` is required on POST AND PUT

Grape's `requires :container, type: Hash` fires on both paths, so
omitting it is a 400. It does not wipe analyses:
`Usecases::Containers::UpdateDatamodel` merges by id and only removes
children flagged `is_deleted: true`. An empty root container is a
no-op, and passing the fetched tree back is what the UI does.

The client's update methods send the current container back when the
caller omits it. They do the same for `materials` (reactions),
`wells` (wellplates), and the screen id arrays.

### Sample `purity` is decimal, not percent

`purity: 1.0` means 100%. The UI formats as `purity * 100%` for
display. Pass `0.95` for "95% pure", not `95`.

### Research plans have no per-id DELETE

Use `DELETE /ui_state/` with a ui-state payload scoped to
`currentCollection.id: 0` (the `get_all_collection_for_user` sentinel).
Already wrapped in `deleteResearchPlanByUiState`.

### Reactions need `materials` on POST AND PUT, and it replaces everything

`Usecases::Reactions::UpdateMaterials` treats `materials` as the full
participant list:

- Participants missing from every bucket are destroyed
  (`destroy_unused_samples`). On v4 this includes
  `reactant_sbmm_samples`.
- For each existing participant, `update_existing_sample` writes
  `target_/real_amount_*`, `metrics`, `dry_solvent`, and `solvent`
  straight from the payload. `associate_sample_with_reaction` does the
  same for `equivalent`, `reference`, `show_label`, `waste`,
  `coefficient`, `position`, `gas_type`, `gas_phase_data`,
  `conversion_rate`, and `weight_percentage*`. A field you leave out is
  saved as nil.
- A polymer sample sent without `residues` raises
  `NoMethodError` → 500.

Safe pattern: send back the participant rows exactly as
`GET /reactions/:id` returned them, then add or modify rows. The
client's `cloneReactionMaterials()` does this, and `updateReaction()`
uses it when `materials` is omitted. The first version of our attach
tools rebuilt rows from a field whitelist and silently cleared
solvents and metrics on every existing participant.

### Bare `sample_id` in reaction materials silently MOVES the join row

This is the most destructive write-path gotcha we've hit. Verified
against Chemotion's source on 2026-04-24 (commit reading
`app/usecases/reactions/update_materials.rb:284-323`).

**What goes wrong.** If you PUT a reaction with
`materials.<role>: [{id: 8201, …}]` and sample 8201 already belongs to
another reaction as starting-material / reactant / product / solvent,
the server-side handler `associate_sample_with_reaction` runs
`ReactionsSample.find_by(sample_id: 8201)` **unscoped by
reaction_id**. It finds the pre-existing join row on the other
reaction and `update!`s its `reaction_id` + `type` to match your
payload, effectively MOVING the row. Your PUT returns 200 OK, your
reaction now "owns" the sample — and the original reaction silently
lost its link. Symptom on next GET of the original reaction: the
participant row is gone with no error surfaced anywhere.

**Root cause.** The `reactions_samples` table itself allows shared
samples (no unique constraint on `sample_id`; STI subclasses
`ReactionsStartingMaterialSample` / `ReactionsReactantSample` /
`ReactionsSolventSample` / `ReactionsProductSample` each carry their
own per-row `reference`, `equivalent`, `real_amount_value`,
`position`). But the **write path** always creates a subsample,
never a shared row. Chemotion's UI ships each reaction attachment as:

```json
{
  "id": "<client-side uuid>",
  "is_new": true,
  "is_split": true,
  "parent_id": 8183,
  "real_amount_value": 1.15,
  "real_amount_unit": "g"
}
```

The server sees `is_split && parent_id` and calls
`create_sub_sample(parent=8183)` — `dup`-ing the stock into a new
sample with `parent_id` pointing back to the stock, giving it its
own short_label and container, and attaching THAT subsample to the
reaction. The stock is never joined directly, so it stays untouched
in the inventory and can drive many reactions.

For products, Chemotion similarly mints a fresh sample
(`create_new_sample` path) and attaches it. Products never use
`is_split` because they aren't derived from a stock.

**Fix pattern.** Our MCP exposes `chem_attach_reaction_material` and
`chem_attach_reaction_product` that emit the correct subsample shape
so stock samples stay reusable. If you're writing new reaction code
directly, mirror the same shape:

- SMs / reactants / solvents → always pass `{id: <uuid>, is_new: true,
  is_split: true, parent_id: <stock_id>, …}`.
- Products → pass `{id: <uuid>, is_new: true, molfile: "…", name: "…",
  container: EMPTY_ROOT_CONTAINER, …}`.

Never pass a bare existing `sample_id` in any bucket unless you
actually want to move the join row.

### Research-plan body PUT replaces the whole field list

`PUT /research_plans/:id` treats `body` as a full replacement, not a
patch. If you want to add / edit / delete one field, the safe pattern
is:

1. `GET /research_plans/:id`
2. preserve `container` (and linked `wellplate_ids` if you care)
3. mutate the `body` array client-side
4. PUT the whole array back

This is why the MCP now wraps research-plan field CRUD as
fetch-modify-put helpers instead of pretending Chemotion has a
per-field endpoint.

### Ketcher research-plan blocks need a persisted SVG filename

The molecule field in a research plan does not store raw SVG inline in
the body. The UI first POSTs raw SVG markup to
`/api/v1/research_plans/svg`, receives `{"svg_path":"<digest>.svg"}`,
and only then stores that filename in `body[].value.svg_file`.

If you write a Ketcher block with `sdf_file` but no persisted
`svg_file`, the structure data is there, but the UI cannot render the
preview image yet.

## Search

### Similarity search wants `search_type: "similar"`

Grape validates `selection.search_type` against `%w[similar sub]`.
`"sim"` is a 400.

### List date filters are Unix seconds

`from_date` / `to_date` on `GET /samples` and the other list routes
are `Integer` Unix seconds (`Time.zone.at`). They filter `updated_at`
unless `filter_created_at=true`.

## MCP transport

### zod unions with string literals corrupt integer args

The MCP JSON-RPC transport may serialize integer args as strings
when the schema is `z.union([z.number(), z.literal('all')])`. The
emitted JSON Schema (`anyOf: [{type:'number'}, {const:'all'}]`) has
no discriminator so the caller hedges.

**Fix pattern:** wrap such unions in `z.preprocess` that coerces
decimal strings to numbers before the union runs. Our
`collectionIdSchema` in `src/mcp/tools/helpers.ts` is the canonical
example — copy that shape for any new union-with-literal schema.

## Error-response shapes

- `{"error":"<message>"}` — Grape validation error, usually 400/401/422.
- `{"status":500,"error":"Internal Server Error"}` — Rails caught
  something, body sometimes plain HTML instead of JSON.
- `<!DOCTYPE html>...` on 500 — Rails 5xx page; the JSON you
  expected is gone. Check Chemotion server logs. In our case this
  almost always meant the wire shape was wrong, not a real bug.
- `{samples:{..., error:"Your search for X is not allowed"}}` —
  per-bucket search error; query ran but was gated.

## URL structure pitfalls

- `/mydb/collection/13/` is a **React router path**, not an API
  endpoint. The API is under `/api/v1/`.
- Chemotion appends `/api/v1` — `CHEMOTION_BASE_URL` must NOT
  include that suffix.
- Trailing slashes on the base URL are stripped by our client;
  don't rely on them.

## Reference

Most of this lives as executable-code comments in `src/client/`. When
a gotcha turns into a breaking change, update both this doc and
the local reverse-engineering log (`dev-docs/`, not published).
