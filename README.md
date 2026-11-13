# AIxodia Dashboard

A React/Vite + TypeScript single-page app for the AIxodia console, published as
static files from `dist/` with Pages Functions alongside.

Two server-side pieces live here, and both are part of this product rather than a
separate service:

| Path | What it is |
|---|---|
| `functions/engine/[[path]].js` | Pages Function proxying `/engine/*` to the service that owns the path |
| `workers/auth/` | The sign-in Worker: issues and confirms session tokens |

The proxy exists because Cloudflare Access sets its session cookie per host. A
browser that signed in at one hostname has no credential at another, so the SPA
reaches both the engine and the sign-in Worker through its own origin.

The sign-in Worker is separate from the engine on purpose. The engine is an agent
that also exposes device-control routes; when it was the sign-in authority its
uptime was a login requirement, so stopping it to upgrade logged everyone out.
Sign-in now answers whether or not the engine is running.

`workers/auth/` deploys separately from the site:

```bash
npx wrangler deploy --config workers/auth/wrangler.toml
```

Publishing `dist/` is a separate step from deploying the Worker; a successful
`npm run build` updates neither.

## Architecture

```text
Browser / Dashboard
  1. Opens GitHub in the browser (Authorization Code + PKCE, S256)
  2. GitHub redirects to https://dashboard.aixodia.dpdns.org
  3. Dashboard validates OAuth state and sends the one-time code +
     PKCE verifier to POST /v1/auth/github/exchange
  4. Engine exchanges the code with GitHub using its server-side
     OAuth client secret, checks the account allowlist, and issues
     an Engine access token + refresh credential
  5. Dashboard sends Authorization: Bearer <Engine access token>
     and silently refreshes with POST /v1/auth/refresh
                         |
                         v
AIxodia Engine — https://aixodia.dpdns.org
  Cloudflare Named Tunnel → 127.0.0.1:8787
```

The browser does not receive the GitHub client secret, a GitHub OAuth access token, or `CF_TOKEN`. It stores only Engine-issued session credentials in `sessionStorage` (per-tab). The OAuth PKCE verifier and state are short-lived and kept in the pending browser session while authorization is in progress.

The old `worker/` directory was removed and its job is now split by path. Workers KV,
D1 and the Named Tunnel remain in the backend architecture. The Engine owns the
device/MCP gateway routes; the device list is read from Workers KV `DEVICE_TUNNELS`.
Sign-in is served by `workers/auth/`, and `functions/engine/[[path]].js` sends each
path to whichever of the two owns it.

## GitHub sign-in

The only Dashboard sign-in method is GitHub Authorization Code + PKCE (S256). There is no PAT paste form and no Device Flow code prompt.

1. The user selects **Continue with GitHub**. The Dashboard creates a high-entropy PKCE verifier and random `state`, derives an S256 challenge, and opens GitHub's authorization page.
2. GitHub redirects to the registered Dashboard callback with a one-time authorization code and state.
3. The Dashboard checks the returned state against the pending session, then calls Engine `POST /v1/auth/github/exchange` with the code, PKCE verifier, redirect URI and public client ID.
4. The Engine exchanges the authorization code with GitHub. The GitHub OAuth client secret exists only in Engine environment/KV; it must never be placed in `VITE_*` variables, source code, or the browser bundle.
5. The Engine validates the GitHub user against `ALLOWED_GITHUB_USERS` and returns its own access and refresh credentials. Those credentials are used for all subsequent Engine requests.

The GitHub OAuth App callback URL must be exactly:

```text
https://dashboard.aixodia.dpdns.org
```

Android uses the same HTTPS callback: the Dashboard recognizes the Android-specific state prefix and forwards the temporary code/state to the app's `aixodia://oauth/callback` deep link. Android retains the PKCE verifier in encrypted app storage and exchanges the code through the Engine.

## Engine session lifetime

The Engine access token defaults to 15 minutes. The client refreshes it silently 2 minutes before expiry through `POST /v1/auth/refresh`. The stateless Engine refresh credential lasts 365 days by default and survives Engine restarts. A temporary network failure does not discard the stored refresh credential. A rejected or expired refresh credential requires a new GitHub sign-in. Logout clears the local access and refresh credentials.

The legacy `POST /v1/auth/token` route remains in the Engine for older/administrative clients, but the Dashboard login UI does not use a PAT or master token.

## Configuration

| Where | Variable / setting | Meaning |
| --- | --- | --- |
| Dashboard build | `VITE_ENGINE_URL` | Engine base URL. Default: `https://aixodia.dpdns.org`. |
| Dashboard build | `VITE_GITHUB_CLIENT_ID` | Optional override for the public GitHub OAuth App client ID. The production App ID is the built-in default. This is public and is not a secret. |
| GitHub OAuth App | Callback URL | Set to `https://dashboard.aixodia.dpdns.org`. |
| Engine environment | `GITHUB_CLIENT_ID` | Optional override for the public OAuth client ID; default matches the Dashboard/Android build. |
| Engine environment | `GITHUB_CLIENT_SECRET` | Required server-side OAuth client secret. Never expose it to the browser or APK. |
| Engine Workers KV | `AIXODIA_CONFIG/client/github_client_secret` | Alternative server-side location for the OAuth client secret when the environment variable is not set. |
| Engine environment / KV | `GITHUB_REDIRECT_URI` | Optional exact redirect URI override; default is `https://dashboard.aixodia.dpdns.org`. Must match the GitHub OAuth App callback and client request. |
| Engine environment / KV | `ALLOWED_GITHUB_USERS` / `client/allowed_users` | Comma-separated GitHub logins allowed to sign in. |
| Engine environment / KV | `ALLOWED_ORIGINS` / `client/allowed_origins` | CORS allowlist. Include `https://dashboard.aixodia.dpdns.org` and local development origin when needed. |

The client secret is sensitive. Configure it only on the Engine (environment or Workers KV) and never commit or print its value. Engine CORS is enforced by the Engine itself.

## Devices

The Dashboard calls `GET /v1/devices`, `GET /v1/devices/{id}/tools`, and `POST /v1/devices/{id}/action` directly with an automatically renewed Engine access token. When the device registry is empty, the Engine returns `{ devices: [], note }` with HTTP 200; the Dashboard displays the note instead of treating the empty registry as an error. When devices are registered, the UI shows online status, available tools and action results, including screenshots.

## Local development

```sh
npm ci
# The Engine CORS allowlist must include http://localhost:5173.
VITE_ENGINE_URL=http://127.0.0.1:8787 npm run dev
```

Alternatively, set `VITE_ENGINE_URL=/engine`; the Vite dev proxy forwards `/engine/*` to `http://127.0.0.1:8787` and strips the prefix. When `VITE_ENGINE_URL` is unset, the app targets the production Named Tunnel.

The production OAuth redirect is fixed to the registered HTTPS callback. Local OAuth sign-in therefore requires a separately registered GitHub OAuth callback and matching Engine `GITHUB_REDIRECT_URI`; local API development does not by itself configure that callback.

## Build, test and publish

```sh
npm ci
npm test       # Node tests for session refresh, device endpoints and PKCE helpers
npm run build  # tsc --noEmit && vite build; static output is in dist/
```

`npm run build` only type-checks and builds the static bundle; it deploys nothing.
Two separate deployment steps exist: publishing `dist/` to Cloudflare Pages, and
`npx wrangler deploy --config workers/auth/wrangler.toml` for the sign-in Worker.
Neither is implied by a successful build.

This repository currently has no active GitHub Actions workflow. The previous build-only workflow example is retained at `docs/deploy-build-only.yml.example`; enabling a GitHub Actions workflow requires the appropriate `workflow` permission and an explicit deployment configuration.
