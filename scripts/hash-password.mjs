#!/usr/bin/env node
// Generate AUTH_PASSWORD_HASH (PBKDF2-SHA256) without ever printing the password.
//
// Usage (recommended, password never appears in shell history / process list):
//   printf '%s' "$PASSWORD" | npm run hash:password
// Or:
//   AUTH_PASSWORD='...' npm run hash:password
//   npm run hash:password -- --password='...'
//
// Output: a single line  pbkdf2$100000$<salt>$<hash>  -> put into AUTH_PASSWORD_HASH.
import { derivePasswordHash } from '../cloudflare/auth.js'

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

const fromArg = process.argv.find((a) => a.startsWith('--password='))?.slice('--password='.length)
let password = fromArg ?? process.env.AUTH_PASSWORD ?? null
if (!password) password = await readStdin()
password = String(password).replace(/\r?\n$/, '') // trim only a trailing newline from a pipe

if (!password) {
  console.error('ไม่พบรหัสผ่าน: ส่งมาทาง stdin, AUTH_PASSWORD หรือ --password=')
  process.exit(2)
}
if (password.length < 8) {
  console.error('รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร')
  process.exit(2)
}

const hash = await derivePasswordHash(password)
// Print ONLY the hash. Never echo the password.
console.log(hash)
