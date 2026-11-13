# AIxodia Auth Worker

Issues and confirms sign-in tokens for AIxodia, independently of the engine.

## Why this is separate from the engine

The engine is an AI agent that also happens to expose device-control routes. It is
a workload, not the authority on who may use the console — but sign-in was built
inside it anyway, so its uptime became a login requirement. Stopping the engine
to upgrade it logged everyone out, and an engine crash meant nobody could get in
to see why.

This Worker holds the parts that must outlive any workload:

* the allowlist
* the pending/active session state
* the signing key

The engine no longer decides who is allowed in. It is handed a token and verifies
it, and if it is down the console still signs people in and simply reports the
engine as unreachable.

## Endpoints

| Method | Path | Who may call |
|---|---|---|
| `POST` | `/v1/auth/request` | anyone; the allowlist decides |
| `GET`  | `/v1/auth/confirm` | behind Cloudflare Access |
| `POST` | `/v1/auth/confirm` | behind Cloudflare Access |
| `GET`  | `/v1/auth/status`  | the holder of the token |
| `GET`  | `/v1/auth/whoami`  | behind Cloudflare Access |
| `POST` | `/v1/auth/verify`  | the engine, with the master token |

`/v1/auth/verify` is what the engine calls: it asks whether a token the app
presented is valid, rather than trusting a signature it cannot check without the
same key.

## Storage

`AIXODIA_CONFIG` (KV) holds configuration (`auth/allowed_emails`,
`access/team_domain`, `access/app_aud`). Sessions live in a separate namespace so
that a config write cannot collide with a live session, and so sessions can be
given a TTL.

## Why tokens are opaque here

A signed JWT would let the engine verify offline, but it would also let anyone who
saw the signing key mint tokens forever, and rotation would mean invalidating every
session at once. An opaque token that both sides look up in KV means a revoked
session is revoked everywhere immediately, and the key never has to leave this
Worker.
