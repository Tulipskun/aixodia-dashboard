# Design System — AIxodia Login

## Direction

Follow the user-selected Canva reference "AIXODIA Responsive Login Website": a precise, midnight-indigo interface with a centered AIxodia identity, a minimal desktop two-column composition with an orbital illustration, and a compact single-column adaptation on tablet and mobile. The login page is an Operate/entry surface: clarity and task completion take priority over decorative complexity.

The sign-in panel offers **two working methods**: a **GitHub PAT form** (label + password field + short note + one primary button, the default) and, when `VITE_GITHUB_CLIENT_ID` is set, a **GitHub Device Flow** method shown behind a second tab (a prominent one-time `user_code`, a `verification_uri` link, a waiting indicator, and a cancel action). The visual language is unchanged; only the control inside the sign-in panel changes.

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
- The device `user_code` uses a monospace face with wide letter-spacing so it is easy to read and copy.

## Composition

- Desktop: a restrained orbital network illustration on the left; a focused sign-in panel on the right containing the method tabs and the active form/panel.
- Tablet/mobile: compact brand mark and sign-in panel in a single centered column; reduce the orbital illustration to preserve room for the sign-in action.
- Method tabs sit directly under the "Sign in" heading; the active tab is marked with a violet underline.
- Keep the primary action prominent and full-width; the token input stays full-width and at least 48px tall. The device code is centered in a dashed, high-contrast box.

## Interaction

- Both methods end at the engine-issued short-lived token (`POST /v1/auth/token` → `sessionStorage`). PAT paste and the device-flow `access_token` are exchanged identically; only the opaque short-lived token is kept.
- Device Flow: show `user_code` + `verification_uri`, poll GitHub until authorization is granted (lengthening the interval on `slow_down`), surface `expired_token` / `access_denied` as readable errors, and allow cancellation.
- Purple hover/pressed/focus treatments only; never a blue pressed state.
- Visible keyboard focus, minimum 44px touch targets, reduced-motion support.
- No page zoom or scrolling, as explicitly required for this login surface.
