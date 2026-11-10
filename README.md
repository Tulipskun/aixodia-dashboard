# AIxodia Dashboard

A static React/Vite + TypeScript single-page app for the AIxodia console. **It talks to the AIxodia Engine directly** — there is no Cloudflare Worker in the request path anymore. The SPA is served as static files (`dist/`) and calls the engine's HTTP API cross-origin with a short-lived bearer token.

## Architecture (after worker removal)

```
browser (this SPA)
   │  POST /v1/auth/token  { github_token }        (no auth needed)
   │  ← { token, expires_at, user, scope:"client" }
   │  every other request: Authorization: Bearer <short-lived token>
   ▼
AIxodia Engine  https://aixodia.dpdns.org   (Named Tunnel → 127.0.0.1:8787)
```

The old `worker/` directory (which proxied `/api/*`, injected `CF_TOKEN`, owned GitHub OAuth + D1 sessions + the MCP device gateway) was removed. Workers KV / D1 / the Named Tunnel remain, but the browser no longer goes through a Worker.

## Authentication

- The user pastes a **GitHub Personal Access Token (PAT)** into the sign-in form.
- The SPA sends it **once** to `POST /v1/auth/token`. The engine calls `GET https://api.github.com/user`, checks the login against its `ALLOWED_GITHUB_USERS` allowlist, and returns an **opaque short-lived token** (`scope: "client"`, default TTL 900s) plus `expires_at` and `user`.
- Only that short-lived token is kept in the browser, in **`sessionStorage`** (per-tab, cleared on tab close). The PAT and any long-lived secret (`CF_TOKEN`) are **never** stored in the browser. `sessionStorage` holds the token; `localStorage` is not used for credentials.
- Every subsequent request carries `Authorization: Bearer <token>` (cross-origin; `credentials: 'omit'`, no cookies). A `401` clears the local token and returns to the login form. The login endpoint's own `401` (bad/denied PAT) is shown as a form error instead.
- Logout just clears the token; there is no server-side session to revoke.

### PAT trade-off (pending operator approval)

This replaces the previous GitHub **OAuth redirect** flow. Pros: far simpler, no OAuth app/client secret, no D1 session store, and the browser never holds a long-lived credential. Cons: the user must create/paste a PAT by hand, which is worse UX than a redirect. This is a **working assumption recorded in `task.md`** — the operator may later switch to **OAuth PKCE** (engine would perform the code exchange and still issue the short-lived token).

## Configuration

| Where | Variable | Meaning |
| --- | --- | --- |
| Build (this repo) | `VITE_ENGINE_URL` | Engine base URL, baked in at build time. Default `https://aixodia.dpdns.org`. |
| Engine | `ALLOWED_GITHUB_USERS` | Comma-separated GitHub logins allowed to obtain a token. |
| Engine | `ALLOWED_ORIGINS` | CORS allowlist; must include the dashboard origin, e.g. `https://dashboard.aixodia.dpdns.org,http://localhost:5173`. |

The engine answers CORS itself and binds `127.0.0.1:8787` behind the Named Tunnel `https://aixodia.dpdns.org`. See `.env.example` for a copyable template.

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
npm test          # node --test: test/client-core.test.js (pure client-core helpers)
npm run build     # tsc --noEmit && vite build -> static output in dist/
```

`npm run build` is type-check + static bundle only. **Do not run `wrangler deploy` / `npm run deploy`** — there is no Worker to deploy. Publishing `dist/` to a static host (e.g. Cloudflare Pages) is a separate, manual step.

**CI note:** this repo currently has **no active GitHub Actions workflow**. The intended build-only workflow is preserved at `docs/deploy-build-only.yml.example`: the operator-provided OAuth token lacks the `workflow` scope, so GitHub rejects any create/update of files under `.github/workflows/` (git push, Contents API and Git DB API all refused). The old `wrangler deploy` workflow was therefore deleted (deletion is permitted), which also stops the push-triggered deploy CI. To re-enable build-only CI, copy the reference file to `.github/workflows/deploy.yml` using a credential that has the `workflow` scope. See `task.md` for the full record.

## Known gaps

- **Device / MCP gateway not migrated.** `/api/devices`, `/api/devices/{id}/tools`, `/api/devices/{id}/action` previously used the Worker's `MCP_GATEWAY` service binding and have no engine equivalent yet. `src/api.ts` makes these functions throw a clear `ApiError` (`MCP_GATEWAY_NOT_MIGRATED`); the UI shows the message and the build stays green. Tracked in `task.md` as pending operator decision.
