/**
 * Env-var parsing for the Chemotion MCP server.
 *
 * Three mutually-exclusive auth modes:
 *
 *   1. **Credentials mode**: `CHEMOTION_USERNAME` + `CHEMOTION_PASSWORD`.
 *      The MCP mints a JWT at startup (falling back to a Devise form
 *      login on instances without a token route) and re-logs in on 401.
 *
 *   2. **Token mode**: `CHEMOTION_API_TOKEN` — a personal API token
 *      (`chemtoken_…`) created in the Chemotion profile (v4+, needs
 *      2FA enabled on the account). Works for SSO accounts and expires
 *      on the date chosen at creation.
 *
 *   3. **Cookie mode**: `CHEMOTION_SESSION_COOKIE` — a raw `Cookie:`
 *      header value (or a single `name=value` pair) copied out of a
 *      logged-in browser session. Works with every auth backend
 *      (local, Shibboleth, OIDC, ORCID, GitHub) but expires silently;
 *      the MCP surfaces 401s to the caller rather than attempting a
 *      re-mint.
 *
 * Exactly one mode must be configured. Specifying both is rejected.
 *
 * The remaining flags mirror the `@sura_ai/elabftw` pattern:
 * write-gate + destructive-gate + PII-reveal flag, all default-off.
 */

export type ChemotionAuthConfig =
  | { mode: 'credentials'; username: string; password: string }
  | { mode: 'token'; token: string }
  | { mode: 'cookie'; rawCookie: string };

export interface ChemotionMcpConfig {
  baseUrl: string;
  userAgent?: string;
  timeoutMs?: number;
  auth: ChemotionAuthConfig;
  allowWrites: boolean;
  allowDestructive: boolean;
  revealUserIdentities: boolean;
}

export class ChemotionMcpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChemotionMcpConfigError';
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new ChemotionMcpConfigError(
      `Missing required env var ${name}. See the README of @sura_ai/chemotion.`
    );
  }
  return value.trim();
}

function optionalBool(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function optionalTrim(name: string): string | undefined {
  const raw = process.env[name];
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function parseAuth(): ChemotionAuthConfig {
  const rawCookie = optionalTrim('CHEMOTION_SESSION_COOKIE');
  const token = optionalTrim('CHEMOTION_API_TOKEN');
  const username = optionalTrim('CHEMOTION_USERNAME');
  const password = optionalTrim('CHEMOTION_PASSWORD');

  const hasCreds = !!username && !!password;
  const partialCreds = !!(username || password) && !hasCreds;

  if (partialCreds) {
    throw new ChemotionMcpConfigError(
      'Credentials mode requires BOTH CHEMOTION_USERNAME and CHEMOTION_PASSWORD. ' +
        `Currently set: ${username ? 'CHEMOTION_USERNAME' : 'CHEMOTION_PASSWORD'} only.`
    );
  }

  const configured = [
    hasCreds ? 'CHEMOTION_USERNAME/PASSWORD' : null,
    token ? 'CHEMOTION_API_TOKEN' : null,
    rawCookie ? 'CHEMOTION_SESSION_COOKIE' : null,
  ].filter((name): name is string => name !== null);

  if (configured.length > 1) {
    throw new ChemotionMcpConfigError(
      `Several auth modes are set (${configured.join(', ')}). Pick one.`
    );
  }

  if (hasCreds) return { mode: 'credentials', username, password };
  if (token) return { mode: 'token', token };
  if (rawCookie) return { mode: 'cookie', rawCookie };

  throw new ChemotionMcpConfigError(
    'No auth configured. Set ONE of: ' +
      'CHEMOTION_USERNAME + CHEMOTION_PASSWORD (local Chemotion accounts), ' +
      'CHEMOTION_API_TOKEN (a personal API token from your Chemotion profile, v4+, works with SSO), ' +
      'or CHEMOTION_SESSION_COOKIE (a cookie copied from a logged-in browser).'
  );
}

export function loadConfig(): ChemotionMcpConfig {
  const baseUrl = requireEnv('CHEMOTION_BASE_URL').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new ChemotionMcpConfigError(
      `CHEMOTION_BASE_URL must include the scheme (http:// or https://). Got: ${baseUrl}`
    );
  }
  if (/\/api(\/v\d+)?$/.test(baseUrl)) {
    throw new ChemotionMcpConfigError(
      `CHEMOTION_BASE_URL must NOT include the /api/v1 suffix. Got: ${baseUrl}. ` +
        'The client appends /api/v1 itself.'
    );
  }

  const timeoutRaw = process.env.CHEMOTION_TIMEOUT_MS;
  const parsedTimeout = timeoutRaw ? Number.parseInt(timeoutRaw, 10) : Number.NaN;
  const timeoutMs = parsedTimeout > 0 ? parsedTimeout : undefined;

  const userAgent =
    optionalTrim('CHEMOTION_USER_AGENT') ?? 'sura-chemotion-mcp/0.2.0';

  return {
    baseUrl,
    userAgent,
    timeoutMs,
    auth: parseAuth(),
    allowWrites: optionalBool('CHEMOTION_ALLOW_WRITES'),
    allowDestructive: optionalBool('CHEMOTION_ALLOW_DESTRUCTIVE'),
    revealUserIdentities: optionalBool('CHEMOTION_REVEAL_USER_IDENTITIES'),
  };
}
