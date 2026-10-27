# Chemotion JSON API — Reverse-Engineered Reference

Notes on the Chemotion ELN REST API, assembled while building the
`@sura_ai/chemotion` server. Treat this as a **field guide**, not
an authoritative spec — Chemotion still publishes no API reference
(as of 2026-10, the only Swagger output is generated in development
mode), and the API changes between releases.

## How this was assembled

- **Live probing** against a pre-v4 Chemotion deployment (stock
  Chemotion ELN, Grape API under `/api/v1/`, Devise auth).
- **Source reading** from
  [ComPlat/chemotion_ELN](https://github.com/ComPlat/chemotion_ELN)
  — primarily `app/api/chemotion/*_api.rb` for route contracts and
  `app/usecases/search/*.rb` for search semantics.
- **Tool-by-tool smoke tests** logged in a local, unpublished
  `dev-docs/` folder.
- **Source review against v4.0.0** (released 2026-10-13), which
  changed the collection API and added API tokens.

Anything marked **verified** was exercised against the live deployment.
Anything marked **per source** is what the Grape routes say but has
not been hit in anger. Sections without either label are a mix.

## Structure

| File | Scope |
|---|---|
| [`authentication.md`](./authentication.md) | JWT login, API tokens (v4), Devise form fallback, session cookies |
| [`collections.md`](./collections.md) | The four collection banks; how "All" works |
| [`elements.md`](./elements.md) | GET / POST / PUT / DELETE for samples, reactions, research plans, wellplates, screens |
| [`search.md`](./search.md) | `/search/*` endpoints with exact wire shapes |
| [`gotchas.md`](./gotchas.md) | Non-obvious pitfalls — read this once before writing code |
| [`upstream-bugs.md`](./upstream-bugs.md) | Bugs in Chemotion itself (not our client) with file:line and workarounds |

## Base URL and envelope conventions

- **Base:** `<instance-root>/api/v1/`. Never include `/api/v1` in
  `CHEMOTION_BASE_URL` — the client prepends it. `/mydb/` in UI URLs is
  a React-router prefix, not an API path.
- **Auth:** `Authorization: Bearer <jwt | chemtoken_…>`, or a Devise
  session cookie. See `authentication.md`.
- **Content-Type:** `application/json` on every JSON endpoint (writes
  and most reads). The sign-in form route is the exception — see
  `authentication.md`.
- **Single-entity envelope:** `{sample: {...}}`, `{reaction: {...}}`,
  etc. Pluralised list endpoints use `{samples: [...], pagination: {...}}`.
- **Search envelope:** `{samples: {elements: [...], totalElements: n,
  page, perPage, pages, error}, reactions: {...}, ...}` — one bucket
  per element kind.
- **Pagination:** `page` (1-based), `per_page`; list totals arrive
  in `X-Total` / `X-Total-Pages` headers. Some endpoints (see
  `search/by_ids`) also read `page_size`. Max per_page = 100 in our
  client; server default varies.

## Chemotion version this maps to

- Live-probed on a pre-v4 deployment (2026-04-24, `main` of that
  date). `/collections/synchronized_roots` returned 404; all other
  routes documented here responded.
- Re-checked against the source of v4.0.0 (2026-10-13). The v4
  differences are called out inline: collections, API tokens, and
  `/authentication/token`. v4 has not been probed live.

## Contributing to these docs

Every new endpoint probed should update this directory. Keep raw
probe logs out of the repo; they may contain live-instance data.

When the live probe disagrees with the Chemotion source, prefer the
live probe and note the divergence — Chemotion admins sometimes
disable routes or tighten validators.
