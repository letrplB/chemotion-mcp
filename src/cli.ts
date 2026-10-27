#!/usr/bin/env node
/**
 * @module Chemotion MCP Server — CLI entry
 *
 * Standalone MCP server that wraps the Chemotion ELN JSON API. Runs
 * as a stdio child process of any MCP-aware client (Claude Desktop,
 * Claude Code, Cursor). See README for env-var documentation.
 *
 * Startup sequence:
 *   1. Load + validate env vars.
 *   2. Build a ChemotionClient and bootstrap its credential:
 *        - credentials mode → mint a JWT (form-login fallback)
 *        - token mode       → send the API token as a bearer token
 *        - cookie mode      → adopt the supplied Cookie header
 *   3. Probe /api/v1/users/current. Fail loudly if the session is dead.
 *   4. Register the read tools, plus write tools when enabled.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ChemotionClient } from './client/index.js';
import { type ChemotionMcpConfig, loadConfig } from './mcp/config.js';
import { registerReadTools } from './mcp/tools/read.js';
import { registerWriteTools } from './mcp/tools/write.js';

async function bootstrapClient(): Promise<{
  client: ChemotionClient;
  config: ChemotionMcpConfig;
}> {
  const config = loadConfig();

  const { auth } = config;

  // Wire the 401 re-login hook first — but only for credentials mode,
  // since token and cookie mode have nothing to re-mint from.
  let client!: ChemotionClient;
  const onUnauthorized =
    auth.mode === 'credentials'
      ? async () => {
          try {
            await client.loginWithCredentials(auth);
            return true;
          } catch (error) {
            // biome-ignore lint/suspicious/noConsole: diagnostic on stderr
            console.error(
              '[chemotion-mcp] 401 re-login failed:',
              error instanceof Error ? error.message : String(error)
            );
            return false;
          }
        }
      : undefined;

  client = new ChemotionClient({
    baseUrl: config.baseUrl,
    userAgent: config.userAgent,
    timeoutMs: config.timeoutMs,
    onUnauthorized,
  });

  if (auth.mode === 'credentials') {
    await client.loginWithCredentials(auth);
    return { client, config };
  }

  if (auth.mode === 'token') {
    client.adoptApiToken(auth.token);
  } else {
    client.adoptCookie(auth.rawCookie);
  }
  if (!(await client.isSessionAlive())) {
    throw new Error(
      auth.mode === 'token'
        ? 'CHEMOTION_API_TOKEN was rejected by the instance (401 on /users/current). ' +
            'The token may be revoked or expired, or the instance predates API tokens (Chemotion < 4.0).'
        : 'CHEMOTION_SESSION_COOKIE was rejected by the instance (401 on /users/current). ' +
            'Re-copy a fresh cookie from a logged-in browser session.'
    );
  }

  return { client, config };
}

async function main(): Promise<void> {
  const { client, config } = await bootstrapClient();

  const server = new McpServer({
    name: 'sura-chemotion',
    version: '0.2.0',
  });

  registerReadTools(server, client, config);
  registerWriteTools(server, client, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  // biome-ignore lint/suspicious/noConsole: CLI entry point, stderr is appropriate
  console.error(
    'chemotion MCP server failed to start:',
    error instanceof Error ? error.message : String(error)
  );
  process.exit(1);
});
