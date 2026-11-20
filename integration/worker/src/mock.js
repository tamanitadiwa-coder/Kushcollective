// Mock Lightspeed for development and tests.
// It imitates the documented OAuth flow (authorize → code → token → refresh with rotation)
// so the whole connection can be built and tested without any real store credentials.
// Everything it returns is clearly labelled as mock data.

import { randomId } from './crypto.js';

const now = () => Math.floor(Date.now() / 1000);
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const MOCK_DOMAIN = 'mock-store';

export async function handleMock(req, env) {
  const url = new URL(req.url);
  const p = url.pathname.replace(/^\/mock/, '');
  const db = env.DB;
  const life = Number(env.MOCK_EXPIRES_IN || 86400);

  // 1. Consent screen (stands in for secure.retail.lightspeed.app/connect)
  if (p === '/connect' && req.method === 'GET') {
    const q = url.searchParams;
    const redirect = q.get('redirect_uri') || '';
    const scope = q.get('scope') || '';
    if (q.get('client_id') !== (env.LS_CLIENT_ID || 'mock-client')) return new Response('Unknown client_id', { status: 400 });
    const back = (extra) => redirect + (redirect.includes('?') ? '&' : '?') + new URLSearchParams(extra).toString();
    const approve = async (grant) => {
      const code = randomId();
      await db.prepare('INSERT INTO mock_codes (code, scope, expires_at) VALUES (?, ?, ?)').bind(code, grant, now() + 600).run();
      return back({ code, domain_prefix: MOCK_DOMAIN, state: q.get('state') || '', scope: grant });
    };
    // Automated answers for tests: ?mock_decision=approve|deny|partial
    const auto = q.get('mock_decision');
    if (auto === 'deny') return Response.redirect(back({ error: 'access_denied', state: q.get('state') || '' }), 302);
    if (auto === 'approve') return Response.redirect(await approve(scope), 302);
    if (auto === 'partial') return Response.redirect(await approve(scope.split(' ').filter((s) => s !== 'sales:read').join(' ')), 302);
    const self = new URL(req.url);
    const link = (d) => { const u = new URL(self); u.searchParams.set('mock_decision', d); return esc(u.toString()); };
    return new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mock Lightspeed</title>
<body style="margin:0;font-family:system-ui;background:#f4f4f2;color:#1b1b1b;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px">
<div style="max-width:420px;background:#fff;border-radius:16px;padding:28px;box-shadow:0 6px 30px rgba(0,0,0,.08)">
<p style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#a0522d;margin:0 0 10px">Mock Lightspeed · test only</p>
<h1 style="font-size:22px;margin:0 0 8px">Kush Collective wants read access</h1>
<p style="color:#555;font-size:14px">This page imitates Lightspeed's approval screen so the connection can be tested without a real store. No real data is involved.</p>
<ul style="font-size:14px;color:#333;padding-left:18px">${scope.split(' ').filter(Boolean).map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
<p><a href="${link('approve')}" style="display:inline-block;background:#10291F;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none">Approve</a>
<a href="${link('deny')}" style="display:inline-block;margin-left:8px;color:#10291F;padding:12px 18px;border:1px solid #ccc;border-radius:10px;text-decoration:none">Deny</a></p>
<p style="font-size:13px"><a href="${link('partial')}" style="color:#666">Approve without sales:read</a> (tests missing permissions)</p></div></body>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }

  // 2. Token endpoint (stands in for https://{domain_prefix}.retail.lightspeed.app/api/1.0/token)
  if (p === '/api/1.0/token' && req.method === 'POST') {
    const ct = req.headers.get('content-type') || '';
    if (!ct.includes('application/x-www-form-urlencoded')) return json({ error: 'invalid_request' }, 400);
    const f = new URLSearchParams(await req.text());
    if (f.get('client_id') !== (env.LS_CLIENT_ID || 'mock-client') || f.get('client_secret') !== (env.LS_CLIENT_SECRET || 'mock-secret')) return json({ error: 'invalid_client' }, 401);
    let scope;
    if (f.get('grant_type') === 'authorization_code') {
      const row = await db.prepare('SELECT * FROM mock_codes WHERE code = ?').bind(f.get('code') || '').first();
      if (!row || row.used || row.expires_at < now()) return json({ error: 'invalid_grant' }, 400);
      await db.prepare('UPDATE mock_codes SET used = 1 WHERE code = ?').bind(row.code).run();
      scope = row.scope;
    } else if (f.get('grant_type') === 'refresh_token') {
      const row = await db.prepare("SELECT * FROM mock_tokens WHERE token = ? AND kind = 'refresh'").bind(f.get('refresh_token') || '').first();
      if (!row || row.revoked) return json({ error: 'invalid_grant' }, 400);
      // rotation: old refresh token and the access tokens issued with it stop working
      await db.prepare('UPDATE mock_tokens SET revoked = 1 WHERE scope = ? AND revoked = 0').bind(row.scope).run();
      scope = row.scope;
    } else return json({ error: 'unsupported_grant_type' }, 400);
    const access = 'mock_at_' + randomId(), refresh = 'mock_rt_' + randomId(), exp = now() + life;
    await db.prepare("INSERT INTO mock_tokens (token, kind, scope, expires_at) VALUES (?, 'access', ?, ?)").bind(access, scope, exp).run();
    await db.prepare("INSERT INTO mock_tokens (token, kind, scope, expires_at) VALUES (?, 'refresh', ?, ?)").bind(refresh, scope, now() + 90 * 86400).run();
    return json({ access_token: access, token_type: 'Bearer', expires: exp, expires_in: life, refresh_token: refresh, domain_prefix: MOCK_DOMAIN, scope });
  }

  // 3. A few read endpoints
  if (p.startsWith('/api/2.0/') && req.method === 'GET') {
    if (env.MOCK_API_DOWN === 'true') return json({ error: 'Service unavailable (mock)' }, 503);
    const auth = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const row = await db.prepare("SELECT * FROM mock_tokens WHERE token = ? AND kind = 'access'").bind(auth).first();
    if (!row || row.revoked || row.expires_at < now()) return json({ error: 'Unauthorized' }, 401);
    const has = (s) => (row.scope || '').split(' ').includes(s);
    if (p === '/api/2.0/retailer') return has('retailer:read') ? json({ data: { name: 'Mock store (test data)', domain_prefix: MOCK_DOMAIN } }) : json({ error: 'Forbidden' }, 403);
    if (p === '/api/2.0/outlets') return has('outlets:read') ? json({ data: [{ id: 'mock-outlet-1', name: 'Mock outlet (test data)' }] }) : json({ error: 'Forbidden' }, 403);
    return json({ error: 'Not found' }, 404);
  }
  return json({ error: 'Not found' }, 404);
}
