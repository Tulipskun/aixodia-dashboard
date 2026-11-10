# AIxodia Dashboard

A static React/Vite + TypeScript single-page app for the AIxodia console. **It talks to the AIxodia Engine directly** — there is no Cloudflare Worker in the request path anymore. The SPA is served as static files (`dist/`) and calls the engine's HTTP API cross-origin with a short-lived bearer token.

## Architecture (after worker removal)

```
browser (this SPA)
   │  sign in:
   │    POST /v1/auth/token  { github_token }        (no auth needed)
   │    ← { token, expires_at, refresh_token, refresh_expires_at, user, scope }
   │  POST /v1/auth/refresh { refresh_token } before access expiry
   │  every other request: Authorization: Bearer <short-lived access token>
   │    /healthz, /v1/sessions*, /v1/runs*,
   │    /v1/devices, /v1/devices/{id}/tools, /v1/devices/{id}/action
   ▼
AIxodia Engine  https://aixodia.dpdns.org   (Named Tunnel → 127.0.0.1:8787)
```

The old `worker/` directory (which proxied `/api/*`, injected `CF_TOKEN`, owned GitHub OAuth + D1 sessions + the MCP device gateway) was removed. Workers KV / D1 / the Named Tunnel remain, but the browser no longer goes through a Worker. The engine now owns the device/MCP gateway routes directly and calls the MCP upstream itself (with timeout/retry); the device list comes from the Workers KV `DEVICE_TUNNELS` namespace.

## Authentication — two working methods

Both methods end with the same Engine-issued access + refresh credentials. The access token lasts 15 minutes by default and is renewed silently 2 minutes before expiry using `POST /v1/auth/refresh`; the refresh credential lasts 365 days and survives Engine restarts. Only those Engine credentials are kept in **`sessionStorage`** (per-tab, cleared on tab close). The GitHub PAT, GitHub OAuth access token, and `CF_TOKEN` are never stored in the browser. Every API request carries `Authorization: Bearer <access token>` (`credentials: 'omit'`, no cookies). A temporary refresh/network failure preserves the session; a rejected/expired refresh credential returns to login. Logout clears both local credentials.

1. **GitHub Personal Access Token (PAT) — default.** The user pastes a PAT into the sign-in form. The SPA sends it once to `POST /v1/auth/token`; the engine calls `GET https://api.github.com/user`, checks the login against its `ALLOWED_GITHUB_USERS` allowlist, and returns `{ token, expires_at, refresh_token, refresh_expires_at, user, scope: "client" }` (default access TTL 900s; refresh TTL 365 days). No OAuth app, client secret, or redirect is needed.
2. **GitHub Device Flow — enabled with `VITE_GITHUB_CLIENT_ID`.** When a GitHub OAuth app client id (with device flow enabled) is configured, the login page shows a second method:
   - `POST https://github.com/login/device/code` with `scope=read:user` → the UI displays the returned `user_code` and `verification_uri`.
   - The SPA polls `POST https://github.com/login/oauth/access_token` until GitHub returns an `access_token`: it keeps polling while GitHub reports the user has not authorized yet, lengthens the interval on `slow_down`, and surfaces `expired_token` / `access_denied` as clear, readable errors. A cancel button aborts the flow.
   - The resulting GitHub OAuth access token is sent to `POST /v1/auth/token` as `github_token` — exactly like a PAT — and exchanged for the same access/refresh credentials. No client secret is used (device flow is public-client safe).

## Configuration

| Where | Variable | Meaning |
| --- | --- | --- |
| Build (this repo) | `VITE_ENGINE_URL` | Engine base URL, baked in at build time. Default `https://aixodia.dpdns.org`. |
| Build (this repo) | `VITE_GITHUB_CLIENT_ID` | Optional. Client id of a GitHub OAuth app with device flow enabled; enables the second sign-in method. No client secret. |
| Engine | `ALLOWED_GITHUB_USERS` | Comma-separated GitHub logins allowed to obtain a token. |
| Engine | `ALLOWED_ORIGINS` | CORS allowlist; must include the dashboard origin, e.g. `https://dashboard.aixodia.dpdns.org,http://localhost:5173`. |

The engine answers CORS itself and binds `127.0.0.1:8787` behind the Named Tunnel `https://aixodia.dpdns.org`. See `.env.example` for a copyable template.

### Devices

`GET /v1/devices`, `GET /v1/devices/{id}/tools`, and `POST /v1/devices/{id}/action` are called with an automatically renewed short-lived access token. When the device registry is empty, the engine returns `{ devices: [], note }` (HTTP 200); the dashboard shows that `note` as a readable message instead of an error, and renders the device list, online status, tools, and action results (including screenshots) when devices are registered.

### Local development

```sh
npm ci
# point at a local engine; the engine must list http://localhost:5173 in ALLOWED_ORIGINS
VITE_ENGINE_URL=http://127.0.0.1:8787 npm run dev
```

Alternatively use the Vite dev proxy: set `VITE_ENGINE_URL=/engine`; `vite.config.ts` forwards `/engine/*` → `http://127.0.0.1:8787` and strips the prefix (so the engine sees `/v1/*`, `/healthz`, …). This keeps requests same-origin during dev. With `VITE_ENGINE_URL` unset, the app targets the production tunnel.

## Build, test, and deploy

```sh
npm ci
npm test          # node --test: client-core, refresh contract, device endpoints and device-flow tests (mock fetch)
npm run build     # tsc --noEmit && vite build -> static output in dist/
```

`npm run build` is type-check + static bundle only. **Do not run `wrangler deploy` / `npm run deploy`** — there is no Worker to deploy. Publishing `dist/` to a static host (e.g. Cloudflare Pages) is a separate, manual step.

**CI note:** this repo has no active GitHub Actions workflow. Activating the build-only workflow under `.github/workflows/*` is handled outside this repo with a credential that has the `workflow` scope; the intended workflow content is preserved at `docs/deploy-build-only.yml.example` for reference. This repo does not modify `.github/workflows/*` and does not deploy.
