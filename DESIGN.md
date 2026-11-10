# Design System — AIxodia Login

## Direction

Follow the user-selected Canva reference "AIXODIA Responsive Login Website": a precise, midnight-indigo interface with a centered AIxodia identity, a minimal desktop two-column composition with an orbital illustration, and a compact single-column adaptation on tablet and mobile. The login page is an Operate/entry surface: clarity and task completion take priority over decorative complexity.

The sign-in action is a **GitHub PAT form** (a labeled password field, a short explanatory note, and one primary button), not a GitHub OAuth redirect. The visual language is unchanged; only the control inside the sign-in panel changes.

## Color

- Canvas: near-black navy (`#050817`)
- Surfaces: deep indigo (`#0b1230`, `#101a3d`)
- Primary accent: luminous AIxodia violet (`#7547f5`)
- Secondary accent: electric cyan (`#27c7f5`)
- Text: cool white (`#f4f6ff`), secondary blue-gray (`#a5b2d3`)
- Borders: restrained blue-violet at low opacity

## Typography

- Display and Latin UI: Saira
- Body copy: 14–16px with generous line height; English-only interface
- Keep all interface copy in English. Keep headings short and high contrast; avoid gradient text.

## Composition

- Desktop: a restrained orbital network illustration on the left; a focused sign-in panel on the right containing the PAT form.
- Tablet/mobile: compact brand mark and sign-in panel in a single centered column; reduce the orbital illustration to preserve room for the sign-in action.
- Keep the primary action prominent and full-width; the token input stays full-width and at least 48px tall.

## Interaction

- Sign-in uses the engine-issued short-lived token flow (PAT paste → `POST /v1/auth/token` → `sessionStorage` token). No OAuth redirect, no Cloudflare-backed session cookie — the change is a working assumption pending operator approval and may move to OAuth PKCE later; keep the UI copy generic enough to survive that swap.
- Purple hover/pressed/focus treatments only; never a blue pressed state.
- Visible keyboard focus, minimum 44px touch targets, reduced-motion support.
- No page zoom or scrolling, as explicitly required for this login surface.
