import test from 'node:test';
import assert from 'node:assert/strict';
import { randomToken, sha256, readCookie, callbackUrl } from '../worker/lib.js';

test('session tokens are URL-safe, random, and 43 chars for 32 bytes', () => {
  const a = randomToken();
  const b = randomToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
});
test('session hashes are SHA-256 hex and do not expose the token', async () => {
  const hash = await sha256('example-session-token');
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.notEqual(hash, 'example-session-token');
});
test('cookie parser handles multiple cookies', () => {
  const req = new Request('https://example.test', { headers: { cookie: 'a=one; __Host-aixodia_session=abc_xyz; c=three' } });
  assert.equal(readCookie(req, '__Host-aixodia_session'), 'abc_xyz');
  assert.equal(readCookie(req, 'missing'), null);
});
test('OAuth callback uses the configured stable app origin', () => {
  const req = new Request('http://127.0.0.1:8787/api/auth/github');
  assert.equal(callbackUrl(req, { APP_ORIGIN: 'https://dashboard.example.com/' }), 'https://dashboard.example.com/auth/github/callback');
});
