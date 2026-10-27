# Authentication

Chemotion's Grape API (`app/api/api.rb`) resolves the caller in this
order:

1. the Devise **session cookie**,
2. a personal **API token** (`chemtoken_…`) in `Authorization: Bearer`
   (v4.0.0+),
3. a **JWT** in `Authorization` (since at least v1.10).

The client exposes three modes on top of that:

| Mode | Env | Mechanism | Works with SSO | Expiry |
|---|---|---|---|---|
| Credentials | `CHEMOTION_USERNAME` + `CHEMOTION_PASSWORD` | JWT from the token route, form login as fallback | no | 2 weeks (JWT), re-minted on 401 |
| API token | `CHEMOTION_API_TOKEN` | `chemtoken_…` bearer | yes | 1–600 days, set at creation |
| Cookie | `CHEMOTION_SESSION_COOKIE` | copied `_chemotion_session` | yes | silent |

## JWT login (per source, all versions ≥ v1.10)

```
POST /api/v1/authentication/token      ← v4.0.0+ (PR #3143)
POST /api/v1/public/token              ← v1.10 – v3.x, still present in v4
Content-Type: application/json

{"username": "<email or name_abbreviation>", "password": "<password>"}

→ 201 {"token": "<jwt>"}   |   401 {"error": "401 Unauthorized"}
```

`Usecases::Authentication::BuildToken` matches `username` against the
name abbreviation or the email and signs `{user_id, first_name,
last_name}` with a two-week expiry. Send it on every call as
`Authorization: Bearer <jwt>`. These routes are public (no CSRF, no
cookie). The client tries the v4 route, then the legacy one, and only
falls back to the form flow below when both are missing (404/405).

## API tokens (per source, v4.0.0+)

Created in the UI (Profile → API tokens) or with
`POST /api/v1/users/auth_token {otp_attempt, expires_in_days, name}`.
Creation requires two-factor authentication on the account: without
2FA the route answers `401 "2FA is needed"`. Only the SHA-256 digest is
stored; the plaintext `chemtoken_<64 hex>` is shown once. Revoke with
`POST /api/v1/users/revoke_auth_token {id, otp_attempt}`.

## Legacy fallback: Devise form login (verified, pre-v4)

Only used when the instance has no token route. Kept because it was
the first path we reverse-engineered and still works.


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

## Session verification (every mode)

`GET /api/v1/users/current` is the canonical "am I logged in" probe.
- 200 → session live
- 401 → session dead (or cookie rejected at adoption time)
- 302 to `/users/sign_in` on a bare GET `/` from some instances —
  our client treats any redirect-target-matches-sign_in as 401.

## Reference

Implementation: `src/client/auth.ts`.
Form flow probed against a live pre-v4 deployment on 2026-04-24.
Token routes read from `ComPlat/chemotion_ELN` at v1.10.0, v3.1.3,
and v4.0.0 (2026-10).
