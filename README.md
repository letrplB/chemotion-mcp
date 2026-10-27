# @sura_ai/chemotion

Model Context Protocol server for Chemotion ELN. It gives MCP-aware clients a typed Chemotion connector for collections, samples, reactions, research plans, wellplates, screens, attachments, and search.

Status: `0.2.0`. Chemotion publishes no API reference, so the API surface is reverse-engineered from the Grape routes in [ComPlat/chemotion_ELN](https://github.com/ComPlat/chemotion_ELN). It was verified live against a pre-v4 deployment and checked against the v4.0.0 source (2026-10). Chemotion v4 changed the collection API; the client supports both versions.

## Features

- Read collections, samples, reactions, research plans, wellplates, screens, and attachments.
- Search by free text, structured filters, ids, short labels, substructure, and similarity.
- Create, update, and delete samples, reactions, research plans, wellplates, and screens.
- Three auth modes: username/password (JWT), personal API token (Chemotion v4+), or a copied browser session cookie.
- Gate writes and destructive actions behind explicit env flags.
- Preserve chemistry-specific data such as SMILES, InChI, formulae, molfile payloads, stoichiometry, and wellplate layouts.

## Install

```bash
npm install @sura_ai/chemotion
```

Or run it directly:

```bash
npx -y @sura_ai/chemotion
```

## Configuration

Set `CHEMOTION_BASE_URL` to the Chemotion instance root. Do not include `/api/v1`.

Choose exactly one auth mode:

1. Credentials mode, for local Chemotion accounts. The server mints a JWT from `/api/v1/authentication/token` (v4) or `/api/v1/public/token` (v1.10–v3). The JWT lasts two weeks, and the server logs in again when it expires. Instances without either route fall back to the HTML form login.

```bash
CHEMOTION_BASE_URL=https://eln.example.org
CHEMOTION_USERNAME=you@example.org   # email or name abbreviation, case-sensitive
CHEMOTION_PASSWORD=replace-me
```

2. API-token mode, for Chemotion v4+. This works for SSO accounts. Create the token in the Chemotion profile under API tokens. The account needs two-factor authentication enabled. A token expires after the 1–600 days chosen when it was created.

```bash
CHEMOTION_BASE_URL=https://eln.example.org
CHEMOTION_API_TOKEN=chemtoken_replace-me
```

3. Session-cookie mode, as a last resort for SSO instances older than v4. Copied cookies expire silently.

```bash
CHEMOTION_BASE_URL=https://eln.example.org
CHEMOTION_SESSION_COOKIE=_chemotion_session=replace-me
```

Optional flags:

- `CHEMOTION_TIMEOUT_MS`
- `CHEMOTION_USER_AGENT`
- `CHEMOTION_ALLOW_WRITES=true`
- `CHEMOTION_ALLOW_DESTRUCTIVE=true`
- `CHEMOTION_REVEAL_USER_IDENTITIES=true`

Write tools are off by default. Destructive tools require both `CHEMOTION_ALLOW_WRITES=true` and `CHEMOTION_ALLOW_DESTRUCTIVE=true`.

Update tools only change the fields you pass. A reaction's participants, a wellplate's wells, a screen's links and the analyses container are hidden state that Chemotion requires on every PUT. When you leave them out, the server sends their current values back, so a rename cannot drop them.

## MCP Example

```json
{
  "mcpServers": {
    "chemotion": {
      "command": "npx",
      "args": ["-y", "@sura_ai/chemotion"],
      "env": {
        "CHEMOTION_BASE_URL": "https://eln.example.org",
        "CHEMOTION_USERNAME": "you@example.org",
        "CHEMOTION_PASSWORD": "replace-me",
        "CHEMOTION_ALLOW_WRITES": "false"
      }
    }
  }
}
```

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run smoke
```

`npm test` runs offline tests against a stubbed `fetch`. `scripts/smoke.ts` uses the same env vars as the server and probes a live Chemotion instance; it only reads.

## Docs

- API notes: [`docs/chemotion_api`](./docs/chemotion_api)

## Security Notes

- Do not commit `.env` files, copied session cookies, or local MCP client config.
- The repo's `.gitignore` excludes common secret-bearing local files by default.
- Public docs use anonymized examples. Keep raw live-instance notes in ignored local files if you need them.

## License

MIT. See [`LICENSE`](./LICENSE).
