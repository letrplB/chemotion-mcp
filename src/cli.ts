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
 *   2. Build a ChemotionClient and bootstrap its session cookie jar:
 *        - credentials mode → POST /users/sign_in
 *        - cookie mode      → adopt the supplied Cookie header
 *   3. Probe /api/v1/users/current. Fail loudly if the session is dead.
 *   4. Register MCP tools (Phase 4+ — empty today).
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

  // Wire the 401 re-login hook first — but only for credentials mode,
  // since cookie mode has no password to re-mint the session with.
  let client!: ChemotionClient;
  const onUnauthorized =
    config.auth.mode === 'credentials'
      ? async () => {
          try {
            await client.loginWithCredentials({
              username: config.auth.mode === 'credentials'
                ? config.auth.username
                : '',
              password: config.auth.mode === 'credentials'
                ? config.auth.password
                : '',
            });
            return true;
          } catch (error) {
            // biome-ignore lint/suspicious/noConsole: startup diagnostic
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

  if (config.auth.mode === 'credentials') {
    await client.loginWithCredentials({
      username: config.auth.username,
      password: config.auth.password,
    });
  } else {
    client.adoptCookie(config.auth.rawCookie);
    const alive = await client.isSessionAlive();
    if (!alive) {
      throw new Error(
        'CHEMOTION_SESSION_COOKIE was rejected by the instance (401 on /users/current). ' +
          'Re-copy a fresh cookie from a logged-in browser session.'
      );
    }
  }

  return { client, config };
}

async function main(): Promise<void> {
  const { client, config } = await bootstrapClient();

  const server = new McpServer({
    name: 'sura-chemotion',
    version: '0.2.0-alpha.0',
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
