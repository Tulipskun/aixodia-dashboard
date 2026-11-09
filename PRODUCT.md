# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers and operators accessing an Android device-control console through a browser. This audience is inferred from the existing application copy and device-control interface.

## Product Purpose

Provide an authenticated web entry point to the AIxodia Device Console for controlling Android devices through DroidIME MCP. The login succeeds when an authorized GitHub account can securely establish a Cloudflare-backed session and continue to the console.

## Capabilities and Constraints

- GitHub OAuth is the only sign-in provider currently implemented.
- The backend owns OAuth and session handling; preserve the existing `/sso/github` flow and Cloudflare session behavior.
- The server health endpoint supplies OAuth readiness; internal platform and protocol metadata are not user-facing content.
- Keep the sign-in surface minimal; show only actionable authentication errors.
- The page must work on desktop, tablet, and mobile web.
- Disable browser zoom and page scrolling as explicitly requested for this surface.
- The GitHub sign-in button must not flash blue on press or focus; retain a visible, brand-colored keyboard focus indicator.

## Brand Commitments

- Product name: AIxodia.
- Primary visual reference: Canva design “AIXODIA Responsive Login Website” (DAHaZr3HwVg), with its desktop two-column brand-story and sign-in composition and compact tablet/mobile adaptations.
- Use the existing AIxodia purple/indigo identity, with the orbital-network visual from the reference.
- All user-facing interface copy must be English-only.

## Evidence on Hand

- Existing login component and OAuth behavior: `src/App.tsx`, `src/components.tsx`, `src/api.ts`, and `worker/index.js`.
- Primary visual reference: https://www.canva.com/d/gTNwphd5whwCFLp
- No user testimonials, customer logos, or quantified product claims are available; do not invent them.

## Product Principles

- Make secure sign-in the single obvious next action.
- Keep sign-in copy concise and in English.
- Avoid implementation metadata, protocol dates, platform labels, welcome copy, and decorative status messages in the interface.
- Keep the experience legible and direct on touch and pointer devices.

