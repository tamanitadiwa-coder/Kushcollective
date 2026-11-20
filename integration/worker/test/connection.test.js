import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { makeDB } from './d1-shim.js';

const ORIGIN = 'https://kush-lightspeed.example.workers.dev';
const APP = 'https://tamanitadiwa-coder.github.io/Kushcollective/lightspeed.html';

function makeEnv(extra = {}) {
  return {
    DB: makeDB(),
    MOCK_LIGHTSPEED: 'true',
    ALLOWED_ORIGINS: 'https://tamanitadiwa-coder.github.io',
    APP_URL: APP,
    TOKEN_KEY: 'test-token-key-not-real',
    SESSION_KEY: 'test-session-key-not-real',
    MANAGER_PASSCODE: 'correct horse',
    ...extra,
  };
}
async function call(env, path, { method = 'GET', body, token, origin, ip = '1.1.1.1' } = {}) {
  const headers = { 'cf-connecting-ip': ip };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = 'Bearer ' + token;
  if (origin) headers.origin = origin;
  const url = path.startsWith('http') ? path : ORIGIN + path;
  return worker.fetch(new Request(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' }), env);
}
async function signIn(env) {
  const r = await call(env, '/session', { method: 'POST', body: { passcode: 'correct horse' } });
  assert.equal(r.status, 200);
  return (await r.json()).token;
}
// Runs the full browser journey: start → mock Lightspeed consent → callback → back to the app.
async function connect(env, token, decision = 'approve', tamper) {
  const s = await call(env, '/oauth/start', { method: 'POST', token });
  const { url } = await s.json();
  const consent = new URL(url);
  consent.searchParams.set('mock_decision', decision);
  const r1 = await call(env, consent.toString());
  assert.equal(r1.status, 302);
  let cb = r1.headers.get('location');
  if (tamper) cb = tamper(cb);
  const r2 = await call(env, cb);
  assert.equal(r2.status, 302);
  return new URL(r2.headers.get('location'));
}
const status = async (env, token) => (await call(env, '/status', { token })).json();
const auditText = async (env) => JSON.stringify((await env.DB.prepare('SELECT * FROM audit').all()).results);

test('manager-only: no session, bad passcode, rate limit', async () => {
  const env = makeEnv();
  assert.equal((await call(env, '/status')).status, 401);
  assert.equal((await call(env, '/oauth/start', { method: 'POST' })).status, 401);
  assert.equal((await call(env, '/disconnect', { method: 'POST' })).status, 401);
  assert.equal((await call(env, '/status', { token: 'forged.token' })).status, 401);
  const bad = await call(env, '/session', { method: 'POST', body: { passcode: 'wrong' } });
  assert.equal(bad.status, 401);
  for (let i = 0; i < 8; i++) await call(env, '/session', { method: 'POST', body: { passcode: 'wrong' }, ip: '9.9.9.9' });
  assert.equal((await call(env, '/session', { method: 'POST', body: { passcode: 'correct horse' }, ip: '9.9.9.9' })).status, 429);
  assert.match(await auditText(env), /manager_signin_failed/);
});

test('public status reveals nothing sensitive', async () => {
  const env = makeEnv();
  const token = await signIn(env);
  await connect(env, token);
  const p = await (await call(env, '/public-status')).json();
  assert.deepEqual(Object.keys(p).sort(), ['last_sync_at', 'mode', 'state']);
  assert.equal(p.state, 'connected');
});

test('connection initiation builds a correct, read-only authorize URL', async () => {
  const env = makeEnv();
  const token = await signIn(env);
  const { url } = await (await call(env, '/oauth/start', { method: 'POST', token })).json();
  const u = new URL(url);
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('redirect_uri'), ORIGIN + '/oauth/callback');
  assert.ok(u.searchParams.get('state').length >= 8);
  const sc = u.searchParams.get('scope').split(' ');
  assert.deepEqual(sc, ['retailer:read', 'outlets:read', 'products:read', 'sales:read', 'inventory:read', 'consignments:read']);
  assert.ok(sc.every((s) => !/write/.test(s)));
});

test('live mode uses the official Lightspeed authorize URL', async () => {
  const env = makeEnv({ MOCK_LIGHTSPEED: 'false', LS_CLIENT_ID: 'abc', LS_CLIENT_SECRET: 'def' });
  const token = await signIn(env);
  const { url } = await (await call(env, '/oauth/start', { method: 'POST', token })).json();
  assert.ok(url.startsWith('https://secure.retail.lightspeed.app/connect?'));
  assert.equal((await call(env, '/mock/connect')).status, 404, 'mock is disabled in live mode');
});

test('live mode without a registered app refuses to start', async () => {
  const env = makeEnv({ MOCK_LIGHTSPEED: 'false' });
  const r = await call(env, '/oauth/start', { method: 'POST', token: await signIn(env) });
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /client ID is not configured/);
});

test('refuses to request write scopes even if configured', async () => {
  const env = makeEnv({ LS_SCOPES: 'products:read inventory:write' });
  const r = await call(env, '/oauth/start', { method: 'POST', token: await signIn(env) });
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /inventory:write/);
});

test('OAuth callback: approve connects, tokens encrypted, nothing leaks', async () => {
  const env = makeEnv();
  const token = await signIn(env);
  const back = await connect(env, token);
  assert.equal(back.origin + back.pathname, APP);
  assert.equal(back.searchParams.get('ls'), 'connected');
  const st = await status(env, token);
  assert.equal(st.state, 'connected');
  assert.equal(st.mode, 'mock');
  assert.equal(st.retailer, 'Mock store (test data)');
  assert.equal(st.outlets[0].name, 'Mock outlet (test data)');
  assert.deepEqual(st.missing, []);
  assert.ok(st.permissions.every((p) => p.granted));
  const row = await env.DB.prepare('SELECT * FROM connection').first();
  assert.ok(row.access_enc && !row.access_enc.includes('mock_at_'), 'access token encrypted');
  assert.ok(row.refresh_enc && !row.refresh_enc.includes('mock_rt_'), 'refresh token encrypted');
  const all = JSON.stringify(st) + (await auditText(env));
  assert.ok(!/mock_at_|mock_rt_|access_enc|refresh_enc/.test(all), 'no tokens in status or audit');
});

test('invalid authorisation: denied, bad state, replayed state, bad code, bad domain', async () => {
  const env = makeEnv();
  const token = await signIn(env);
  assert.equal((await connect(env, token, 'deny')).searchParams.get('ls'), 'denied');
  assert.equal((await status(env, token)).state, 'disconnected');

  const forged = await connect(env, token, 'approve', (cb) => cb.replace(/state=[^&]+/, 'state=forgedstate123'));
  assert.equal(forged.searchParams.get('ls'), 'invalid_state');

  // replay: use a real callback twice
  const s = await (await call(env, '/oauth/start', { method: 'POST', token })).json();
  const c = new URL(s.url); c.searchParams.set('mock_decision', 'approve');
  const cb = (await call(env, c.toString())).headers.get('location');
  assert.equal(new URL((await call(env, cb)).headers.get('location')).searchParams.get('ls'), 'connected');
  assert.equal(new URL((await call(env, cb)).headers.get('location')).searchParams.get('ls'), 'invalid_state');

  const badCode = await connect(env, token, 'approve', (u) => u.replace(/code=[^&]+/, 'code=nope'));
  assert.equal(badCode.searchParams.get('ls'), 'token_exchange');
  const badDomain = await connect(env, token, 'approve', (u) => u.replace(/domain_prefix=[^&]+/, 'domain_prefix=evil.com%2Fx'));
  assert.equal(badDomain.searchParams.get('ls'), 'invalid_callback');
  const a = await auditText(env);
  assert.match(a, /connect_denied/); assert.match(a, /connect_rejected/); assert.match(a, /connect_failed/);
});

test('expired state is rejected', async () => {
  const env = makeEnv();
  const token = await signIn(env);
  const back = await connect(env, token, 'approve', (cb) => { env.DB._raw.exec('UPDATE oauth_state SET expires_at = 0'); return cb; });
  // the state was aged past its 10-minute limit before the callback arrived
  assert.equal(back.searchParams.get('ls'), 'invalid_state');
});

test('token expiration triggers refresh with rotation', async () => {
  const env = makeEnv();
  const token = await signIn(env);
  await connect(env, token);
  const before = await env.DB.prepare('SELECT refresh_enc FROM connection').first();
  env.DB._raw.exec('UPDATE connection SET expires_at = 1'); // access token expired
  const r = await (await call(env, '/check', { method: 'POST', token })).json();
  assert.equal(r.ok, true);
  const after = await env.DB.prepare('SELECT refresh_enc, expires_at, last_refresh_at FROM connection').first();
  assert.notEqual(after.refresh_enc, before.refresh_enc, 'new refresh token stored');
  assert.ok(after.expires_at > Date.now() / 1000);
  assert.ok(after.last_refresh_at);
  const old = await env.DB.prepare("SELECT COUNT(*) AS n FROM mock_tokens WHERE kind='refresh' AND revoked=1").first();
  assert.equal(old.n, 1, 'old refresh token revoked by Lightspeed (mock)');
  assert.match(await auditText(env), /token_refreshed/);
});

test('valid token is not refreshed needlessly', async () => {
  const env = makeEnv();
  const token = await signIn(env);
  await connect(env, token);
  await call(env, '/check', { method: 'POST', token });
  assert.doesNotMatch(await auditText(env), /token_refreshed/);
});

test('revoked permissions: reconnect required', async () => {
  const env = makeEnv();
  const token = await signIn(env);
  await connect(env, token);
  env.DB._raw.exec('UPDATE mock_tokens SET revoked = 1'); // manager removed the app in Lightspeed
  const r = await (await call(env, '/check', { method: 'POST', token })).json();
  assert.equal(r.ok, false);
  const st = await status(env, token);
  assert.equal(st.state, 'reauth_required');
  assert.match(st.last_error, /reconnect/i);
  assert.equal((await (await call(env, '/public-status')).json()).state, 'not_connected');
  const row = await env.DB.prepare('SELECT access_enc, refresh_enc FROM connection').first();
  assert.equal(row.refresh_enc, null, 'dead tokens are removed');
  // reconnect works
  assert.equal((await connect(env, token)).searchParams.get('ls'), 'connected');
  assert.equal((await status(env, token)).state, 'connected');
});

test('missing permissions are detected and reported', async () => {
  const env = makeEnv();
  const token = await signIn(env);
  await connect(env, token, 'partial');
  const st = await status(env, token);
  assert.equal(st.state, 'connected');
  assert.deepEqual(st.missing, ['sales:read']);
  assert.equal(st.permissions.find((p) => p.scope === 'sales:read').granted, false);
  assert.match(await auditText(env), /Missing permissions: sales:read/);
});

test('API failure keeps the connection and reports the error', async () => {
  const env = makeEnv();
  const token = await signIn(env);
  await connect(env, token);
  env.MOCK_API_DOWN = 'true';
  const r = await (await call(env, '/check', { method: 'POST', token })).json();
  assert.equal(r.ok, false);
  assert.match(r.error, /503/);
  assert.equal(r.status.state, 'connected');
  assert.match(r.status.last_error, /503/);
  env.MOCK_API_DOWN = 'false';
  assert.equal((await (await call(env, '/check', { method: 'POST', token })).json()).ok, true);
});

test('network failure during token exchange (live mode)', async () => {
  const env = makeEnv({ MOCK_LIGHTSPEED: 'false', LS_CLIENT_ID: 'abc', LS_CLIENT_SECRET: 'def', __fetch: async () => { throw new Error('offline'); } });
  const token = await signIn(env);
  const { url } = await (await call(env, '/oauth/start', { method: 'POST', token })).json();
  const state = new URL(url).searchParams.get('state');
  const r = await call(env, '/oauth/callback?code=x&domain_prefix=somestore&state=' + state);
  assert.equal(new URL(r.headers.get('location')).searchParams.get('ls'), 'network');
});

test('live token request goes to the store domain, form-encoded, secret not in URL', async () => {
  let seen;
  const env = makeEnv({ MOCK_LIGHTSPEED: 'false', LS_CLIENT_ID: 'abc', LS_CLIENT_SECRET: 'def', __fetch: async (u, init) => {
    if (u.endsWith('/api/1.0/token')) { seen = { u, init }; return new Response(JSON.stringify({ access_token: 'A', refresh_token: 'R', expires_in: 3600, domain_prefix: 'somestore', scope: 'retailer:read' }), { status: 200 }); }
    return new Response('{}', { status: 403 });
  } });
  const token = await signIn(env);
  const { url } = await (await call(env, '/oauth/start', { method: 'POST', token })).json();
  const state = new URL(url).searchParams.get('state');
  await call(env, '/oauth/callback?code=c1&domain_prefix=somestore&state=' + state);
  assert.equal(seen.u, 'https://somestore.retail.lightspeed.app/api/1.0/token');
  assert.equal(seen.init.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.ok(!seen.u.includes('def'));
  const body = new URLSearchParams(seen.init.body);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('client_secret'), 'def');
  const st = await status(env, token);
  assert.equal(st.state, 'connected');
  assert.ok(st.missing.includes('sales:read'));
});

test('disconnect deletes tokens and is audited', async () => {
  const env = makeEnv();
  const token = await signIn(env);
  await connect(env, token);
  const st = await (await call(env, '/disconnect', { method: 'POST', token })).json();
  assert.equal(st.state, 'disconnected');
  const row = await env.DB.prepare('SELECT access_enc, refresh_enc FROM connection').first();
  assert.equal(row.access_enc, null); assert.equal(row.refresh_enc, null);
  assert.equal((await (await call(env, '/check', { method: 'POST', token })).json()).ok, false);
  const ev = (await (await call(env, '/audit', { token })).json()).events.map((e) => e.event);
  assert.ok(ev.includes('disconnected') && ev.includes('connected') && ev.includes('connect_started'));
});

test('CORS only for the Kush site', async () => {
  const env = makeEnv();
  const ok = await call(env, '/public-status', { origin: 'https://tamanitadiwa-coder.github.io' });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://tamanitadiwa-coder.github.io');
  const no = await call(env, '/public-status', { origin: 'https://evil.example' });
  assert.equal(no.headers.get('access-control-allow-origin'), null);
});

test('unreadable stored tokens lead to reconnect, not a crash', async () => {
  const env = makeEnv();
  const token = await signIn(env);
  await connect(env, token);
  env.TOKEN_KEY = 'a-different-key';
  env.DB._raw.exec('UPDATE connection SET expires_at = 9999999999');
  const r = await call(env, '/check', { method: 'POST', token });
  assert.equal(r.status, 200);
  assert.equal((await status(env, token)).state, 'reauth_required');
});
