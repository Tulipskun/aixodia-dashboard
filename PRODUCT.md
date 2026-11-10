# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers and operators accessing an Android device-control console through a browser. This audience is inferred from the existing application copy and device-control interface.

## Product Purpose

Provide an authenticated web entry point to the AIxodia console. Sign-in succeeds when the operator proves their GitHub identity to the **AIxodia Engine** and receives a short-lived session token; the browser then talks to the engine directly (no Cloudflare Worker middleman).

## Capabilities and Constraints

- Sign-in is a **GitHub Personal Access Token (PAT)** pasted into a form. The PAT is used once by the engine to verify the account against `ALLOWED_GITHUB_USERS`; the browser receives and stores only an opaque short-lived token (`sessionStorage`), never the PAT or `CF_TOKEN`.
- All engine calls use `Authorization: Bearer <short-lived token>`; a `401` returns the user to sign-in. No OAuth redirect, no OAuth app secrets, no D1 session cookie, no Cloudflare-backed session.
- The SPA is static and cross-origin to the engine; the engine owns CORS (`ALLOWED_ORIGINS`) and token issuance. Configure `VITE_ENGINE_URL` at build time.
- **Trade-off (working assumption, pending operator approval):** PAT paste replaced GitHub OAuth redirect for simplicity. It may later be replaced by **OAuth PKCE** (engine performs the exchange and still issues the short-lived token). Do not treat PAT paste as final.
- **Device / MCP gateway is currently unavailable** (it has not been migrated to the engine); the UI surfaces a clear error rather than fake device state.
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
- Primary visual reference: https://www.canva.com/d/gTNwphd5whwCFLp
- No user testimonials, customer logos, or quantified product claims are available; do not invent them.

## Product Principles

- Make secure sign-in the single obvious next action.
- Keep sign-in copy concise and in English; explain that the PAT is used once and not stored.
- Avoid implementation metadata, protocol dates, platform labels, welcome copy, and decorative status messages in the interface.
- Keep the experience legible and direct on touch and pointer devices.
