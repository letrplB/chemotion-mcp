/**
 * Public library entry for `@sura_ai/chemotion-mcp`.
 *
 * Programmatic access to a Chemotion ELN instance without running the
 * MCP server. Phase 0 scaffold — the client is a stub; real endpoints
 * land in Phase 2 once the auth bootstrap (Phase 1) is in place.
 *
 * ```ts
 * import { ChemotionClient } from '@sura_ai/chemotion-mcp';
 *
 * const client = new ChemotionClient({
 *   baseUrl: 'https://eln.example.org',
 * });
 * ```
 *
 * To run the MCP server instead, invoke the `sura-chemotion-mcp` binary
 * (or `npx @sura_ai/chemotion-mcp`) with the env vars that Phase 1 will
 * document in the README.
 */

export * from './client/index.js';
