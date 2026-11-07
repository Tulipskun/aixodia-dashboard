# AIxodia Dashboard

React/Vite frontend and Cloudflare Worker backend for the AIxodia device console.

## Authentication

GitHub OAuth is restricted by `ALLOWED_GITHUB_USERS` (defaults to `Tulipskun`). The Worker stores only SHA-256 hashes of random session tokens in D1. The browser receives an `HttpOnly; Secure; SameSite=Lax` host-only cookie. Sessions expire after 30 days and slide forward to 30 days when used; renewal is throttled to at most once per day per device. Logout deletes the server-side session.

## Cloudflare setup

1. The existing Cloudflare D1 database `aixodia` is reused; its database ID is configured in `wrangler.toml`. The session migration adds a `sessions` table without replacing existing tables.
2. Create a GitHub OAuth App. Set its callback URL to `https://dashboard.aixodia.dpdns.org/api/auth/github/callback`.
3. Add these GitHub repository Actions secrets (never commit them): `CLOUDFLARE_API_TOKEN`. The Cloudflare token needs Workers Scripts edit, D1 edit, and route edit access for the configured zone. To enable GitHub login, add repository Actions secrets `DASHBOARD_GITHUB_CLIENT_ID` and `DASHBOARD_GITHUB_CLIENT_SECRET`; the workflow copies them into Worker secrets during deployment. The GitHub OAuth App callback must be `https://dashboard.aixodia.dpdns.org/api/auth/github/callback`. For a manual deploy, use:

   ```sh
   printf '%s' "$GITHUB_CLIENT_ID" | npx wrangler secret put GITHUB_CLIENT_ID
   printf '%s' "$GITHUB_CLIENT_SECRET" | npx wrangler secret put GITHUB_CLIENT_SECRET
   ```

4. Apply the schema and deploy:

   ```sh
   npx wrangler d1 migrations apply aixodia-dashboard --remote
   npm run deploy
   ```

The Worker serves the built SPA and `/api/*` from the same origin, so the session cookie works across reloads and devices without browser storage. Ensure `dashboard.aixodia.dpdns.org` has a proxied DNS record in the `aixodia.dpdns.org` zone.

## Local preview through Quick Tunnel

```sh
cp .dev.vars.example .dev.vars
# Set APP_ORIGIN to the current Quick Tunnel URL and enter OAuth credentials.
npm install
npm run db:migrate:local
npm run dev:worker
npm run dev
```

The Vite server proxies `/api/*` to the local Worker. Point the Quick Tunnel at port 5173. For GitHub OAuth, the GitHub OAuth App callback URL must exactly match the current Quick Tunnel URL plus `/api/auth/github/callback`; a Quick Tunnel URL changes after restart.

## Current integration boundary

The authentication/session API is implemented. Device endpoints deliberately return `MCP_NOT_CONFIGURED` until the dashboard is connected to the intended MCP device gateway and device identifiers. No fake device state or tool catalogue is returned.
