/**
 * Env-var parsing for the Chemotion MCP server.
 *
 * Two mutually-exclusive auth modes:
 *
 *   1. **Credentials mode**: `CHEMOTION_USERNAME` + `CHEMOTION_PASSWORD`.
 *      The MCP performs a Devise login at startup, holds the resulting
 *      session cookie, and refreshes on 401.
 *
 *   2. **Cookie mode**: `CHEMOTION_SESSION_COOKIE` — a raw `Cookie:`
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
  const username = optionalTrim('CHEMOTION_USERNAME');
  const password = optionalTrim('CHEMOTION_PASSWORD');

  const hasCookie = !!rawCookie;
  const hasCreds = !!username && !!password;
  const partialCreds = !!(username || password) && !hasCreds;

  if (hasCookie && hasCreds) {
    throw new ChemotionMcpConfigError(
      'Both CHEMOTION_SESSION_COOKIE and CHEMOTION_USERNAME/PASSWORD are set. ' +
        'Pick one auth mode — cookie mode wins for SSO instances, ' +
        'credentials mode is simpler for local accounts.'
    );
  }

  if (partialCreds) {
    throw new ChemotionMcpConfigError(
      'Credentials mode requires BOTH CHEMOTION_USERNAME and CHEMOTION_PASSWORD. ' +
        `Currently set: ${username ? 'CHEMOTION_USERNAME' : ''}${username && password ? ' and ' : ''}${password ? 'CHEMOTION_PASSWORD' : ''}.`
    );
  }

  if (hasCookie) {
    return { mode: 'cookie', rawCookie };
  }

  if (hasCreds) {
    return { mode: 'credentials', username, password };
  }

  throw new ChemotionMcpConfigError(
    'No auth configured. Set EITHER CHEMOTION_SESSION_COOKIE ' +
      '(a cookie copied from a logged-in browser — works with any auth backend) ' +
      'OR both CHEMOTION_USERNAME and CHEMOTION_PASSWORD ' +
      '(MCP logs in and manages the session for local Chemotion accounts).'
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
  const parsedTimeout = timeoutRaw ? Number.parseInt(timeoutRaw, 10) : undefined;
  const timeoutMs = Number.isFinite(parsedTimeout) ? parsedTimeout : undefined;

  const userAgent =
    optionalTrim('CHEMOTION_USER_AGENT') ?? 'sura-chemotion-mcp/0.1.0';

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
