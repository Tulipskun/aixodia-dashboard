const SESSION_DAYS = 30;
const RENEW_BEFORE_DAYS = 29;
import { SESSION_COOKIE, STATE_COOKIE, cookie, clearCookie, randomToken, sha256, readCookie, callbackUrl } from './lib.js';

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}
function appOrigin(request, env) { return (env.APP_ORIGIN || new URL(request.url).origin).replace(/\/$/, ''); }
function isConfigured(env) {
  return Boolean(env.DB && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && env.APP_ORIGIN);
}
async function createSession(env, username, githubId) {
  const token = randomToken();
  const now = Math.floor(Date.now() / 1000);
  const expires = now + SESSION_DAYS * 86400;
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now).run();
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, github_id, username, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(await sha256(token), String(githubId), username, now, now, expires).run();
  return { token, expiresAt: new Date(expires * 1000).toISOString() };
}
async function authenticate(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token || !env.DB) return null;
  const hash = await sha256(token);
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    'SELECT github_id, username, expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?'
  ).bind(hash, now).first();
  if (!row) return null;
  const renew = row.expires_at - now < RENEW_BEFORE_DAYS * 86400;
  if (renew) {
    const expires = now + SESSION_DAYS * 86400;
    await env.DB.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?')
      .bind(now, expires, hash).run();
    return { username: row.username, githubId: row.github_id, expiresAt: expires, setCookie: cookie(SESSION_COOKIE, token, SESSION_DAYS * 86400) };
  }
  return { username: row.username, githubId: row.github_id, expiresAt: row.expires_at, setCookie: null };
}
function sameOrigin(request, env) {
  const origin = request.headers.get('origin');
  return origin === appOrigin(request, env);
}
async function requireSession(request, env) {
  const session = await authenticate(request, env);
  if (!session) return { response: json({ error: 'Authentication required', code: 'UNAUTHORIZED' }, 401, { 'set-cookie': clearCookie(SESSION_COOKIE) }) };
  return { session };
}
async function githubStart(request, env) {
  if (!isConfigured(env)) return json({ error: 'GitHub OAuth or D1 is not configured', code: 'AUTH_NOT_CONFIGURED' }, 503);
  const state = randomToken(24);
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  url.searchParams.set('redirect_uri', callbackUrl(request, env));
  url.searchParams.set('scope', 'read:user');
  url.searchParams.set('state', state);
  return new Response(null, { status: 302, headers: {
    location: url.toString(),
    'cache-control': 'no-store',
    'set-cookie': cookie(STATE_COOKIE, state, 600),
  }});
}
async function githubCallback(request, env) {
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  const savedState = readCookie(request, STATE_COOKIE);
  const clearState = clearCookie(STATE_COOKIE);
  if (url.searchParams.has('error')) return new Response(null, { status: 302, headers: { location: `${appOrigin(request, env)}/?auth_error=access_denied`, 'set-cookie': clearState } });
  if (!state || !savedState || state !== savedState || !url.searchParams.get('code')) {
    return new Response(null, { status: 302, headers: { location: `${appOrigin(request, env)}/?auth_error=oauth_failed`, 'set-cookie': clearState } });
  }
  try {
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code: url.searchParams.get('code'), redirect_uri: callbackUrl(request, env), state }),
    });
    if (!tokenResponse.ok) throw new Error('token exchange failed');
    const tokenData = await tokenResponse.json();
    if (!tokenData.access_token) throw new Error('missing access token');
    const userResponse = await fetch('https://api.github.com/user', {
      headers: { authorization: `Bearer ${tokenData.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'AIxodia-Dashboard' },
    });
    if (!userResponse.ok) throw new Error('user lookup failed');
    const user = await userResponse.json();
    const allowed = (env.ALLOWED_GITHUB_USERS || 'Tulipskun').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
    if (!user.login || !allowed.includes(user.login.toLowerCase())) {
      return new Response(null, { status: 302, headers: { location: `${appOrigin(request, env)}/?auth_error=not_allowed`, 'set-cookie': clearState } });
    }
    const session = await createSession(env, user.login, user.id);
    const headers = new Headers({ location: `${appOrigin(request, env)}/`, 'cache-control': 'no-store' });
    headers.append('set-cookie', cookie(SESSION_COOKIE, session.token, SESSION_DAYS * 86400));
    headers.append('set-cookie', clearState);
    return new Response(null, { status: 302, headers });
  } catch {
    return new Response(null, { status: 302, headers: { location: `${appOrigin(request, env)}/?auth_error=oauth_failed`, 'set-cookie': clearState } });
  }
}
async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === 'GET' && path === '/api/health') {
    return json({ ok: true, platform: 'cloudflare-workers', authConfigured: isConfigured(env), mcpConfigured: Boolean(env.MCP_BASE_URL), mcpBaseUrl: env.MCP_BASE_URL || '', protocolVersion: '2025-11-25', deviceCount: 0, consoleName: 'AIxodia Device Console', time: new Date().toISOString() });
  }
  if (request.method === 'GET' && path === '/api/session') {
    const session = await authenticate(request, env);
    return json({ authenticated: Boolean(session), username: session?.username || null, expiresAt: session ? new Date(session.expiresAt * 1000).toISOString() : null, platform: 'cloudflare-workers' }, 200, session?.setCookie ? { 'set-cookie': session.setCookie } : {});
  }
  if (request.method === 'GET' && path === '/api/auth/github') return githubStart(request, env);
  if (request.method === 'GET' && path === '/api/auth/github/callback') return githubCallback(request, env);
  if (request.method === 'POST' && path === '/api/logout') {
    if (!sameOrigin(request, env)) return json({ error: 'Invalid origin', code: 'CSRF_REJECTED' }, 403);
    const token = readCookie(request, SESSION_COOKIE);
    if (token && env.DB) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
    return json({ ok: true }, 200, { 'set-cookie': clearCookie(SESSION_COOKIE) });
  }
  const auth = await requireSession(request, env);
  if (auth.response) return auth.response;
  if (auth.session.setCookie && request.method === 'GET' && path === '/api/config') {
    return json({ error: 'MCP integration is not configured', code: 'MCP_NOT_CONFIGURED' }, 503, { 'set-cookie': auth.session.setCookie });
  }
  return json({ error: 'MCP integration is not configured', code: 'MCP_NOT_CONFIGURED' }, 503, auth.session.setCookie ? { 'set-cookie': auth.session.setCookie } : {});
}

export default {
  async fetch(request, env) {
    try {
      const path = new URL(request.url).pathname;
      if (!path.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
      return await route(request, env);
    }
    catch { return json({ error: 'Internal server error', code: 'INTERNAL_ERROR' }, 500); }
  },
};
