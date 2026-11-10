# task.md — Handoff tracker

> **กฎเหล็กจาก operator:** ทุก change (รวมไฟล์นี้) ต้อง `git add` → `commit` → `push` ทันที ทุก push ต้องสำเร็จ และทุก change ต้องถูก push ครบถ้วน
> **MAINTAIN:** อัปเดตไฟล์นี้ทุก checkpoint ให้บอกสถานะล่าสุด / สิ่งที่ทำไปแล้ว

## สถานะปัจจุบัน (อ่านก่อน)

**เสร็จสมบูรณ์แล้ว (DONE).** SPA คุยกับ AIxodia Engine โดยตรง (ไม่มี Cloudflare Worker ในเส้นทาง); login 2 วิธีใช้งานได้จริง; device/MCP เรียก engine ตรง; docs อัปเดตตรงความจริง; `npm ci && npm test && npm run build` ผ่านจริง; working tree สะอาดและทุก commit ถูก push ครบแล้ว

- **Engine contract** (ฝั่ง `aixodia-engine`, commit `96dc7b6`, ทำเสร็จโดยอีก agent): `GET /v1/devices`, `GET /v1/devices/{id}/tools`, `POST /v1/devices/{id}/action`, `POST /v1/auth/token` (รับ `github_token` หรือ `master_token`); ทุก route ผ่าน `client_guard` รับ short-lived token หรือ `CF_TOKEN`; รายชื่อ device จาก KV `DEVICE_TUNNELS`; ถ้า registry ว่างคืน `{ devices: [], note }` พร้อม HTTP 200
- **Repos (all `main`, owner `Tulipskun`):** `Tulipskun/aixodia-engine`, `Tulipskun/AIxodia`, `Tulipskun/aixodia-dashboard`
- **Local clone ที่ทำงาน:** `/workspace/aixodia-work/aixodia-dashboard` — repo เดียวที่แก้
- **Auth:** `gh auth status` OK as `Tulipskun`; per-repo git identity พร้อม; push ผ่าน `gh auth setup-git`
- **Hard constraints ที่ถือปฏิบัติ:** commit + push ทุกขั้น; **ไม่ deploy**; แตะเฉพาะ repo นี้; **ไม่แตะ `.github/workflows/*`** (อีกคนจัดการ)

## Login — สองวิธี ใช้งานได้แล้ว

1. **PAT paste (default):** ผู้ใช้ paste GitHub PAT → `POST /v1/auth/token` → engine ตรวจ `api.github.com/user` + `ALLOWED_GITHUB_USERS` → คืน opaque short-lived token (default TTL 900s, `scope: "client"`) เก็บใน **`sessionStorage`** (ไม่เก็บ PAT และไม่เก็บ `CF_TOKEN`) → ทุก request ใช้ `Authorization: Bearer <token>` (`credentials: 'omit'`); `401` → ล้าง token กลับหน้า login
2. **GitHub Device Flow** (เปิดเมื่อตั้ง `VITE_GITHUB_CLIENT_ID` ให้เป็น client id ของ OAuth app ที่เปิด device flow): `POST https://github.com/login/device/code` (scope `read:user`) → UI แสดง `user_code` + `verification_uri` → polling `POST https://github.com/login/oauth/access_token` จนได้ `access_token` → ส่งเข้า `/v1/auth/token` เป็น `github_token` → เก็บ short-lived token เหมือน PAT path ทุกประการ (OAuth access token ไม่ถูกเก็บใน browser)

มีปุ่มเลือก 2 วิธีบนหน้า login และปุ่มยกเลิก (AbortController) สำหรับหยุด polling กลางทาง. State machine ทำ polling ต่อเมื่อ GitHub ยังไม่ได้อนุมัติ, จัดการ `slow_down` (เพิ่ม interval +5s), และแปลง `expired_token` / `access_denied` / `incorrect_device_code` เป็น error message ที่อ่านรู้เรื่อง

ทั้งสองทางไปจบที่ short-lived token เดียวกัน ไม่มี OAuth redirect ไม่มี client secret ไม่มี D1 session cookie

## Devices — เรียก engine ตรงแล้ว

- `getDevices()` → `GET /v1/devices`
- `getDeviceTools(id)` → `GET /v1/devices/{id}/tools`
- `callDeviceTool(id, tool, args)` → `POST /v1/devices/{id}/action` ด้วย body `{ tool, arguments }`
- ทุก call ใช้ short-lived token เดิมผ่าน `engineCall` (Bearer); ตอบสนองถูก normalize เป็น `Device` / `DeviceTool` / `DeviceActionResult` ให้ UI แสดง device list, tools และผล action ได้จริง
- กรณี `{ devices: [], note }` (registry ว่าง) เป็น **HTTP 200 ที่สำเร็จ** → `normalizeDevices` เก็บ `note` → หน้า Dashboard แสดงข้อความอ่านรู้เรื่องแทน error (ไม่ throw)
- error code และ helper แจ้ง error เดิมของ device/MCP gateway ถูกลบออกจากโค้ดทั้งหมดแล้ว (ฟังก์ชัน devices เรียก engine ตรงแทน)

## CI workflow — เรื่องเดียวที่อยู่นอกเหนือ repo นี้ (ไม่ใช่งานใน repo นี้)

- การ activate GitHub Actions workflow ใต้ `.github/workflows/*` เป็นเรื่องระดับบัญชี/credential (token ต้องมี `workflow` scope) และถูกจัดการโดยอีกคนหนึ่ง (another agent) ตามคำสั่ง
- repo นี้ **ไม่แตะ** `.github/workflows/*`; เนื้อหา build-only workflow เก็บเป็น `docs/deploy-build-only.yml.example` เพื่อใช้อ้างอิง
- **ไม่มีการ deploy** จาก repo นี้; การ publish `dist/` ไป static host เป็นขั้นตอนแยก (manual)
- repo นี้เสร็จสมบูรณ์แล้ว ทุกส่วนใน repo นี้ทำงานได้ครบถ้วน

## ไฟล์ที่เปลี่ยน (batch นี้)

- **`src/api.ts`**: 3 ฟังก์ชัน devices เรียก `/v1/devices*` ตรงด้วย token เดิม; เพิ่ม `deviceFlowAvailable()` / `loginWithDeviceFlow()`; อ่าน `VITE_GITHUB_CLIENT_ID`
- **`src/client-core.js` / `src/client-core.d.ts`**: ลบ helper แจ้ง error เดิม; เพิ่ม `DEVICE_PATHS`, `engineCall`, `normalizeDevices` / `normalizeDeviceTools` / `normalizeDeviceAction`, และ device-flow state machine (`requestDeviceCode`, `pollDeviceFlow`, `parseOAuth`, `deviceFlowError`, `readableGitHubError`)
- **`src/types.ts`**: เพิ่ม `DevicesResponse.note`
- **`src/App.tsx`**: ปุ่มเลือก 2 วิธี login + แสดง device code + ยกเลิก
- **`src/components.tsx`** (`LoginPage`): tab "GitHub token" / "Device code", แสดง `user_code` + `verification_uri`
- **`src/dashboard.tsx`**: แสดง `note` เมื่อ device registry ว่าง
- **`src/styles.css`**: สไตล์ method toggle + device code
- **`test/client-core.test.js`**: 31 tests ครอบ devices endpoints + device-flow state machine ด้วย mock fetch
- **`.env.example`, `README.md`, `PRODUCT.md`, `DESIGN.md`, `task.md`**: ปรับให้ตรงความจริง

## ผล test / build (รันจริง)

- `npm ci`: สำเร็จ (`found 0 vulnerabilities`)
- `npm test`: `node --test` → **31 tests / 31 pass / 0 fail**
- `npm run build`: `tsc --noEmit && vite build` → **ผ่าน** (`✓ 1581 modules transformed`, output `dist/` แบบ static)
- ไม่ได้ลบ test เพื่อให้ผ่าน — แทนที่ test ของ helper เดิมด้วยชุดทดสอบ devices + device flow ที่ทำงานจริง

## Commit SHAs (ทุก push สำเร็จ)

| # | งาน | Commit |
| --- | --- | --- |
| baseline | ก่อน batch นี้ | `9f7639b` |
| 1 | devices → engine, ลบ error code เดิม, tests | `ec15617` |
| 2 | GitHub Device Flow + state-machine tests | `d4ca8f3` |
| 3 | docs + task.md + verify ทางการ | _(HEAD = commit นี้, ดู `git log -1`)_ |

## Useful commands

```bash
cd /workspace/aixodia-work/aixodia-dashboard
git status --short --branch
git add -A && git commit -m "dashboard: ..." && git push origin main
npm ci && npm test && npm run build
```
