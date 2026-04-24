/**
 * Authentication paths for Chemotion ELN.
 *
 * Two entry points:
 *   1. `loginWithCredentials(http, {username, password})` — performs the
 *      Devise sign-in dance. GET the root to collect any CSRF cookie,
 *      then POST `/users/sign_in` form-encoded (what the UI sends) and
 *      let the `Set-Cookie` response populate the jar. Optionally
 *      followed by a JSON retry if the form path didn't land a session
 *      cookie, since some Devise configs only honour JSON on that
 *      route.
 *   2. `adoptCookie(jar, rawCookie)` — parse a pre-supplied cookie
 *      string (what an SSO-auth'd user copies out of DevTools) and
 *      stuff it into the jar.
 *
 * Plus a shared probe, `isSessionAlive`, that hits `/api/v1/users/current`
 * to confirm the jar currently corresponds to a live session. This is
 * the single source of truth for "am I logged in?" — both modes call
 * it at startup.
 *
 * None of these functions retain state beyond the jar the caller
 * passes in. The jar is the session.
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
 * Log in with `username` (email OR `name_abbreviation` — Chemotion's
 * Devise config accepts either, case-sensitive) and password. On
 * success the `http.jar` holds a live session cookie.
 *
 * Flow:
 *   1. GET `/users/sign_in` as HTML to absorb the `_chemotion_session`
 *      cookie AND scrape the `authenticity_token` from the form.
 *   2. POST `/users/sign_in` form-encoded with `user[login]` +
 *      `authenticity_token` (the UI shape).
 *   3. If the jar didn't gain a session cookie, retry JSON-encoded —
 *      some API-only Devise configs reject the form shape.
 *   4. Probe `/api/v1/users/current` to confirm the cookie works.
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

  // Start from a clean jar so we're not reusing a stale session cookie
  // that would mislead `hasSessionCookie` into thinking we succeeded.
  http.jar.clear();
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
      'Verify CHEMOTION_USERNAME / CHEMOTION_PASSWORD. If your instance uses SSO (Shibboleth/OIDC/ORCID/GitHub), use CHEMOTION_SESSION_COOKIE mode instead.'
    );
  }

  // Cookie jar has a session cookie, but that's necessary, not
  // sufficient — some auth flows plant a half-baked cookie on
  // rejected logins. Confirm we can actually read protected data.
  const alive = await isSessionAlive(http);
  if (!alive) {
    throw new ChemotionAuthError(
      'Login response set a session cookie but /users/current still returns 401.',
      'Check that CHEMOTION_USERNAME is an email the instance recognises and the account is active.'
    );
  }
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
