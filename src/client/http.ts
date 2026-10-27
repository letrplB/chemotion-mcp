/**
 * Low-level HTTP for the Chemotion ELN JSON API.
 *
 * Design choices:
 *   - Two credentials can ride on a request. `bearerToken` (a JWT from
 *     `/authentication/token` or a `chemtoken_…` API token) goes out as
 *     `Authorization: Bearer`; Chemotion's Grape helper accepts either.
 *     The cookie jar carries Devise session cookies for cookie mode and
 *     the legacy form-login fallback. Every response's `Set-Cookie`
 *     updates the jar.
 *   - 401 → optional `onUnauthorized()` re-login hook. If the hook returns
 *     `true` (refresh succeeded), the original request is retried once.
 *     Credentials-mode wires this up; cookie- and token-mode do not
 *     (there is nothing to re-mint the credential from).
 *   - Two URL bases: most calls prepend `/api/v1` under the Grape tree;
 *     Devise's `/users/sign_in` lives at the Rails root, so login calls
 *     pass `rootPath: true`.
 *   - Permissive on the wire: unknown JSON shapes return as the caller
 *     typed them. The client layer does not enforce a response schema.
 */

export class ChemotionApiError extends Error {
  readonly url: string;
  readonly statusCode: number;
  readonly method: string;
  readonly body: string;

  constructor(
    message: string,
    url: string,
    method: string,
    statusCode: number,
    body: string
  ) {
    super(`chemotion API error: ${message} (${method} ${url})`);
    this.name = 'ChemotionApiError';
    this.url = url;
    this.method = method;
    this.statusCode = statusCode;
    this.body = body;
  }
}

/**
 * In-memory cookie jar scoped to a single Chemotion instance.
 *
 * Chemotion is a single-origin Rails app, so we do not need domain/path
 * matching — every jar entry is sent on every request.
 */
export interface CookieJar {
  /** Set a cookie by name. Overwrites existing. */
  set(name: string, value: string): void;
  /** Read a cookie value. `undefined` if not present. */
  get(name: string): string | undefined;
  /** Remove a cookie by name. */
  delete(name: string): boolean;
  /** Drop every cookie — used on logout / re-login. */
  clear(): void;
  /** Render as a single `Cookie:` header value. */
  toHeader(): string;
  /** Absorb `Set-Cookie` response headers into the jar. */
  absorb(setCookieHeaders: string[]): void;
  /** Snapshot for diagnostics. */
  entries(): Array<[string, string]>;
}

export function makeCookieJar(): CookieJar {
  const cookies = new Map<string, string>();

  return {
    set(name, value) {
      cookies.set(name, value);
    },
    get(name) {
      return cookies.get(name);
    },
    delete(name) {
      return cookies.delete(name);
    },
    clear() {
      cookies.clear();
    },
    toHeader() {
      return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    absorb(setCookieHeaders) {
      for (const raw of setCookieHeaders) {
        // A Set-Cookie header is `name=value; Path=/; HttpOnly; ...`.
        // We only care about name+value; attributes are for browser-level
        // enforcement we don't need.
        const semi = raw.indexOf(';');
        const nv = semi === -1 ? raw : raw.slice(0, semi);
        const eq = nv.indexOf('=');
        if (eq === -1) continue;
        const name = nv.slice(0, eq).trim();
        const value = nv.slice(eq + 1).trim();
        if (!name) continue;
        // Empty / "deleted" value means cookie expiry — drop from jar.
        if (!value || value === '""') {
          cookies.delete(name);
        } else {
          cookies.set(name, value);
        }
      }
    },
    entries() {
      return [...cookies.entries()];
    },
  };
}

/**
 * All the wiring a single HTTP call needs. Kept as a bag of fields
 * (not a class) so the login flow can build one on top of the
 * `ChemotionClient`'s and tweak knobs per-call (`noRefresh`, `rootPath`).
 */
export interface HttpConfig {
  /** Instance root URL. No trailing slash, no `/api/v1` suffix. */
  baseUrl: string;
  userAgent?: string;
  timeoutMs?: number;
  jar: CookieJar;
  /**
   * Sent as `Authorization: Bearer <token>` when set. Holds a JWT
   * minted by the credentials login or a user-supplied API token.
   */
  bearerToken?: string;
  /**
   * Called on 401 responses (except when `noRefresh` is set on the
   * call). Return `true` if a re-login succeeded and the request
   * should be retried once; `false` otherwise.
   */
  onUnauthorized?: () => Promise<boolean>;
  fetchImpl?: typeof fetch;
}

/**
 * `BodyInit` is not ambient in the `@types/node`-only build. Widen
 * to the subset we actually send.
 */
export type RawBody =
  | string
  | URLSearchParams
  | FormData
  | Blob
  | ArrayBuffer
  | Uint8Array;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /**
   * When true, send to `${baseUrl}${path}` instead of
   * `${baseUrl}/api/v1${path}`. Used for Devise (`/users/sign_in`).
   */
  rootPath?: boolean;
  /** JSON-serialized into the body with `application/json`. */
  body?: unknown;
  /**
   * Pre-formed body. When set, `body` is ignored and `Content-Type`
   * is left to the caller (URLSearchParams → application/x-www-form-urlencoded).
   */
  rawBody?: RawBody;
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
  /** Override `Accept`. Defaults to `application/json`. */
  accept?: string;
  /**
   * Disable the 401 → re-login dance. Set for the login flow itself
   * and for probes like `isSessionAlive` where a 401 is information.
   */
  noRefresh?: boolean;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

export function buildUrl(
  config: HttpConfig,
  path: string,
  options: { rootPath?: boolean; query?: Record<string, unknown> } = {}
): string {
  const base = normalizeBaseUrl(config.baseUrl);
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const prefix = options.rootPath ? '' : '/api/v1';
  const url = new URL(`${base}${prefix}${cleanPath}`);

  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item === undefined || item === null) continue;
          url.searchParams.append(`${key}[]`, String(item));
        }
      } else {
        url.searchParams.append(key, String(value));
      }
    }
  }

  return url.toString();
}

/**
 * Node 19.7+/undici 5.19+ exposes `Headers.getSetCookie()` which returns
 * each `Set-Cookie` header separately. Older runtimes only expose
 * `get('set-cookie')` which comma-joins them (and breaks when values
 * contain commas, e.g. `Expires=`). Prefer the modern API; fall back
 * to iteration.
 */
function extractSetCookies(headers: Headers): string[] {
  const h = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === 'function') {
    return h.getSetCookie();
  }
  const out: string[] = [];
  headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') out.push(value);
  });
  return out;
}

async function doFetch(
  config: HttpConfig,
  path: string,
  options: RequestOptions
): Promise<Response> {
  const method = options.method ?? 'GET';
  const url = buildUrl(config, path, {
    rootPath: options.rootPath,
    query: options.query,
  });

  const headers: Record<string, string> = {
    Accept: options.accept ?? 'application/json',
    'User-Agent': config.userAgent ?? 'sura-chemotion-mcp/0.2.0',
    ...options.headers,
  };

  const cookieHeader = config.jar.toHeader();
  if (cookieHeader) headers.Cookie = cookieHeader;
  if (config.bearerToken && !headers.Authorization) {
    headers.Authorization = `Bearer ${config.bearerToken}`;
  }

  let body: RawBody | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
  } else if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.timeoutMs ?? 30_000
  );

  const fetchImpl = config.fetchImpl ?? fetch;

  // Node's fetch accepts a broader body type than we model; cast
  // through NonNullable<RequestInit['body']> which `@types/node`
  // resolves to `BodyInit`-compatible.
  type FetchBody = NonNullable<Parameters<typeof fetch>[1]>['body'];

  try {
    const response = await fetchImpl(url, {
      method,
      headers,
      body: body as FetchBody,
      signal: controller.signal,
      redirect: 'manual',
    });

    config.jar.absorb(extractSetCookies(response.headers));
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Perform a request, follow the 401 re-login dance once, raise
 * `ChemotionApiError` on any non-2xx. Returns the live `Response`
 * so callers can decide how to parse it.
 */
export async function chemotionFetch(
  config: HttpConfig,
  path: string,
  options: RequestOptions = {}
): Promise<Response> {
  const method = options.method ?? 'GET';
  let response = await doFetch(config, path, options);

  if (
    response.status === 401 &&
    !options.noRefresh &&
    config.onUnauthorized
  ) {
    const recovered = await config.onUnauthorized();
    if (recovered) {
      response = await doFetch(config, path, options);
    }
  }

  // Treat manual-handled redirects to the Devise login page as 401.
  // Rails commonly redirects unauthenticated requests to /users/sign_in
  // with a 302, not a 401 — catch that so callers get a consistent
  // "session invalid" signal rather than a mysterious parse error.
  if (
    (response.status === 301 ||
      response.status === 302 ||
      response.status === 303 ||
      response.status === 307 ||
      response.status === 308) &&
    !options.rootPath
  ) {
    const location = response.headers.get('location') ?? '';
    if (/\/users\/sign_in/.test(location)) {
      const url = buildUrl(config, path, {
        rootPath: options.rootPath,
        query: options.query,
      });
      throw new ChemotionApiError(
        '401 redirect to /users/sign_in (session invalid)',
        url,
        method,
        401,
        `Redirect target: ${location}`
      );
    }
  }

  if (!response.ok) {
    const url = buildUrl(config, path, {
      rootPath: options.rootPath,
      query: options.query,
    });
    const errBody = await response.text().catch(() => '');
    throw new ChemotionApiError(
      `${response.status} ${response.statusText}`,
      url,
      method,
      response.status,
      errBody
    );
  }

  return response;
}

/** JSON convenience wrapper around {@link chemotionFetch}. */
export async function chemotionJson<T = unknown>(
  config: HttpConfig,
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const response = await chemotionFetch(config, path, options);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}
