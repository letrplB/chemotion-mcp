/**
 * Public library entry for `@sura_ai/chemotion`.
 *
 * Programmatic access to a Chemotion ELN instance without running the
 * MCP server.
 *
 * ```ts
 * import { ChemotionClient } from '@sura_ai/chemotion';
 *
 * const client = new ChemotionClient({
 *   baseUrl: 'https://eln.example.org',
 * });
 * ```
 *
 * To run the MCP server instead, invoke the `sura-chemotion-mcp` binary
 * (or `npx @sura_ai/chemotion`) with the env vars documented in the
 * README.
 */

export * from './client/index.js';
