# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers and operators accessing an Android device-control console through a browser. This audience is inferred from the existing application copy and device-control interface.

## Product Purpose

Provide an authenticated web entry point to the AIxodia console. Sign-in succeeds when the operator proves their GitHub identity to the **AIxodia Engine** and receives a short-lived session token; the browser then talks to the engine directly (no Cloudflare Worker middleman). Two sign-in methods are available: pasting a GitHub Personal Access Token (default) or the GitHub Device Flow (when configured).

## Capabilities and Constraints

- **Two working sign-in methods:**
  - **PAT paste (default):** a GitHub Personal Access Token is pasted once and used by the engine to verify the account against `ALLOWED_GITHUB_USERS`.
  - **GitHub Device Flow (enabled by `VITE_GITHUB_CLIENT_ID`):** the UI shows a `user_code` + `verification_uri`, polls GitHub until an OAuth access token is granted, and passes it to the engine. `expired_token` / `slow_down` / `access_denied` are surfaced as clear messages; the flow can be cancelled.
  - Both exchange the GitHub credential for the same opaque short-lived token; the browser stores only that token in `sessionStorage`, never the PAT, OAuth access token, or `CF_TOKEN`.
- All engine calls use `Authorization: Bearer <short-lived token>`; a `401` returns the user to sign-in. No OAuth redirect, no OAuth app client secret, no D1 session cookie, no Cloudflare-backed session.
- **Devices are live.** `GET /v1/devices`, `GET /v1/devices/{id}/tools`, and `POST /v1/devices/{id}/action` are called on the engine with the short-lived token; the dashboard shows the device list, online status, tool catalogue, and action results (including screenshots). An empty device registry is a successful `{ devices: [], note }` response shown as a readable message, not an error.
- The SPA is static and cross-origin to the engine; the engine owns CORS (`ALLOWED_ORIGINS`), token issuance, and the device/MCP gateway. Configure `VITE_ENGINE_URL` (and optionally `VITE_GITHUB_CLIENT_ID`) at build time.
- Keep the sign-in surface minimal; show only actionable authentication errors.
- The page must work on desktop, tablet, and mobile web.
- Disable browser zoom and page scrolling as explicitly requested for this surface.
- The sign-in button must not flash blue on press or focus; retain a visible, brand-colored keyboard focus indicator.

## Brand Commitments

- Product name: AIxodia.
- Primary visual reference: Canva design "AIXODIA Responsive Login Website" (DAHaZr3HwVg), with its desktop two-column brand-story and sign-in composition and compact tablet/mobile adaptations.
- Use the existing AIxodia purple/indigo identity, with the orbital-network visual from the reference.
- All user-facing interface copy must be English-only.

## Evidence on Hand

- Existing login + direct-engine client: `src/App.tsx`, `src/components.tsx`, `src/api.ts`, `src/client-core.js`.
- Device-flow tests and device-endpoint tests: `test/client-core.test.js`.
- Primary visual reference: https://www.canva.com/d/gTNwphd5whwCFLp
- No user testimonials, customer logos, or quantified product claims are available; do not invent them.

## Product Principles

- Make secure sign-in the single obvious next action.
- Keep sign-in copy concise and in English; explain that the GitHub credential is used once and not stored, and offer the device-code method as a no-token alternative when configured.
- Avoid implementation metadata, protocol dates, platform labels, welcome copy, and decorative status messages in the interface.
- Keep the experience legible and direct on touch and pointer devices.
