// Lightspeed Retail (X-Series) OAuth and token handling.
// Flow and token rules follow https://x-series-api.lightspeedhq.com/docs/authorization :
//  - authorize at https://secure.retail.lightspeed.app/connect (response_type=code, client_id, redirect_uri, state, scope)
//  - callback receives code, domain_prefix, state, scope — or error=access_denied
//  - token at https://{domain_prefix}.retail.lightspeed.app/api/1.0/token, form-encoded
//  - refresh returns a NEW refresh token (rotation); using a refresh token revokes the old access token
//  - the token endpoint is rate limited: refresh only when the access token has expired

import { encrypt, decrypt, randomId } from './crypto.js';
import { handleMock, MOCK_DOMAIN } from './mock.js';

// Read-only scopes. inventory:write is deliberately NOT requested (it would allow changing stock in Lightspeed).
export const DEFAULT_SCOPES = ['retailer:read', 'outlets:read', 'products:read', 'sales:read', 'inventory:read', 'consignments:read'];
export const SCOPE_INFO = {
  'retailer:read': 'Store name and settings',
  'outlets:read': 'Outlets',
  'products:read': 'Products',
  'sales:read': 'Sales, returns and voids',
  'inventory:read': 'Current stock levels',
  'consignments:read': 'Deliveries, stock orders and counts',
};
const FORBIDDEN = /write|payments|register:|billing/;

export const nowS = () => Math.floor(Date.now() / 1000);
export const isMock = (env) => env.MOCK_LIGHTSPEED !== 'false';
export function scopes(env) {
  const s = (env.LS_SCOPES || DEFAULT_SCOPES.join(' ')).split(/\s+/).filter(Boolean);
  const bad = s.filter((x) => FORBIDDEN.test(x));
  if (bad.length) throw new Error('Refusing to request non read-only scopes: ' + bad.join(', '));
  return s;
}
const clientId = (env) => env.LS_CLIENT_ID || (isMock(env) ? 'mock-client' : '');
const clientSecret = (env) => env.LS_CLIENT_SECRET || (isMock(env) ? 'mock-secret' : '');

// Outgoing requests. In mock mode they are answered inside the Worker, never sent to Lightspeed.
async function send(env, url, init) {
  if (isMock(env)) {
    const u = new URL(url);
    return handleMock(new Request('https://mock.local/mock' + u.pathname + u.search, init), env);
  }
  return (env.__fetch || fetch)(url, init);
}
const lsBase = (env, prefix) => (isMock(env) ? 'https://' + MOCK_DOMAIN + '.mock.local' : 'https://' + prefix + '.retail.lightspeed.app');

export async function audit(env, event, detail) {
  // detail must never contain tokens or secrets
  await env.DB.prepare('INSERT INTO audit (at, event, detail) VALUES (?, ?, ?)').bind(new Date().toISOString(), event, detail ? String(detail).slice(0, 500) : null).run();
}
export async function getConn(env) {
  return (await env.DB.prepare('SELECT * FROM connection WHERE id = 1').first()) || { state: 'disconnected' };
}
async function setConn(env, fields) {
  await env.DB.prepare("INSERT INTO connection (id, state) VALUES (1, 'disconnected') ON CONFLICT(id) DO NOTHING").run();
  const keys = Object.keys(fields);
  await env.DB.prepare('UPDATE connection SET ' + keys.map((k) => k + ' = ?').join(', ') + ' WHERE id = 1').bind(...keys.map((k) => fields[k])).run();
}

// ---- 1. start ----
export async function startAuth(env, redirectUri, origin) {
  if (!clientId(env)) throw new Error('Lightspeed client ID is not configured yet');
  const state = randomId();
  await env.DB.prepare('DELETE FROM oauth_state WHERE expires_at < ?').bind(nowS()).run();
  await env.DB.prepare('INSERT INTO oauth_state (state, created_at, expires_at) VALUES (?, ?, ?)').bind(state, nowS(), nowS() + 600).run();
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId(env), redirect_uri: redirectUri, state, scope: scopes(env).join(' ') });
  const base = isMock(env) ? origin + '/mock/connect' : 'https://secure.retail.lightspeed.app/connect';
  await audit(env, 'connect_started', isMock(env) ? 'Mock mode' : null);
  return base + '?' + q.toString();
}

// ---- 2. callback ----
export async function finishAuth(env, params, redirectUri) {
  const state = params.get('state') || '';
  const row = state ? await env.DB.prepare('SELECT * FROM oauth_state WHERE state = ?').bind(state).first() : null;
  if (row) await env.DB.prepare('DELETE FROM oauth_state WHERE state = ?').bind(state).run();
  if (!row || row.expires_at < nowS()) {
    await audit(env, 'connect_rejected', 'Invalid or expired state');
    return { ok: false, reason: 'invalid_state' };
  }
  if (params.get('error')) {
    await audit(env, 'connect_denied', params.get('error') === 'access_denied' ? 'Manager declined access' : 'Lightspeed returned ' + params.get('error'));
    return { ok: false, reason: params.get('error') === 'access_denied' ? 'denied' : 'error' };
  }
  const code = params.get('code'), prefix = params.get('domain_prefix') || '';
  if (!code || !/^[a-z0-9][a-z0-9-]{0,62}$/i.test(prefix)) {
    await audit(env, 'connect_rejected', 'Missing code or invalid domain prefix');
    return { ok: false, reason: 'invalid_callback' };
  }
  const body = new URLSearchParams({ code, client_id: clientId(env), client_secret: clientSecret(env), grant_type: 'authorization_code', redirect_uri: redirectUri });
  let res, data;
  try {
    res = await send(env, lsBase(env, prefix) + '/api/1.0/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    data = await res.json().catch(() => ({}));
  } catch {
    await audit(env, 'connect_failed', 'Could not reach Lightspeed');
    return { ok: false, reason: 'network' };
  }
  if (!res.ok || !data.access_token || !data.refresh_token) {
    await audit(env, 'connect_failed', 'Token exchange failed (HTTP ' + res.status + (data.error ? ', ' + data.error : '') + ')');
    return { ok: false, reason: 'token_exchange' };
  }
  await saveTokens(env, data, prefix);
  const granted = data.scope || params.get('scope') || '';
  await setConn(env, { state: 'connected', domain_prefix: data.domain_prefix || prefix, requested_scope: scopes(env).join(' '), granted_scope: granted, connected_at: new Date().toISOString(), last_error: null, retailer_name: null, outlets_json: null });
  const miss = missingScopes(env, granted);
  await audit(env, 'connected', (isMock(env) ? 'Mock store. ' : 'Store ' + (data.domain_prefix || prefix) + '. ') + (miss.length ? 'Missing permissions: ' + miss.join(', ') : 'All permissions granted'));
  await refreshDetails(env).catch(() => {});
  return { ok: true };
}

async function saveTokens(env, data, prefix) {
  const exp = Number(data.expires) || nowS() + Number(data.expires_in || 0);
  await setConn(env, {
    access_enc: await encrypt(env.TOKEN_KEY, data.access_token),
    refresh_enc: await encrypt(env.TOKEN_KEY, data.refresh_token),
    expires_at: exp,
    domain_prefix: data.domain_prefix || prefix,
  });
}
export function missingScopes(env, granted) {
  const g = new Set(String(granted || '').split(/\s+/).filter(Boolean));
  return scopes(env).filter((s) => !g.has(s));
}

// ---- 3. tokens ----
class ReauthError extends Error {}
async function refresh(env, conn) {
  // simple lock so two requests never spend the same refresh token
  const lock = await env.DB.prepare('UPDATE connection SET refreshing_until = ? WHERE id = 1 AND (refreshing_until IS NULL OR refreshing_until < ?)').bind(nowS() + 30, nowS()).run();
  if (!lock.meta || lock.meta.changes !== 1) throw new Error('A token refresh is already in progress. Try again in a moment.');
  try {
    const rt = await decrypt(env.TOKEN_KEY, conn.refresh_enc);
    const body = new URLSearchParams({ refresh_token: rt, client_id: clientId(env), client_secret: clientSecret(env), grant_type: 'refresh_token' });
    let res;
    try { res = await send(env, lsBase(env, conn.domain_prefix) + '/api/1.0/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() }); }
    catch { throw new Error('Could not reach Lightspeed to refresh access'); }
    const data = await res.json().catch(() => ({}));
    if (res.status === 400 || res.status === 401) {
      await setConn(env, { state: 'reauth_required', access_enc: null, refresh_enc: null, last_error: 'Lightspeed no longer accepts this connection. It may have been revoked. A manager needs to reconnect.' });
      await audit(env, 'reauth_required', 'Refresh rejected (HTTP ' + res.status + ')');
      throw new ReauthError('Reconnect required');
    }
    if (!res.ok || !data.access_token || !data.refresh_token) throw new Error('Lightspeed refresh failed (HTTP ' + res.status + ')');
    await saveTokens(env, data, conn.domain_prefix);
    await setConn(env, { last_refresh_at: new Date().toISOString() });
    await audit(env, 'token_refreshed', null);
    return data.access_token;
  } finally {
    await env.DB.prepare('UPDATE connection SET refreshing_until = NULL WHERE id = 1').run();
  }
}
async function accessToken(env, force) {
  const c = await getConn(env);
  if (c.state !== 'connected' || !c.access_enc) throw new ReauthError(c.state === 'reauth_required' ? 'Reconnect required' : 'Not connected');
  try {
    if (force || !c.expires_at || c.expires_at - 60 <= nowS()) return await refresh(env, c);
    return await decrypt(env.TOKEN_KEY, c.access_enc);
  } catch (e) {
    if (e instanceof ReauthError || !/decrypt|operation|OperationError/i.test(String(e && (e.name + ' ' + e.message)))) throw e;
    // stored tokens can no longer be decrypted (for example the encryption key was replaced)
    await setConn(env, { state: 'reauth_required', access_enc: null, refresh_enc: null, last_error: 'Stored access could not be read. A manager needs to reconnect.' });
    await audit(env, 'reauth_required', 'Stored tokens unreadable');
    throw new ReauthError('Reconnect required');
  }
}

// ---- 4. API calls ----
export async function apiGet(env, path) {
  const c = await getConn(env);
  const call = async (tok) => send(env, lsBase(env, c.domain_prefix) + path, { headers: { authorization: 'Bearer ' + tok, accept: 'application/json' } });
  let res = await call(await accessToken(env));
  if (res.status === 401) res = await call(await accessToken(env, true)); // token may have been revoked early: refresh once
  if (res.status === 401) {
    await setConn(env, { state: 'reauth_required', last_error: 'Lightspeed rejected the connection. A manager needs to reconnect.' });
    await audit(env, 'reauth_required', 'API returned 401 after refresh');
    throw new ReauthError('Reconnect required');
  }
  if (res.status === 403) {
    const e = new Error('Lightspeed did not grant permission for ' + path + '. Reconnect and approve all requested permissions.');
    e.code = 'missing_permission';
    throw e;
  }
  if (res.status === 429) throw new Error('Lightspeed is rate limiting requests. Try again shortly.');
  if (!res.ok) throw new Error('Lightspeed returned an error (HTTP ' + res.status + ')');
  return res.json();
}

// Retailer name and outlets, shown on the manager screen.
export async function refreshDetails(env) {
  const out = {};
  try {
    const r = await apiGet(env, '/api/2.0/retailer');
    out.retailer_name = (r.data && (r.data.name || r.data.retailer_name)) || null;
  } catch (e) { if (e instanceof ReauthError) throw e; out.err = e.message; }
  try {
    const o = await apiGet(env, '/api/2.0/outlets');
    out.outlets_json = JSON.stringify((o.data || []).map((x) => ({ id: x.id, name: x.name })));
  } catch (e) { if (e instanceof ReauthError) throw e; out.err = out.err || e.message; }
  const f = { last_check_at: new Date().toISOString(), last_error: out.err || null };
  if ('retailer_name' in out) f.retailer_name = out.retailer_name;
  if ('outlets_json' in out) f.outlets_json = out.outlets_json;
  await setConn(env, f);
  return out;
}

export async function checkConnection(env) {
  try {
    const r = await refreshDetails(env);
    await audit(env, r.err ? 'check_failed' : 'check_ok', r.err || null);
    return { ok: !r.err, error: r.err || null };
  } catch (e) {
    if (!(e instanceof ReauthError)) {
      await setConn(env, { last_error: e.message, last_check_at: new Date().toISOString() });
      await audit(env, 'check_failed', e.message);
    }
    return { ok: false, error: e.message };
  }
}

export async function disconnect(env) {
  await setConn(env, { state: 'disconnected', access_enc: null, refresh_enc: null, expires_at: null, granted_scope: null, retailer_name: null, outlets_json: null, last_error: null, domain_prefix: null, connected_at: null });
  await audit(env, 'disconnected', 'Tokens deleted from Kush');
}

export { ReauthError };
