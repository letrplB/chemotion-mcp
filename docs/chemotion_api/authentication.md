# Authentication

Chemotion authenticates via Devise session cookies. Two usable modes:

1. **Credentials mode** — client performs the sign-in dance and
   manages the cookie.
2. **Cookie mode** — operator copies a live session cookie out of
   DevTools and the client adopts it as-is. Works with any auth
   backend including SSO.

## Credentials flow (verified)

Standard Devise sign-in, but with Chemotion-specific deviations that
bit us hard during reverse-engineering.

### Step 1: Prime the session

```
GET /users/sign_in
Accept: text/html
```

- Server returns 200 + HTML form + sets `_chemotion_session` cookie.
- Scrape the authenticity token from the form. **This build does not
  set a `CSRF-TOKEN` cookie** — the token lives only in:
  - `<input type="hidden" name="authenticity_token" value="…">`, or
  - `<meta name="csrf-token" content="…">`

### Step 2: POST credentials

```
POST /users/sign_in
Accept: text/html                             ← not application/json!
Content-Type: application/x-www-form-urlencoded
Cookie: _chemotion_session=…                  ← from step 1
X-CSRF-Token: <token from step 1>             ← also included in body

user[login]=<email-or-name-abbreviation>
user[password]=<password>
user[remember_me]=0
authenticity_token=<token>
commit=Log+in
```

Key gotchas:

- **Field is `user[login]`, not `user[email]`.** Chemotion's Devise
  config accepts email OR `name_abbreviation`, case-sensitive.
  Sending `user[email]` is silently ignored and login always fails
  with "You need to sign in or sign up before continuing" (a Warden
  fallback, NOT Devise's `invalid` message — runtime stays at 3 ms
  because bcrypt never runs).
- **`Accept: application/json` returns 406.** The form route only
  renders HTML. There is a separate JSON Devise path but it's
  inconsistent across builds; prefer HTML form with the `commit`
  field.
- **CSRF token required.** Missing or stale token → 401 with the same
  Warden fallback message. Re-scrape from the `<meta>` or hidden form
  field per login attempt.

### Step 3: Handle the response

- Success → **302** redirect to `/` with a **fresh** `_chemotion_session`
  cookie. Follow the redirect (or keep the rotated cookie) and you're
  logged in.
- Failure → 200 with HTML containing `<div class='alert alert-warning'>
  Invalid Login or password.</div>`. Runtime ≈ 80ms (bcrypt runs).

Our client uses `redirect: 'manual'` so it captures the rotated
cookie from the 302 directly without losing it to an automatic
follow.

### Step 4: Confirm the session

```
GET /api/v1/users/current
```

Returns `{user: {...}}` on success, 401 on dead session. The client
uses this as a session-alive probe after login and as the re-login
trigger when an arbitrary call returns 401.

## Cookie mode

For SSO instances (Shibboleth, OIDC, ORCID, GitHub) where the
credentials flow above won't work, operators log into the web UI in a
browser and copy `_chemotion_session` from DevTools. Our client
accepts:

- The raw `Cookie: …` header value (whole thing).
- A single `name=value` pair.
- The DevTools "Copy as cURL" format with backslash-quotes.

Attributes (`Path`, `Domain`, `Secure`, `HttpOnly`, `SameSite`,
`Max-Age`, `Expires`) are stripped; only `name=value` survives.

Cookie-mode sessions expire silently — we surface the resulting 401
to the caller instead of attempting a re-login, since we have no
credentials to re-mint with.

## Session verification (both modes)

`GET /api/v1/users/current` is the canonical "am I logged in" probe.
- 200 → session live
- 401 → session dead (or cookie rejected at adoption time)
- 302 to `/users/sign_in` on a bare GET `/` from some instances —
  our client treats any redirect-target-matches-sign_in as 401.

## Reference

Implementation: `src/client/auth.ts`.
Probed against a live Chemotion 1.x deployment on 2026-04-24.
