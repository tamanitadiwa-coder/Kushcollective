// Small crypto helpers built on Web Crypto (available in Cloudflare Workers).

const te = new TextEncoder();
const td = new TextDecoder();

export const b64 = {
  enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))),
  dec: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};
const b64url = {
  enc: (buf) => b64.enc(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s) => b64.dec(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)),
};

export function randomId(bytes = 24) {
  return b64url.enc(crypto.getRandomValues(new Uint8Array(bytes)));
}

// ---- token encryption at rest (AES-256-GCM) ----
const AAD = te.encode('kush-lightspeed-v1');
async function aesKey(secret) {
  if (!secret) throw new Error('TOKEN_KEY is not configured');
  let raw = null;
  try { raw = b64.dec(secret); } catch { raw = null; }
  if (!raw || raw.length !== 32) raw = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(secret)));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encrypt(secret, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, await aesKey(secret), te.encode(text));
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv); out.set(new Uint8Array(ct), 12);
  return b64.enc(out);
}
export async function decrypt(secret, data) {
  const all = b64.dec(data);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12), additionalData: AAD }, await aesKey(secret), all.slice(12));
  return td.decode(pt);
}

// ---- HMAC ----
async function hmacKey(secret) {
  if (!secret) throw new Error('SESSION_KEY is not configured');
  return crypto.subtle.importKey('raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}
async function hmac(secret, text) {
  return new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), te.encode(text)));
}
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

// Constant-time comparison of two strings (compares their HMACs).
export async function safeEqual(secret, a, b) {
  return sameBytes(await hmac(secret, 'cmp:' + a), await hmac(secret, 'cmp:' + b));
}

// ---- manager session tokens ----
export async function signSession(secret, payload) {
  const body = b64url.enc(te.encode(JSON.stringify(payload)));
  return body + '.' + b64url.enc(await hmac(secret, body));
}
export async function verifySession(secret, token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  let given;
  try { given = b64url.dec(sig); } catch { return null; }
  if (!sameBytes(given, await hmac(secret, body))) return null;
  let p;
  try { p = JSON.parse(td.decode(b64url.dec(body))); } catch { return null; }
  if (!p || typeof p.exp !== 'number' || p.exp < Math.floor(Date.now() / 1000)) return null;
  return p;
}
