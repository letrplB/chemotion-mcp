# @sura_ai/chemotion

Model Context Protocol server for Chemotion ELN. It gives MCP-aware clients a typed Chemotion connector for collections, samples, reactions, research plans, wellplates, screens, attachments, and search.

Status: `0.1.0`. The API surface is reverse-engineered from Chemotion's `api/v1` routes and verified against a live Chemotion 1.x deployment.

## Features

- Read collections, samples, reactions, research plans, wellplates, screens, and attachments.
- Search by free text, structured filters, ids, short labels, substructure, and similarity.
- Create, update, and delete samples, reactions, research plans, wellplates, and screens.
- Handle both auth modes Chemotion exposes in practice: credentials login and copied browser session cookies.
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

1. Credentials mode

```bash
CHEMOTION_BASE_URL=https://eln.example.org
CHEMOTION_USERNAME=you@example.org
CHEMOTION_PASSWORD=replace-me
```

2. Session-cookie mode

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
npm run build
npm run smoke
```

`scripts/smoke.ts` uses the same env vars as the server and probes a live Chemotion instance.

## Docs

- API notes: [`docs/chemotion_api`](./docs/chemotion_api)
- Reverse-engineering log: [`dev-docs`](./dev-docs)

## Security Notes

- Do not commit `.env` files, copied session cookies, or local MCP client config.
- The repo's `.gitignore` excludes common secret-bearing local files by default.
- Public docs use anonymized examples. Keep raw live-instance notes in ignored local files if you need them.

## License

MIT. See [`LICENSE`](./LICENSE).
