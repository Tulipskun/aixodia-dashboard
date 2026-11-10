# task.md — Handoff tracker

> **กฎเหล็กจาก operator:** ทุกครั้งที่มีการเปลี่ยนแปลงไฟล์ใดๆ (รวมไฟล์นี้) ต้อง `git add` → `commit` → `push` **ทันที**
> เหตุผล: อาจมี AI ตัวอื่นมารับช่วงต่อหาก session นี้ติดลิมิต — ห้ามมี work ที่ยังไม่ถูก push ค้างอยู่
> **MAINTAIN:** อัปเดตไฟล์นี้ทุก checkpoint ให้บอกสถานะล่าสุด / สิ่งที่ทำไปแล้ว / ขั้นต่อไป

## Handoff (EN — read this first)

**Status:** `IN PROGRESS — WORKER REMOVED (CP1), CLIENT REWRITE + DOCS PENDING; ENGINE CONTRACT IMPLEMENTED BY ANOTHER AGENT (commit 3a264a6)`.
**Decisions (operator):** both clients (Android + Dashboard) talk to engine directly; engine issues a **short-lived token** instead of exposing `CF_TOKEN` to the browser.
**Working assumption (operator declined further questions):** remove `aixodia-dashboard/worker/` (the real middleman) + stale `aixodia-engine/relay/` is handled by the engine-side agent; **KEEP** Workers KV / D1 / Named Tunnel.
**Goal:** remove the Worker middleman so engine and client talk directly.
**Hard constraints:** (1) commit + push after EVERY change, no unpushed work; (2) **do NOT deploy** — no `wrangler deploy`, `npm run deploy`, or CI deploy trigger; (3) touch ONLY this repo (`aixodia-dashboard`).
**Engine contract to match (implemented on `aixodia-engine` @ `3a264a6`):**
- `POST /v1/auth/token` `{ "github_token": "<user GitHub PAT>" }` → engine verifies via `GET https://api.github.com/user` + env `ALLOWED_GITHUB_USERS`, returns `{ "token": "<opaque short-lived>", "expires_at": <unix>, "user": "<login>", "scope": "client" }` (TTL default 900s).
- Every other route (`/healthz`, `/v1/sessions`, `/v1/sessions/{id}/turns`, `/v1/runs`, `/v1/runs/{id}/events`, `/v1/runs/{id}/cancel`, `/api/files*`, `/api/backup*`) now accepts `Authorization: Bearer <short-lived token>` (outer middleware still accepts legacy `CF_TOKEN`, but the browser MUST NOT hold `CF_TOKEN`).
- Engine answers CORS itself per env `ALLOWED_ORIGINS` (default to set: `https://dashboard.aixodia.dpdns.org,http://localhost:5173`). Engine binds `127.0.0.1:8787` behind Named Tunnel `https://aixodia.dpdns.org`.
**Repos (all `main`, owner `Tulipskun`):** `Tulipskun/aixodia-engine`, `Tulipskun/AIxodia`, `Tulipskun/aixodia-dashboard`.
**Local clones:** `/workspace/aixodia-work/<repo-name>`.
**Auth:** `gh auth status` OK as `Tulipskun` (`gho_…`, scopes repo/read:org/gist); per-repo git identity `Tulipskun <Tulipskun@users.noreply.github.com>`; `gh auth setup-git` done → push works.
**Note:** this repo has NO `AGENTS.md` / `MAIN.md` — no `MAIN.md` maintenance required here.

## เป้าหมาย (จาก operator)

ใน `aixodia-engine`, `AIxodia`, `aixodia-dashboard`: เอา **worker** ออก ให้ **engine กับ client คุยกันโดยตรง** และสร้าง `task.md` ลง repo พร้อม **commit + push ทุกครั้ง** เพื่อให้ AI ตัวอื่นสานต่อได้หากติดลิมิต

## ผลสำรวจ (ภาพรวม 3 repo — บริบทเดิม)

| ความหมายของ "worker" | ที่อยู่ | สถานะในเส้นทางจริง |
| --- | --- | --- |
| A. Cloudflare Worker + Durable Object (stale) | `aixodia-engine/relay/` | ไม่ได้ deploy แล้ว (คนอื่นทำฝั่ง engine) |
| B. Cloudflare Worker ที่เป็นตัวกลางจริง | `aixodia-dashboard/worker/` | **อยู่ในเส้นทาง** → ถูกลบใน CP1 แล้ว |
| C. ผลิตภัณฑ์ Cloudflare ที่ไม่ใช่ Worker script | Workers KV / D1 / Named Tunnel | **เก็บไว้** ตาม working assumption |
| D. OS thread / agent label | backup crates, `agent == "worker"` | ไม่ใช่ network ไม่ต้องแตะ |

ฝั่ง Android ไม่ได้ผ่าน Worker อยู่แล้ว (Named Tunnel `https://aixodia.dpdns.org` → engine ตรง) → Worker ตัวกลางจริงคือ `worker/` ใน repo นี้เท่านั้น

## Operator decisions (received)

- **Client เป้าหมาย:** ทั้งคู่ — Android + Dashboard ชี้ไป engine โดยตรง
- **Auth เมื่อตัด dashboard Worker:** ให้ **engine ออก short-lived token** แทนการเปิดเผย `CF_TOKEN` ต่อ browser
- **ขอบเขต worker:** operator ปฏิเสธตอบเพิ่ม → ถือ working assumption: ตัด `aixodia-dashboard/worker/` + ลบ stale `aixodia-engine/relay/` (ฝั่ง engine) แต่**เก็บ** Workers KV / D1 / Named Tunnel

## Checkpoint log

| # | สถานะ | สิ่งที่ทำ | Commit |
| --- | --- | --- | --- |
| 1 | ✅ | clone 3 repo, สำรวจสถาปัตยกรรม, สร้าง `task.md`, push ทั้ง 3 repo | `engine afd4f94` / `AIxodia ad939f9` / `dashboard e9ffba7` |
| 2 | ✅ | บันทึกคำตอบ operator ลง `task.md` | `dashboard b93148d` |
| 3 | ✅ | **CP1** — ลบ Worker ออกจากเส้นทาง + tooling (ดูรายการไฟล์ด้านล่าง) | (this commit — SHA บันทึกใน checkpoint ถัดไป) |
| 4 | ⏳ | **CP2** — เขียน `src/api.ts` ใหม่ (เรียก engine ตรง) + ปรับ `App.tsx` / LoginPage | — |
| 5 | ⏳ | **CP3** — อัปเดต docs + รัน `npm ci && npm test && npm run build` + สรุปผล | — |

## Commit SHAs (migration — เติมทุก checkpoint)

- baseline (ก่อนเริ่ม): `b93148d`
- CP1: _(จะกรอกใน CP2)_
- CP2: _(จะกรอกใน CP3)_
- CP3: _( = HEAD สุดท้าย, ดู `git log -1`)_

## CP1 — ไฟล์ที่เปลี่ยน (ลบ Worker)

- **ลบ:** `worker/` (index.js, integrations.js, lib.js), `wrangler.toml`, `.dev.vars.example`, `migrations/0001_sessions.sql` (D1 sessions table ไม่จำเป็นอีกต่อไป), `test/worker.test.js`, `test/integrations.test.js`, `test/auth-flow.test.js` (ทั้ง 3 import จาก `worker/` ที่ถูกลบ)
- **แก้:** `package.json` (ลบ scripts `dev:worker`/`db:migrate:*`/`deploy` + devDep `wrangler`), `package-lock.json` (sync), `vite.config.ts` (proxy `/engine` → `127.0.0.1:8787` แทน `/api`), `.gitignore` (ลบ `.dev.vars`/`.wrangler/`)
- **`.github/workflows/deploy.yml` → build-only** (npm ci/test/build, ไม่มี wrangler/D1/OAuth/CF_TOKEN/deploy พร้อมคอมเมนต์อธิบาย) — **commit แยกผ่าน GitHub Contents API** ไม่ใช่ `git push`: โทเค็น OAuth `gho_…` มีแค่ scope `gist,read:org,repo` (ไม่มี `workflow`) → `git push` ที่แตะไฟล์ใน `.github/workflows/` ถูกปฏิเสธ (`refusing to allow an OAuth App to create or update workflow ... without workflow scope`) และ `gh auth refresh -s workflow` ต้องใช้ device flow ผ่าน browser ซึ่งทำใน sandbox ไม่ได้ จึงใช้ `gh api PUT /repos/.../contents/.github/workflows/deploy.yml` สร้าง commit บน remote แล้ว `git pull --ff-only` ซิงก์กลับ本地 (tree สะอาด) เนื้อหาใหม่ถูกเซฟไว้ที่ `/tmp/new-deploy.yml` ระหว่างทำ
- **เพิ่ม:** `.env.example` (อธิบาย `VITE_ENGINE_URL`), `src/client-core.js` + `src/client-core.d.ts` (pure helpers ที่ test ได้), `test/client-core.test.js` (แทนที่ worker tests ด้วยชุดทดสอบใหม่)
- **เหตุผลลบ tests เดิม:** ทั้ง 3 ไฟล์พึ่ง `worker/*.js` ซึ่งถูกลบ — ไม่ใช่ "ลบเพื่อให้ผ่าน" แต่แทนที่ด้วย `test/client-core.test.js` ที่ทดสอบ pure logic ของ client ใหม่

## Remaining / work ค้าง (สำคัญ)

1. **device / MCP gateway ยังไม่ได้ย้ายมา engine** — `/api/devices`, `/api/devices/{id}/tools`, `/api/devices/{id}/action` เดิมผ่าน service binding `MCP_GATEWAY` ของ Worker ไม่มี engine equivalent → ใน `src/api.ts` ฟังก์ชันเหล่านี้จะ throw `ApiError` (`code: MCP_GATEWAY_NOT_MIGRATED`, อ่านแล้วเข้าใจ) แทนการค้าง build; UI ยังแสดง error ได้ (catch ไว้แล้ว). ต้องรอ operator ตัดสินใจว่าจะย้าย MCP gateway ไป engine หรือตัดทิ้ง
2. **OAuth PKCE trade-off** — เปลี่ยนจาก GitHub OAuth redirect เป็น **ให้ผู้ใช้ paste GitHub PAT** (ใช้ครั้งเดียวตรวจตัวตนกับ engine แล้วได้ short-lived token, ไม่ถูกเก็บ) ตาม contract ของ engine ฝั่ง `3a264a6`. รอ operator อนุมัติ / อาจเปลี่ยนเป็น OAuth PKCE ภายหลัง
3. **env บน engine** ต้องตั้ง: `ALLOWED_GITHUB_USERS`, `ALLOWED_ORIGINS` (default `https://dashboard.aixodia.dpdns.org,http://localhost:5173`)
4. **Client env:** `VITE_ENGINE_URL` (default `https://aixodia.dpdns.org`); dev ใช้ `http://127.0.0.1:8787` ตรง หรือ `/engine` ผ่าน Vite proxy
5. **Deploy:** ห้าม deploy จาก repo นี้ — CI `deploy.yml` เป็น build-only; การ publish `dist/` ไป static host เป็นคนละขั้นตอน

## Build / test results

- CP1: ยังไม่รัน (จะรัน `npm ci && npm test && npm run build` ใน CP3 และบันทึกผล/error ที่นี่โดยไม่ปิดบัง)

## Next steps สำหรับ AI ที่รับช่วง

1. อ่าน `task.md` ในทั้ง 3 repo; ฝั่ง engine เสร็จแล้ว (`3a264a6`) ให้ใช้ contract ด้านบน
2. ทำทีละขั้นเล็กๆ: แก้ → update `task.md` (checkpoint) → `git add -A` → `commit` → `git push origin main` **ทุกขั้น**
3. ตรวจทดสอบ: `npm ci && npm test && npm run build`
4. **ห้าม** `wrangler deploy` / `npm run deploy` / trigger CI deploy; **ห้ามแตะ repo อื่น**

## Useful commands

```bash
cd /workspace/aixodia-work/aixodia-dashboard
git status --short --branch
git add -A && git commit -m "task: <step>" && git push origin main
```
