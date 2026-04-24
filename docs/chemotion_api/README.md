# Chemotion JSON API — Reverse-Engineered Reference

Notes on the Chemotion ELN REST API, assembled while building the
`@sura_ai/chemotion-mcp` server. Treat this as a **field guide**, not
an authoritative spec — Chemotion's own public docs are thin and
version-drift between releases is real.

## How this was assembled

- **Live probing** against a Chemotion 1.x deployment (stock
  Chemotion ELN, Grape API under `/api/v1/`, Devise auth).
- **Source reading** from
  [ComPlat/chemotion_ELN](https://github.com/ComPlat/chemotion_ELN)
  — primarily `app/api/chemotion/*_api.rb` for route contracts and
  `app/usecases/search/*.rb` for search semantics.
- **Tool-by-tool smoke tests** logged in
  [`dev-docs/test-and-fix-log.md`](../../dev-docs/test-and-fix-log.md).

Anything marked **verified** was exercised against the live deployment.
Anything marked **per source** is what the Grape routes say but has
not been hit in anger. Sections without either label are a mix.

## Structure

| File | Scope |
|---|---|
| [`authentication.md`](./authentication.md) | Devise login, session cookies, SSO fallback |
| [`collections.md`](./collections.md) | The four collection banks; how "All" works |
| [`elements.md`](./elements.md) | GET / POST / PUT / DELETE for samples, reactions, research plans, wellplates, screens |
| [`search.md`](./search.md) | `/search/*` endpoints with exact wire shapes |
| [`gotchas.md`](./gotchas.md) | Non-obvious pitfalls — read this once before writing code |
| [`upstream-bugs.md`](./upstream-bugs.md) | Bugs in Chemotion itself (not our client) with file:line and workarounds |

## Base URL and envelope conventions

- **Base:** `<instance-root>/api/v1/`. Never include `/api/v1` in
  `CHEMOTION_BASE_URL` — the client prepends it. `/mydb/` in UI URLs is
  a React-router prefix, not an API path.
- **Auth:** Devise session cookie. Every request carries the cookie
  via the client's jar. See `authentication.md`.
- **Content-Type:** `application/json` on every JSON endpoint (writes
  and most reads). The sign-in form route is the exception — see
  `authentication.md`.
- **Single-entity envelope:** `{sample: {...}}`, `{reaction: {...}}`,
  etc. Pluralised list endpoints use `{samples: [...], pagination: {...}}`.
- **Search envelope:** `{samples: {elements: [...], totalElements: n,
  page, perPage, pages, error}, reactions: {...}, ...}` — one bucket
  per element kind.
- **Pagination:** `page` (1-based), `per_page`. Some endpoints (see
  `search/by_ids`) also read `page_size`. Max per_page = 100 in our
  client; server default varies.

## Chemotion version this maps to

Probed against a Chemotion build shipping:
- Grape endpoints listed in `ComPlat/chemotion_ELN@main` as of
  2026-04-24. Wire shapes in this doc match that tag.
- Chemotion routes `/collections/synchronized_roots` returned 404;
  all other routes documented here responded.

## Contributing to these docs

Every new endpoint probed should update **both** this directory and
`dev-docs/test-and-fix-log.md`. The log captures the "how did we find
out" story; these files capture the stable answer.

When the live probe disagrees with the Chemotion source, prefer the
live probe and note the divergence — Chemotion admins sometimes
disable routes or tighten validators.
