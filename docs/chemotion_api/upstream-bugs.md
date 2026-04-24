# Upstream Chemotion bugs

Potential bugs discovered in **Chemotion itself** (the ELN server), not in our
client. These are things we've worked around client-side but that
deserve to be reported upstream and ideally fixed in
[`ComPlat/chemotion_ELN`](https://github.com/ComPlat/chemotion_ELN).

Keep entries compact: what breaks, where, how to repro, how we work
around it. File + line references are the `main` branch as of the
probe date — re-verify before filing a ticket.

---

## `POST /api/v1/samples` NoMethodError when `xref` is omitted

**Discovered:** 2026-04-24 on a live Chemotion 1.x deployment,
probed against `ComPlat/chemotion_ELN@main`.

**Symptom:** `POST /api/v1/samples` returns **500 Internal Server
Error** with a Rails 5xx HTML page (not JSON) when the caller sends
an otherwise-valid body that omits the `xref` field.

**Root cause:** `app/api/chemotion/sample_api.rb` (create handler,
~L608):

```ruby
sample.update_inventory_label(params[:xref][:inventory_label], params[:collection_id])
```

The Grape contract above has `optional :xref, type: Hash`, so
`params[:xref]` is legitimately `nil` when the caller doesn't provide
it. The handler then calls `[:inventory_label]` on nil → NoMethodError
→ 500.

**Precedent inside Chemotion:** the **update** handler on the same
file (~L439) uses the safe pattern:

```ruby
inventory_label = params[:xref]&.fetch(:inventory_label, nil)
```

so this is clearly a create-handler oversight, not a design decision.

**Repro (requires auth cookie):**

```http
POST /api/v1/samples
Content-Type: application/json

{
  "collection_id": 13,
  "description": "test",
  "purity": 1.0,
  "target_amount_value": 1,
  "target_amount_unit": "g",
  "location": "",
  "is_top_secret": false,
  "container": {"name":"new","container_type":"root","description":"","extended_metadata":{},"attachments":[],"children":[]}
}
```

→ `{"status":500,"error":"Internal Server Error"}` + Rails 5xx HTML.

Add `"xref": {}` to the body → 201 with the created sample envelope.

**Client-side workaround:**
`src/client/client.ts` — `createSample()` always injects `xref: {}`
when the caller didn't provide one.

**Suggested fix (upstream):** mirror the update handler's `&.fetch`
pattern, or default xref at the Grape layer (`optional :xref, type:
Hash, default: {}`).

---

## `POST /api/v1/search/by_ids` 500 when `total_elements` is omitted

**Discovered:** 2026-04-24 on a live Chemotion 1.x deployment.

**Symptom:** `POST /api/v1/search/by_ids` returns **500 Internal
Server Error** with a Rails 5xx HTML page when the caller sends an
`id_params` payload without `total_elements`.

**Root cause:** `app/usecases/search/by_ids.rb`:

```ruby
@total_elements = @id_params[:total_elements]
...
pages = @shared_methods.pages(@total_elements, @params[:page_size].to_i)
...
scope = scope.page(page).per(@params[:page_size]) if page != @params[:page] || @filter_params.present?
```

When `total_elements` is nil, the downstream pagination math hits a
nil-safe path, but the Kaminari `.page(...).per(nil)` call on a
restricted scope later in `search_filter_scope` → `serialize_result_by_ids`
blows up with a NoMethodError inside the adapter.

Additionally, the Grape `search_params` above declares `total_elements`
under the `optional :id_params, type: Hash` block with no required
sub-keys, so the API contract suggests it's optional — but the
usecase code assumes it's always present.

**Client-side workaround:**
`src/client/client.ts` — `searchByIds()` always sets
`id_params.total_elements = ids.length`, and always passes both
`page_size` AND `per_page` at the body top level. Matches what the
Chemotion React client sends in practice.

**Suggested fix (upstream):** make `total_elements` required in the
Grape `search_params` definition, OR guard the usecase to fall back
to `ids.length` when the caller omits it.

---

## `PUT /api/v1/wellplates/:id` NPE when `wells` is omitted

**Discovered:** 2026-04-24 on a live Chemotion 1.x deployment.

**Symptom:** `PUT /api/v1/wellplates/:id` → **500 Internal Server
Error** with a Rails 5xx HTML page when the caller sends a body
that omits `wells`.

**Root cause:** `app/usecases/wellplates/update.rb`:

```ruby
WellplateUpdater
  .new(wellplate: wellplate, current_user: User.find(@user_id))
  .update_wells(well_data: params[:wells])
```

The Grape contract has `optional :wells, type: Array`, so
`params[:wells]` is legitimately nil when omitted. `WellplateUpdater`
dereferences it (iterates with `.each` somewhere downstream) and
NoMethodErrors out to 500.

**Repro:** `PUT /wellplates/:id` with only `{id, container, name}` →
500. Add `"wells": []` → 200 with the updated wellplate envelope.

**Client-side workaround:**
`src/client/client.ts` — `updateWellplate()` defaults `wells: []` when
the caller didn't provide one. Empty array is a no-op in the wells
updater path.

**Suggested fix (upstream):** either mirror the contract by guarding
`update_wells` against nil/empty inputs, or tighten the Grape
contract to `requires :wells, type: Array, default: []`.

---

## Advanced search `field.table` / `filter.table` double-lookup

**Discovered:** 2026-04-24 on a live Chemotion 1.x deployment.

**Symptom:** `POST /api/v1/search/advanced` returns a per-bucket
`"error":"Your search for <column> is not allowed"` for every column,
even well-known ones like `external_label` which the detail-level
rules explicitly allow for every user.

**Root cause:** `app/usecases/search/conditions_for_advanced_search.rb`
method `table_or_detail_level_is_not_allowed?`:

```ruby
def table_or_detail_level_is_not_allowed?(filter)
  filter['field']['table'] = filter['field']['table'] || filter['table']
  filter['field']['column'] = filter['field']['column'] || filter['field']['field']
  adv_field = filter['field'].to_h.merge(@detail_levels).symbolize_keys
  whitelisted_table?(**adv_field) && filter_with_detail_level?(**adv_field)
end
```

The method **mutates** `filter['field']['table']` from
`filter['table']` as a fallback — but if the caller's payload has
**neither**, `adv_field[:table]` becomes `nil` and
`whitelisted_table?` short-circuits false, yielding the generic
"not allowed" error with no diagnostic context about which lookup
failed.

Compounding: the method **name** (`_is_not_allowed?`) reads as
"returns true when not allowed", but the body `whitelisted_table?
&& filter_with_detail_level?` returns **true when allowed**. Its
sole caller uses `next unless table_or_detail_level_is_not_allowed?(filter)`
which reads as "skip if allowed" but actually means "skip if NOT
allowed" — inverted naming.

**Client-side workaround:**
`src/mcp/tools/read.ts` — `chem_search_advanced` now takes a flat
`{link, match, column, value}` from users and assembles the wire's
full `{table, field:{table, column, label}}` wrapper internally,
guaranteeing both lookup paths are populated.

**Suggested fix (upstream):**
1. Rename the method to reflect its actual semantics
   (`filter_is_allowed?`).
2. Emit a specific validation error when `filter.field.table` /
   `filter.table` are both missing, instead of the generic "not
   allowed".
3. Consider making `field.table` required in the Grape
   `advanced_params` Hash definition.

---

## `POST /users/sign_in` form route 406 on JSON Accept

**Discovered:** 2026-04-24 on a live Chemotion 1.x deployment.

**Symptom:** `POST /users/sign_in` with `Accept: application/json`
returns **406 Not Acceptable** even though the endpoint clearly
handles password auth (works fine with `Accept: text/html`).

**Root cause (suspected):** Devise on this Chemotion build has the
JSON sign-in disabled or routed elsewhere, while the HTML form
route is the only supported path. There may be a separate API-mode
Devise endpoint that's undocumented.

**Severity:** Low — clients can always use the HTML form path. But
it's surprising for API consumers and deserves documenting in the
Chemotion API reference if not fixing.

**Client-side workaround:**
`src/client/auth.ts` — form path sends `Accept: text/html,application/xhtml+xml`;
the JSON fallback only fires if the form path doesn't land a session
cookie.

**Suggested fix (upstream):** either enable JSON sign-in globally
(set `Devise.navigational_formats` to include JSON) or document that
only the HTML form is supported on the Grape-era API.

---

## Advanced search LIKE/ILIKE silently wildcards values

**Discovered:** 2026-04-24 on a live Chemotion 1.x deployment.

**Symptom:** `POST /search/advanced` with
`match: "LIKE"`, `value: "%DMSN%"` matches zero rows even though
the target exists. `value: "DMSN"` matches correctly.

**Root cause:** `ConditionsForAdvancedSearch#sanitize_words` wraps
the value with `%…%` on LIKE/ILIKE matches. A caller passing
pre-wildcarded `%DMSN%` becomes `%%DMSN%%` at the SQL layer and
matches nothing.

**Severity:** Low (documentation / DX bug). The server responds
correctly per its contract — but the contract isn't documented
anywhere accessible, so callers mirror classic SQL behaviour and get
silently-wrong results.

**Client-side workaround:**
`src/mcp/tools/read.ts` — `chem_search_advanced` description
explicitly tells the LLM **not to pre-wildcard LIKE/ILIKE values**.
Nothing the client can fix at runtime (would need to strip leading
`%` / trailing `%` heuristically, which would break legitimate use
cases like matching a literal `%` character).

**Suggested fix (upstream):** document the behaviour in the
`/search/advanced` OpenAPI / Swagger spec, OR add a `value_mode`
(`exact` / `substring`) parameter so callers can pick semantics.

---

## How to report upstream

Chemotion's issue tracker:
https://github.com/ComPlat/chemotion_ELN/issues

Include:
- Chemotion version (check `/api/v1/users/current` response for
  version headers, or Gemfile.lock).
- Exact request payload (sanitised — no session cookies).
- Exact response (status + body).
- The file:line reference from this doc.

When an upstream fix lands, move the entry to a "**Fixed upstream**"
section at the bottom of this file with the PR link and the
Chemotion version that includes the fix — don't delete it outright,
since users on older Chemotion versions will still need the
workaround.
