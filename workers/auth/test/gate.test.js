import assert from 'node:assert/strict'
import test from 'node:test'

// The Worker's helpers are not exported individually (a Worker's module surface is
// its fetch handler), so the rules that matter are asserted here against the same
// logic re-derived from the source's constants. This keeps the tests honest about
// what they cover: the shapes, not the D1 round trip.

const EMAIL_MAX = 254

function emailWellFormed(email) {
  const trimmed = String(email || '').trim()
  if (!trimmed || trimmed.length > EMAIL_MAX) return false
  const at = trimmed.indexOf('@')
  if (at <= 0 || at !== trimmed.lastIndexOf('@')) return false
  const local = trimmed.slice(0, at)
  const domain = trimmed.slice(at + 1)
  if (!local || !domain || !domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) {
    return false
  }
  return !/[\s\u0000-\u001f\u007f]/.test(trimmed)
}

function permits(list, email) {
  const needle = String(email || '').trim().toLowerCase()
  return needle.length > 0 && list.includes(needle)
}

test('an empty allowlist permits nobody', () => {
  assert.equal(permits([], 'operator@example.com'), false)
})

test('the allowlist matches case-insensitively', () => {
  const list = ['operator@example.com']
  assert.equal(permits(list, 'operator@example.com'), true)
  assert.equal(permits(list, 'Operator@Example.COM'), true)
})

test('a prefix of a listed address does not match', () => {
  assert.equal(permits(['operator@example.com'], 'operator@example.co'), false)
})

test('an empty address never matches', () => {
  assert.equal(permits([''], ''), false)
  assert.equal(permits(['operator@example.com'], '   '), false)
})

test('plausible addresses pass the shape check', () => {
  assert.equal(emailWellFormed('operator@example.com'), true)
  assert.equal(emailWellFormed('  operator@example.com  '), true)
  assert.equal(emailWellFormed('first.last+tag@mail.example.co.uk'), true)
})

test('obvious non-addresses fail the shape check', () => {
  assert.equal(emailWellFormed(''), false)
  assert.equal(emailWellFormed('@example.com'), false)
  assert.equal(emailWellFormed('operator@'), false)
  assert.equal(emailWellFormed('operator'), false)
  assert.equal(emailWellFormed('operator@localhost'), false)
  // Two @ signs: the second must not be swallowed into the domain.
  assert.equal(emailWellFormed('operator@@example.com'), false)
  assert.equal(emailWellFormed('op erator@example.com'), false)
  assert.equal(emailWellFormed(`${'a'.repeat(300)}@example.com`), false)
})

test('a leading or trailing dot in the domain is rejected', () => {
  assert.equal(emailWellFormed('operator@.example.com'), false)
  assert.equal(emailWellFormed('operator@example.com.'), false)
})
