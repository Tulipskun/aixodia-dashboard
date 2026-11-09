# task.md — Handoff tracker

> **กฎเหล็กจาก operator:** ทุกครั้งที่มีการเปลี่ยนแปลงไฟล์ใดๆ (รวมไฟล์นี้) ต้อง `git add` → `commit` → `push` **ทันที**
> เหตุผล: อาจมี AI ตัวอื่นมารับช่วงต่อหาก session นี้ติดลิมิต — ห้ามมี work ที่ยังไม่ถูก push ค้างอยู่
> **MAINTAIN:** อัปเดตไฟล์นี้ทุก checkpoint ให้บอกสถานะล่าสุด / สิ่งที่ทำไปแล้ว / ขั้นต่อไป

## Handoff (EN — read this first)

**Status:** `SURVEY COMPLETE / AWAITING OPERATOR DECISION / NO CODE CHANGED`
**Goal:** Remove the worker middleman so engine and client talk directly.
**Hard constraint:** commit + push after EVERY change; no unpushed local work, ever.
**Repos (all `main`, all public, owner `Tulipskun`):**
`Tulipskun/aixodia-engine`, `Tulipskun/AIxodia`, `Tulipskun/aixodia-dashboard`
**Local clones:** `/workspace/aixodia-work/<repo-name>`
**Auth:** `gh auth status` OK as `Tulipskun` (OAuth `gho_…`, scopes repo/read:org/gist); per-repo git identity set to `Tulipskun <Tulipskun@users.noreply.github.com>`.
**Blocker:** "worker" is ambiguous — see *Decision needed*. Do NOT guess; ask the operator.
**Note:** this repo has NO `AGENTS.md` / `MAIN.md` — no `MAIN.md` maintenance required here.

## เป้าหมาย (จาก operator)

ใน `aixodia-engine`, `AIxodia`, `aixodia-dashboard`: เอา **worker** ออก ให้ **engine กับ client คุยกันโดยตรง** และสร้าง `task.md` ลง repo พร้อม **commit + push ทุกครั้ง** เพื่อให้ AI ตัวอื่นสานต่อได้หากติดลิมิต

## ผลสำรวจ (ภาพรวม 3 repo)

| ความหมายของ "worker" | ที่อยู่ | สถานะในเส้นทางจริง |
| --- | --- | --- |
| A. Cloudflare Worker + Durable Object (stale) | `aixodia-engine/relay/` | ไม่ได้ deploy แล้ว (`rust/MILESTONES.md:34-36`) |
| B. Cloudflare Worker ที่เป็นตัวกลางจริง | **`aixodia-dashboard/worker/`** | **อยู่ในเส้นทาง**: browser → `/api/*` → Worker → engine |
| C. ผลิตภัณฑ์ Cloudflare ที่ไม่ใช่ Worker script | Workers KV `AIXODIA_CONFIG`, D1 `aixodia`, Named Tunnel | พึ่งพาอยู่ทุกเส้นทาง |
| D. OS thread / agent label | backup crates, `agent == "worker"` ใน UI | ไม่ใช่ network ไม่ต้องแตะ |

**ข้อค้นพบที่ขัดสมมติฐาน:** ฝั่ง Android **ไม่ได้ผ่าน Worker อยู่แล้ว** — `AIxodia/README.md:9` (D-011) ใช้ Named Tunnel `https://aixodia.dpdns.org` → engine ตรงๆ ดังนั้น **Worker ที่เป็นตัวกลางจริงคือ `worker/` ใน repo นี้เท่านั้น**

## Repo-specific findings — aixodia-dashboard

- stack: React 18 + Vite + TypeScript SPA (`src/`), Cloudflare Worker backend (`worker/` JS), Wrangler, D1 + KV + service bindings
- entry: `index.html:18-19` → `src/main.tsx` → `src/App.tsx:11-50` (`api.getSession()`, `api.getHealth()`); Worker entry `wrangler.toml:2` → `worker/index.js:182-190` `fetch(request, env)`
- **เส้นทางปัจจุบัน (มี Worker คั่น):**
  browser (`src/api.ts:48-55` เรียก same-origin `/api/*`, `credentials: 'same-origin'`) → `worker/index.js:124-180` routing → `worker/integrations.js:91-110` `proxyEngine` → inject `Authorization: Bearer ${env.CF_TOKEN}` (`:101`) → `fetch https://aixodia.dpdns.org/v1/...` → Named Tunnel → engine `127.0.0.1:8787`
- **หน้าที่ของ Worker (ทั้งหมดต้องมีคนแทนถ้าตัดออก):**
  1. โฮสต์ SPA (`wrangler.toml:19-23`, assets `./dist`, `run_worker_first = ["/api/*","/sso/*"]`)
  2. GitHub OAuth + session cookie `__Host-aixodia_session` + D1 `sessions` (`index.js:18-27,74-123`, `lib.js:2-5,26-28`, `migrations/0001_sessions.sql`)
  3. CSRF `sameOrigin` (`index.js:65-68`) + `authenticate` (`:35-64`)
  4. **ซ่อน `CF_TOKEN` ไม่ให้ browser เห็น** (inject ฝั่ง server)
  5. allowlist `ENGINE_ROUTE_RULES` (`integrations.js:81-89,94`) — ปฏิเสธ `/api/files`
  6. `/api/engine/status` → `GET /healthz` (`integrations.js:41-76`)
  7. device / MCP gateway ผ่าน service binding `MCP_GATEWAY` (`wrangler.toml:15-17`, `integrations.js:113-130,163-187`, `apps.config.json:15`)
- config: `wrangler.toml:25-32` (`APP_ORIGIN`, `ENGINE_URL = "https://aixodia.dpdns.org"`, route `dashboard.aixodia.dpdns.org/*`), `vite.config.ts:8-16` (dev `:5173`, proxy `/api` → `127.0.0.1:8787`), `.dev.vars.example:3`, `.github/workflows/deploy.yml:24-40` (secret `CF_TOKEN`)
- tests: `test/worker.test.js`, `test/integrations.test.js`, `test/auth-flow.test.js`
- **engine ฝั่งตรงข้ามยังไม่มี CORS** (ตรวจแล้วไม่พบ `cors|Access-Control|tower_http|allow_origin`) → browser cross-origin ไป `aixodia.dpdns.org` จะถูกบล็อก ต้องเพิ่มที่ engine

## Decision needed (ห้ามเดา)

| ทางเลือก | ขอบเขต | ผลกระทบ |
| --- | --- | --- |
| 1 | ลบเฉพาะ `aixodia-engine/relay/` | ต่ำมาก — เป็น stale code/docs |
| 2 | ลบ `worker/` ใน repo นี้ แล้วให้ browser ยิง engine ตรง | สูง — ต้องออกแบบใหม่ทั้ง 7 หน้าที่ด้านบน + CORS ที่ engine |
| 3 | ลบทั้งสอง Worker script | รวม 1+2 |
| 4 | ตัด Cloudflare ทั้งระบบ (KV + D1 + Tunnel) | รุนแรงสุด — engine start ไม่ติด, discovery/history/providers หาย |

ยังต้องระบุด้วยว่า **client** หมายถึง Android อย่างเดียว / dashboard อย่างเดียว / ทั้งคู่
และถ้าเลือก 2 ต้องตัดสินใจเรื่อง **auth ใหม่**: จะให้ browser ถือ `CF_TOKEN` (เสี่ยง), ให้ engine ออก short-lived token, หรือย้าย auth ไป service อื่น — `AIxodia/PRODUCT.md:46` ห้ามเพิ่ม token ที่สองโดยไม่ได้รับอนุมัติ

## Checkpoint log

| # | สถานะ | สิ่งที่ทำ | Commit |
| --- | --- | --- | --- |
| 1 | ✅ | clone 3 repo, สำรวจสถาปัตยกรรม, สร้าง `task.md`, push ทั้ง 3 repo | (this commit) |
| 2 | ⏳ | รอคำตอบ operator เรื่องขอบเขต worker/client + กลยุทธ์ auth | — |
| 3 | ⏳ | implement ทีละขั้น + commit/push ทุกขั้น | — |

## Next steps สำหรับ AI ที่รับช่วง

1. อ่าน `task.md` ใน **ทั้ง 3 repo** (เนื้อหาเหมือนกันต่างกันเฉพาะ findings)
2. ถาม operator ให้ชัดเรื่อง *Decision needed* ด้านบน ถ้ายังไม่มีคำตอบ
3. ทำทีละขั้นเล็กๆ: แก้ → update `task.md` (checkpoint) → `git add -A` → `commit` → `git push origin main` **ทุกขั้น**; ใน engine/AIxodia ต้อง update `MAIN.md` พร้อมกันตาม `AGENTS.md`
4. ตรวจทดสอบ: `npm ci && npm test && npm run build` (และ `npm run dev:worker` ถ้ายังมี Worker)
5. อย่า `wrangler deploy` / `npm run deploy` โดยไม่มีคำสั่งชัดเจน

## Useful commands

```bash
cd /workspace/aixodia-work/aixodia-dashboard
git status --short --branch
git add -A && git commit -m "task: <step>" && git push origin main
```
