/**
 * Authentication paths for Chemotion ELN.
 *
 * Chemotion's Grape API resolves the caller from (in order) the Devise
 * session cookie, a `chemtoken_…` API token (v4+), or a JWT, the last
 * two read from the `Authorization` header. Entry points:
 *   1. `loginWithCredentials(http, {username, password})` — mints a JWT
 *      via `POST /api/v1/authentication/token` (v4+) or
 *      `POST /api/v1/public/token` (v1.10 – v3.x) and stores it as the
 *      bearer token. The JWT is valid for two weeks. Only when neither
 *      route exists does it fall back to the Devise HTML form login
 *      (`/users/sign_in`), which needs a scraped CSRF token.
 *   2. `adoptApiToken(http, token)` — use a personal API token created
 *      in the Chemotion profile (v4+). Works for SSO accounts too.
 *   3. `adoptCookie(jar, rawCookie)` — parse a pre-supplied cookie
 *      string (what an SSO-auth'd user copies out of DevTools) and
 *      stuff it into the jar.
 *
 * Plus a shared probe, `isSessionAlive`, that hits `/api/v1/users/current`
 * to confirm the configured credential works. This is the single source
 * of truth for "am I logged in?" — every mode calls it at startup.
 *
 * None of these functions retain state beyond the `HttpConfig` the
 * caller passes in (its jar and bearer token).
 */

import {
  ChemotionApiError,
  type CookieJar,
  type HttpConfig,
  type RawBody,
  chemotionFetch,
  chemotionJson,
} from './http.js';

/** Raised when login fails in a way we can describe concretely. */
export class ChemotionAuthError extends Error {
  constructor(
    message: string,
    readonly hint?: string
  ) {
    super(hint ? `${message}\nHint: ${hint}` : message);
    this.name = 'ChemotionAuthError';
  }
}

export interface Credentials {
  username: string;
  password: string;
}

/**
 * GET the sign-in HTML page and scrape the authenticity_token out of
 * the form. This Chemotion build does NOT set a `CSRF-TOKEN` cookie
 * (only `_chemotion_session`), so the token must be read from the
 * rendered HTML. Also plants the session cookie that the form POST
 * must reuse for the CSRF check to pass.
 *
 * Falls back to `<meta name="csrf-token">` if the form hidden field
 * isn't present. Returns `undefined` if the page couldn't be loaded
 * or parsed — callers then POST without a token and let the server
 * reject with a real error message.
 */
async function fetchSignInPageToken(
  http: HttpConfig
): Promise<string | undefined> {
  try {
    const response = await chemotionFetch(http, '/users/sign_in', {
      method: 'GET',
      rootPath: true,
      noRefresh: true,
      accept: 'text/html',
    });
    const html = await response.text();
    const formMatch = html.match(
      /name="authenticity_token"\s+value="([^"]+)"/
    );
    if (formMatch) return formMatch[1];
    const metaMatch = html.match(
      /<meta\s+name="csrf-token"\s+content="([^"]+)"/
    );
    if (metaMatch) return metaMatch[1];
  } catch {
    // Ignore. The POST below will still run; the server will tell us
    // if the missing token is the problem.
  }
  return undefined;
}

function readCookieCsrfToken(jar: CookieJar): string | undefined {
  // Some Chemotion builds set `CSRF-TOKEN` as a JS-readable cookie;
  // most don't. Try both spellings as a fallback when HTML-scrape fails.
  const raw = jar.get('CSRF-TOKEN') ?? jar.get('X-CSRF-Token');
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Did the sign-in response actually hand us a session cookie? */
function hasSessionCookie(jar: CookieJar): boolean {
  return jar.entries().some(([name]) => /session/i.test(name));
}

async function postSignIn(
  http: HttpConfig,
  creds: Credentials,
  shape: 'form' | 'json',
  authenticityToken: string | undefined
): Promise<Response> {
  // Accept: text/html on the form path — Chemotion's Devise config
  // only renders HTML on /users/sign_in for form submits and returns
  // 406 on Accept: application/json. JSON path uses a JSON Accept so
  // the JSON renderer fires (on instances that enable API-mode Devise).
  const headers: Record<string, string> = {
    Accept: shape === 'form' ? 'text/html,application/xhtml+xml' : 'application/json',
  };
  if (authenticityToken) headers['X-CSRF-Token'] = authenticityToken;

  // Chemotion's Devise config uses a custom `:login` field that accepts
  // EITHER the email OR the user's `name_abbreviation`. Sending
  // `user[email]` (the vanilla Devise field) is silently ignored and
  // the login param reaches the strategy as nil → "Invalid Login or
  // password". Always send `user[login]`.
  let rawBody: RawBody;
  if (shape === 'form') {
    const form = new URLSearchParams();
    form.set('user[login]', creds.username);
    form.set('user[password]', creds.password);
    form.set('user[remember_me]', '0');
    if (authenticityToken) form.set('authenticity_token', authenticityToken);
    rawBody = form;
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  } else {
    headers['Content-Type'] = 'application/json';
    const payload: Record<string, unknown> = {
      user: { login: creds.username, password: creds.password },
    };
    if (authenticityToken) payload.authenticity_token = authenticityToken;
    rawBody = JSON.stringify(payload);
  }

  return chemotionFetch(http, '/users/sign_in', {
    method: 'POST',
    rootPath: true,
    noRefresh: true,
    rawBody,
    headers,
  });
}

/**
 * Mint a JWT from username + password. Tries the v4 route first, then
 * the pre-v4 one. Returns `undefined` when neither route exists on the
 * instance (404/405), so the caller can fall back to the form login.
 * Throws `ChemotionAuthError` on rejected credentials.
 */
async function mintJwt(
  http: HttpConfig,
  creds: Credentials
): Promise<string | undefined> {
  for (const path of ['/authentication/token', '/public/token']) {
    try {
      const response = await chemotionJson<{ token?: unknown }>(http, path, {
        method: 'POST',
        noRefresh: true,
        body: { username: creds.username, password: creds.password },
      });
      if (typeof response?.token === 'string' && response.token) {
        return response.token;
      }
    } catch (error) {
      if (!(error instanceof ChemotionApiError)) throw error;
      if (error.statusCode === 401) {
        throw new ChemotionAuthError(
          'Chemotion rejected the username or password (401 from the token endpoint).',
          'CHEMOTION_USERNAME accepts the email or the name abbreviation (case-sensitive). ' +
            'If your instance uses SSO, create an API token in your Chemotion profile and set CHEMOTION_API_TOKEN instead.'
        );
      }
      if (error.statusCode >= 500) throw error;
      // 404/405/400: route missing or shaped differently on this build.
    }
  }
  return undefined;
}

/**
 * Log in with `username` (email OR `name_abbreviation` — Chemotion
 * accepts either, case-sensitive) and password.
 *
 * Flow:
 *   1. Mint a JWT (see `mintJwt`) and send it as a bearer token.
 *   2. If the instance has no token route, fall back to the Devise form
 *      login: GET `/users/sign_in` to absorb the session cookie and
 *      scrape the `authenticity_token`, POST the form with
 *      `user[login]`, and retry JSON-encoded if no session cookie
 *      landed.
 *   3. Probe `/api/v1/users/current` to confirm the credential works.
 *
 * Throws `ChemotionAuthError` with actionable hints.
 */
export async function loginWithCredentials(
  http: HttpConfig,
  creds: Credentials
): Promise<void> {
  if (!creds.username || !creds.password) {
    throw new ChemotionAuthError(
      'Missing username or password.',
      'Set CHEMOTION_USERNAME and CHEMOTION_PASSWORD in the MCP env.'
    );
  }

  // Start from a clean slate so a stale cookie or token can't make a
  // failed login look successful.
  http.jar.clear();
  http.bearerToken = undefined;

  const jwt = await mintJwt(http, creds);
  if (jwt) {
    http.bearerToken = jwt;
  } else {
    await loginWithDeviseForm(http, creds);
  }

  // Necessary, not sufficient — confirm we can actually read protected
  // data with what we were handed.
  const alive = await isSessionAlive(http);
  if (!alive) {
    throw new ChemotionAuthError(
      'Login succeeded but /users/current still returns 401.',
      'Check that CHEMOTION_USERNAME is an email the instance recognises and the account is active.'
    );
  }
}

/** Legacy fallback for instances without a token route. */
async function loginWithDeviseForm(
  http: HttpConfig,
  creds: Credentials
): Promise<void> {
  const scrapedToken = await fetchSignInPageToken(http);
  const authenticityToken = scrapedToken ?? readCookieCsrfToken(http.jar);

  let lastError: ChemotionApiError | undefined;

  for (const shape of ['form', 'json'] as const) {
    try {
      await postSignIn(http, creds, shape, authenticityToken);
      if (hasSessionCookie(http.jar)) break;
    } catch (error) {
      if (error instanceof ChemotionApiError) {
        lastError = error;
        // 401/422 are credential/CSRF issues — keep trying other shapes
        // but only if the shape might help. 5xx / network should stop us.
        if (error.statusCode >= 500) throw error;
      } else {
        throw error;
      }
    }
  }

  if (!hasSessionCookie(http.jar)) {
    const detail = lastError
      ? `last response: ${lastError.statusCode} ${lastError.body.slice(0, 400)}`
      : 'sign_in returned 2xx but no session cookie landed';
    throw new ChemotionAuthError(
      `Login to Chemotion failed (${detail}).`,
      'Verify CHEMOTION_USERNAME / CHEMOTION_PASSWORD. If your instance uses SSO (Shibboleth/OIDC/ORCID/GitHub), use CHEMOTION_API_TOKEN (Chemotion v4+) or CHEMOTION_SESSION_COOKIE instead.'
    );
  }
}

/**
 * Use a pre-issued bearer credential: a personal API token
 * (`chemtoken_…`, created under Profile → API tokens in Chemotion v4+)
 * or a JWT minted elsewhere.
 */
export function adoptApiToken(http: HttpConfig, token: string): void {
  http.bearerToken = token.trim().replace(/^bearer\s+/i, '');
}

/**
 * Accept a `Cookie:` header value (or a single `name=value` pair)
 * from outside the MCP — typically copied from a logged-in browser —
 * and store its name/value pairs in the jar. Attributes (`Path`,
 * `Domain`, `Secure`, `HttpOnly`, `SameSite`, `Max-Age`, `Expires`)
 * are stripped; only name=value survives.
 *
 * Accepts both the exact `Cookie:` header form and the
 * browser-DevTools "Copy as cURL" form with backslash-quotes.
 */
export function adoptCookie(jar: CookieJar, rawCookie: string): void {
  // Strip leading `Cookie: ` prefix if the operator pasted the whole
  // header, plus any surrounding quotes.
  let cleaned = rawCookie.trim();
  cleaned = cleaned.replace(/^cookie:\s*/i, '');
  cleaned = cleaned.replace(/^["']|["']$/g, '');

  const ATTR_NAMES = new Set([
    'path',
    'domain',
    'expires',
    'max-age',
    'secure',
    'httponly',
    'samesite',
  ]);

  for (const piece of cleaned.split(';')) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      // Bareword attribute like `Secure` or `HttpOnly`.
      continue;
    }
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!name) continue;
    if (ATTR_NAMES.has(name.toLowerCase())) continue;
    if (!value) continue;
    jar.set(name, value);
  }
}

/**
 * Is the current jar a live session? Hits `/api/v1/users/current`
 * with `noRefresh` so a 401 surfaces instead of triggering the
 * `onUnauthorized` hook.
 *
 * Returns `false` on 401/302-to-login; re-throws anything else
 * (network, 5xx) because those leave session health ambiguous.
 */
export async function isSessionAlive(http: HttpConfig): Promise<boolean> {
  try {
    await chemotionJson(http, '/users/current', { noRefresh: true });
    return true;
  } catch (error) {
    if (error instanceof ChemotionApiError && error.statusCode === 401) {
      return false;
    }
    throw error;
  }
}
