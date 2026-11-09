import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';

function fakeDb() {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      return { bind(...values) {
        return {
          async run() {
            if (sql.startsWith('DELETE FROM sessions WHERE expires_at')) {
              for (const [key, row] of rows) if (row.expires_at <= values[0]) rows.delete(key);
            } else if (sql.startsWith('INSERT INTO sessions')) {
              const [token_hash, github_id, username, created_at, last_seen_at, expires_at] = values;
              rows.set(token_hash, { github_id, username, created_at, last_seen_at, expires_at });
            } else if (sql.startsWith('UPDATE sessions SET last_seen_at = ?, expires_at = ?')) {
              const [last_seen_at, expires_at, hash] = values;
              const row = rows.get(hash);
              if (row) Object.assign(row, { last_seen_at, expires_at });
            } else if (sql.startsWith('DELETE FROM sessions WHERE token_hash')) {
              rows.delete(values[0]);
            }
            return { success: true };
          },
          async first() {
            if (sql.startsWith('SELECT github_id')) {
              const [hash, now] = values;
              const row = rows.get(hash);
              return row && row.expires_at > now ? row : null;
            }
            return null;
          },
        };
      }};
    },
  };
}

test('GitHub OAuth creates a D1 session, restores it from cookie, renews it, and revokes it', async () => {
  const originalFetch = globalThis.fetch;
  const db = fakeDb();
  const env = {
    DB: db,
    GITHUB_CLIENT_ID: 'test-client-id',
    GITHUB_CLIENT_SECRET: 'test-client-secret',
    APP_ORIGIN: 'https://dashboard.example.test',
    ALLOWED_GITHUB_USERS: 'Tulipskun',
  };
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/login/oauth/access_token')) return Response.json({ access_token: 'temporary-test-token' });
    if (url.includes('/user')) return Response.json({ id: 1234, login: 'Tulipskun' });
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const start = await worker.fetch(new Request('https://dashboard.example.test/auth/github'), env);
    assert.equal(start.status, 302);
    const authUrl = new URL(start.headers.get('location'));
    assert.equal(authUrl.origin, 'https://github.com');
    assert.equal(authUrl.searchParams.get('redirect_uri'), 'https://dashboard.example.test/auth/github/callback');
    const stateCookie = start.headers.get('set-cookie').split(';')[0];
    const state = stateCookie.split('=').slice(1).join('=');
    const callback = await worker.fetch(new Request(`https://dashboard.example.test/api/auth/github/callback?code=oauth-code&state=${state}`, { headers: { cookie: stateCookie } }), env);
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), 'https://dashboard.example.test/');
    const cookies = callback.headers.getSetCookie();
    const sessionCookie = cookies.find((value) => value.startsWith('__Host-aixodia_session='));
    assert.ok(sessionCookie);
    assert.match(sessionCookie, /HttpOnly/);
    assert.match(sessionCookie, /Secure/);
    assert.match(sessionCookie, /SameSite=Lax/);
    const sessionPair = sessionCookie.split(';')[0];
    assert.equal(db.rows.size, 1);

    const sessionResponse = await worker.fetch(new Request('https://dashboard.example.test/api/session', { headers: { cookie: sessionPair } }), env);
    const session = await sessionResponse.json();
    assert.equal(session.authenticated, true);
    assert.equal(session.username, 'Tulipskun');

    const [hash, row] = [...db.rows.entries()][0];
    row.expires_at = Math.floor(Date.now() / 1000) + 86400;
    const renewed = await worker.fetch(new Request('https://dashboard.example.test/api/session', { headers: { cookie: sessionPair } }), env);
    assert.equal(renewed.status, 200);
    assert.ok(renewed.headers.get('set-cookie').includes('Max-Age=2592000'));
    assert.ok(db.rows.get(hash).expires_at > Math.floor(Date.now() / 1000) + 29 * 86400);

    const logout = await worker.fetch(new Request('https://dashboard.example.test/api/logout', { method: 'POST', headers: { cookie: sessionPair, origin: 'https://dashboard.example.test' } }), env);
    assert.equal(logout.status, 200);
    assert.equal(db.rows.size, 0);
    const afterLogout = await worker.fetch(new Request('https://dashboard.example.test/api/session', { headers: { cookie: sessionPair } }), env);
    assert.equal((await afterLogout.json()).authenticated, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
