# Changelog

## Unreleased

Review against the Chemotion ELN source (v1.10 – v4.0.0).

### Fixed

- `chem_update_wellplate` (and `ChemotionClient.updateWellplate`) deleted every sample in the plate. When `wells` was omitted, the client sent `wells: []`, and Chemotion destroys the samples of wells missing from the payload. Omitted `wells` are now fetched and sent back unchanged.
- `chem_attach_reaction_material` / `chem_attach_reaction_product` cleared `solvent`, `metrics`, `dry_solvent`, `show_label` and gas-phase data on every existing participant. They also dropped v4 SBMM reactants and could 500 on polymer samples. Existing participant rows are now sent back exactly as Chemotion returned them.
- Similarity search sent `search_type: "sim"`, which Chemotion rejects. It now sends `"similar"`; `"sim"` is still accepted as input.
- The date filters on `chem_list_samples` / `chem_list_reactions` sent ISO strings, but the API takes Unix seconds. They also filtered on `updated_at` instead of `created_at`.
- Chemotion v4 compatibility: collections are read from the new `GET /collections`, with a fallback to the pre-v4 routes. Before this, every call that defaulted to the "All" collection failed on v4.
- Collection listing no longer hides 401s and 5xx errors behind an empty list.
- List results show totals again. They are read from Chemotion's `X-Total*` headers.
- The advanced-search docs told callers to add `%` wildcards, which Chemotion matches literally. They also named a non-existent `molecular_weight` column. `match` and `link` are now enums.
- Delete tools no longer claim Chemotion hard-deletes. Elements are soft-deleted but cannot be restored.

### Added

- Credentials mode now uses Chemotion's JWT token route (`/authentication/token` on v4, `/public/token` before) instead of scraping the HTML login form. The form login remains as a fallback.
- `CHEMOTION_API_TOKEN` auth mode for Chemotion v4 personal API tokens. Works for SSO accounts.
- Update tools no longer require `container`, reaction `materials`, or screen id arrays. Omitted values are kept as they are on the server.
- Offline test suite (`npm test`).
- Tool annotations and titles. Reads are marked read-only. Creates are additive. Updates and deletes are marked destructive. `chem_smiles_to_molfile` and SMILES structure search are additive, because Chemotion registers new molecules (and queries PubChem) on conversion.

### Changed

- Tools are registered with `registerTool` instead of the deprecated `server.tool`. Handler arguments are now typed from the input schemas, without casts.
- `noUnusedLocals` / `noUnusedParameters` enabled; dead code removed.

## 0.1.0

- Initial public release.
- Broad Chemotion read support for collections, samples, reactions, research plans, wellplates, screens, attachments, and search.
- Gated write and destructive tools for the main Chemotion entities.
- Chemistry-aware formatting and safer reaction material/product attach helpers.
