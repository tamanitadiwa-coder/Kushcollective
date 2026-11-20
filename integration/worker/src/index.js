// Kush Collective · Lightspeed connection service (Cloudflare Worker)
//
// Public:   GET  /public-status        connected or not, plus last sync time. Nothing sensitive.
//           GET  /oauth/callback       Lightspeed sends the manager back here.
// Manager:  POST /session              { passcode } → short-lived manager session token
//           GET  /status               full connection details (never tokens)
//           POST /oauth/start          → { url } to send the manager to Lightspeed
//           POST /check                test the connection now
//           POST /disconnect           delete stored tokens
//           GET  /audit                recent connection events
// Mock:     /mock/*                    fake Lightspeed, only when MOCK_LIGHTSPEED is not "false"

import { signSession, verifySession, safeEqual } from './crypto.js';
import { startAuth, finishAuth, getConn, checkConnection, disconnect, audit, scopes, missingScopes, isMock, nowS, SCOPE_INFO } from './lightspeed.js';
import { handleMock } from './mock.js';

const SESSION_HOURS = 8;
const MAX_FAILS = 8; // per IP per 15 minutes

function cors(env, req) {
  const origin = req.headers.get('origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const h = { 'vary': 'Origin' };
  if (allowed.includes(origin)) {
    h['access-control-allow-origin'] = origin;
    h['access-control-allow-headers'] = 'authorization, content-type';
    h['access-control-allow-methods'] = 'GET, POST, OPTIONS';
    h['access-control-max-age'] = '600';
  }
  return h;
}
const json = (env, req, data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(env, req) } });
const appUrl = (env, qs) => (env.APP_URL || '/') + (qs ? (String(env.APP_URL || '').includes('?') ? '&' : '?') + qs : '');
const redirectUri = (env, req) => env.REDIRECT_URI || new URL(req.url).origin + '/oauth/callback';

async function isManager(env, req) {
  const tok = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const p = await verifySession(env.SESSION_KEY, tok);
  return !!(p && p.role === 'manager');
}

async function login(env, req) {
  const ip = req.headers.get('cf-connecting-ip') || 'local';
  const since = nowS() - 900;
  await env.DB.prepare('DELETE FROM login_attempts WHERE at < ?').bind(since).run();
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ?').bind(ip).first();
  if (n && n.n >= MAX_FAILS) return json(env, req, { error: 'Too many attempts. Try again in 15 minutes.' }, 429);
  if (!env.MANAGER_PASSCODE) return json(env, req, { error: 'The manager passcode has not been set up yet.' }, 503);
  let body = {};
  try { body = await req.json(); } catch {}
  const pass = String(body.passcode || '');
  if (!pass || !(await safeEqual(env.SESSION_KEY, pass, env.MANAGER_PASSCODE))) {
    await env.DB.prepare('INSERT INTO login_attempts (ip, at) VALUES (?, ?)').bind(ip, nowS()).run();
    await audit(env, 'manager_signin_failed', null);
    return json(env, req, { error: 'That passcode is not correct.' }, 401);
  }
  const exp = nowS() + SESSION_HOURS * 3600;
  return json(env, req, { token: await signSession(env.SESSION_KEY, { role: 'manager', exp }), expires: exp });
}

async function status(env) {
  const c = await getConn(env);
  const req = scopes(env);
  const granted = c.granted_scope || '';
  let outlets = [];
  try { outlets = JSON.parse(c.outlets_json || '[]'); } catch {}
  return {
    mode: isMock(env) ? 'mock' : 'live',
    configured: !!(env.LS_CLIENT_ID || isMock(env)),
    state: c.state || 'disconnected',
    retailer: c.retailer_name || null,
    domain_prefix: c.domain_prefix || null,
    outlets,
    connected_at: c.connected_at || null,
    last_refresh_at: c.last_refresh_at || null,
    last_check_at: c.last_check_at || null,
    last_sync_at: c.last_sync_at || null,
    access_expires_at: c.expires_at ? new Date(c.expires_at * 1000).toISOString() : null,
    last_error: c.last_error || null,
    permissions: req.map((s) => ({ scope: s, label: SCOPE_INFO[s] || s, granted: c.state === 'connected' ? granted.split(/\s+/).includes(s) : null })),
    missing: c.state === 'connected' ? missingScopes(env, granted) : [],
  };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env, req) });
    try {
      if (path.startsWith('/mock/')) {
        if (!isMock(env)) return new Response('Not found', { status: 404 });
        return handleMock(req, env);
      }
      if (path === '/public-status' && req.method === 'GET') {
        const c = await getConn(env);
        return json(env, req, { state: c.state === 'connected' ? 'connected' : 'not_connected', last_sync_at: c.last_sync_at || null, mode: isMock(env) ? 'mock' : 'live' });
      }
      if (path === '/oauth/callback' && req.method === 'GET') {
        const r = await finishAuth(env, url.searchParams, redirectUri(env, req));
        return Response.redirect(appUrl(env, r.ok ? 'ls=connected' : 'ls=' + encodeURIComponent(r.reason)), 302);
      }
      if (path === '/session' && req.method === 'POST') return login(env, req);

      // everything below is manager-only
      if (!(await isManager(env, req))) return json(env, req, { error: 'Manager sign-in required.' }, 401);
      if (path === '/status' && req.method === 'GET') return json(env, req, await status(env));
      if (path === '/oauth/start' && req.method === 'POST') {
        try { return json(env, req, { url: await startAuth(env, redirectUri(env, req), url.origin) }); }
        catch (e) { return json(env, req, { error: e.message }, 503); }
      }
      if (path === '/check' && req.method === 'POST') {
        const r = await checkConnection(env);
        return json(env, req, { ...r, status: await status(env) }, 200);
      }
      if (path === '/disconnect' && req.method === 'POST') { await disconnect(env); return json(env, req, await status(env)); }
      if (path === '/audit' && req.method === 'GET') {
        const r = await env.DB.prepare('SELECT at, event, detail FROM audit ORDER BY id DESC LIMIT 50').all();
        return json(env, req, { events: r.results || [] });
      }
      return json(env, req, { error: 'Not found' }, 404);
    } catch (e) {
      // never echo internals that might include secrets
      try { await audit(env, 'server_error', (e && e.message || 'error').slice(0, 200)); } catch {}
      return json(env, req, { error: 'Something went wrong in the connection service.' }, 500);
    }
  },
};
