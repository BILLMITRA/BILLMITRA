# Waiter login JSON response fix

## Investigation

The native sign-in form is `apps/waiter-mobile/App.tsx`. It calls `login()` in `src/api.ts`, posting `{input: {branchId, username, password}}` to the restaurant origin plus `/api/mobile/login`. It does not use an Expo build URL or a Vite development URL. The form and API client validate that the supplied address is an HTTPS origin without a path, query, or embedded credentials.

The confirmed pilot address is `https://extra-gave-keys-henderson.trycloudflare.com`, branch `main`. Its tunnel forwards to the pilot Node server on `127.0.0.1:3017`. The expected public Host is checked against `BILLMITRA_WEB_ORIGIN`. Branch configuration comes from `BILLMITRA_BRANCHES` or `branches.json`; SQLite lives under `BILLMITRA_WEB_DATA_DIR`. A phone must not use `localhost` for the restaurant server.

Live checks during this investigation found:

- Empty public and loopback login requests: HTTP 403, `application/json; charset=utf-8`, JSON branch-selection error.
- The user-supplied waiter account: HTTP 200, JSON session envelope, authorized waiter role, branch `main` / Vengara. The test token was redacted and its session immediately signed out. This confirms routing, account authentication, and database access were working at test time.

The original failing HTTP response is unavailable. The exact upstream body cannot be established retroactively. The confirmed client defect was an unconditional `response.json()` before checking status, content type, or envelope shape. Any gateway/plain-text response starting with `e` produces the reported parse failure. A controlled `error code: 1033` response reproduces that failure condition; this is a regression fixture, not proof of that exact historical gateway code. Temporary tunnel/proxy errors remain a plausible source of the non-JSON response. A healthy response now does not rule out an earlier outage.

After deploying the fix to the pilot, the updated native API client was also exercised against that public address: readiness HTTP 200, synthetic nonexistent-account login HTTP 401, supplied waiter login HTTP 200, menu HTTP 200 with 12 tables / 125 available items, and logout HTTP 200. All replies were JSON and contained `ok`, `result`, and `error`. Logs recorded only endpoint paths, statuses, content types, envelope presence and non-secret counts; the credentials and session token were not printed. A consistent SQLite snapshot was taken before the server restart.

## Changes

- The client sends `Accept: application/json`, reads the response body once, verifies JSON media type, parses JSON with explicit protocol-error handling, checks the result envelope, and validates the login session and branch before storing it. It still parses and requires valid JSON; invalid responses cannot produce a successful login.
- HTTP errors, malformed/HTML/plain-text responses, unreachable networks and a 20-second timeout have distinct actionable messages. Raw response bodies and transport exception details are never logged or echoed. A recognized numeric gateway code can be included safely. Server failures cannot be mistaken for wrong passwords.
- Expired authenticated sessions return to the existing sign-in UI while retaining drafts and pending orders. Non-JSON proxy failures cannot clear a durable print request as if the backend had definitively rejected it.
- Backend API replies consistently include `{ok, result, error}` and JSON content type. Existing `{result}` / `{error}` consumers remain compatible. `/api/branches` retains its existing flat `branches` field for older browser clients.
- Login validation is HTTP 400, invalid credentials 401, denied waiter access 403, locked accounts 429, and unexpected/database failures 500. Raw internal exception messages are not exposed. A final response boundary handles uncaught asynchronous route failures with JSON rather than a dropped request/unhandled rejection.
- `GET /api/health` returns service readiness as JSON. It checks all configured branch databases without returning accounts, credentials, file paths or tokens. Database failures return HTTP 503. This probe does not repair or restart an unavailable database.

## Diagnosis without secrets

Check the configured origin, then call `GET https://YOUR-RESTAURANT/api/health`. Healthy output has `ok: true`, `result.service: "billmitra"`, and `result.ready: true`. A non-JSON answer means the request did not reach the expected JSON route or an upstream replaced the response. Check the tunnel process, its target port, Host/origin configuration, and the restaurant server process. A 503 JSON health response points to branch database availability. A 401 JSON login response indicates rejected credentials; do not log the request body to investigate it.

A temporary `trycloudflare.com` address is not permanent hosting. If its tunnel stops or is replaced, restore the tunnel or update the restaurant address everywhere it is used. The backend cannot turn an error generated by an external proxy into JSON after the proxy replaces the response; the native client must handle that response honestly.

## Verification and rollout

Run `npm test`, `npm run build`, and `npm run lint` at the root. In `apps/waiter-mobile`, run `npm test` and `npm run typecheck`, then Expo exports for Android and iOS. Regression cases cover successful login, invalid credentials, branch mismatch, malformed requests, missing routes, backend/database failures, HTML/plain text/invalid JSON, response-stream interruption, unavailable networks and timeouts. An end-to-end test uses the actual native API client against the real SQLite-backed HTTP server.

Deploy the updated backend and install waiter app **1.0.3**, Android version code **4**, over the existing app. An already installed 1.0.2 APK does not acquire this bundled JavaScript fix from a server restart. Preserve the existing database and account files; no schema migration or password reset is required.
