export interface JWTPayload {
  sub: string;
  email: string;
  name: string;
  role: 'coach' | 'sport_admin' | 'cfo' | 'super_admin';
  sportId?: string;
  /**
   * Token version. Mirrors `users.token_version`; a mismatch means the account's
   * sessions were revoked (password change/reset, rejection) since this token was
   * issued. Absent on anonymous coach tokens, which have no user row.
   */
  tv?: number;
  iat: number;
  exp: number;
}

// ── Hashing helpers ───────────────────────────────────────────────────────────

/** Lowercase hex SHA-256. Used to store password-reset tokens as digests. */
export async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Password hashing (PBKDF2 via Web Crypto) ─────────────────────────────────

export async function hashPassword(password: string): Promise<string> {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 },
    keyMaterial, 256
  );
  const saltB64 = btoa(String.fromCharCode(...salt));
  const hashB64 = btoa(String.fromCharCode(...new Uint8Array(bits)));
  return `pbkdf2:${saltB64}:${hashB64}`;
}

/** Length-independent, constant-time string compare (no early exit on first diff). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'pbkdf2') return false;
  const [, saltB64, hashB64] = parts;
  let salt: Uint8Array;
  try {
    salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
  } catch {
    return false; // malformed stored hash
  }
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 },
    keyMaterial, 256
  );
  const computed = btoa(String.fromCharCode(...new Uint8Array(bits)));
  return timingSafeEqual(computed, hashB64);
}

// ── JWT (HMAC-SHA256, no library) ─────────────────────────────────────────────

function b64url(str: string): string {
  return btoa(str).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export async function signJWT(payload: JWTPayload, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return `${data}.${b64urlEncode(new Uint8Array(sig))}`;
}

export async function verifyJWT(token: string, secret: string): Promise<JWTPayload | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sigB64] = parts;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const sigBytes = Uint8Array.from(
      atob(sigB64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)
    );
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(`${header}.${body}`));
    if (!valid) return null;
    const payload = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/'))) as JWTPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function getUser(request: Request, secret: string): Promise<JWTPayload | null> {
  const cookie = request.headers.get('Cookie') ?? '';
  const match = cookie.match(/(?:^|;\s*)auth_token=([^;]+)/);
  if (!match) return null;
  return verifyJWT(match[1], secret);
}

// Student health data warrants strict cookie handling (FERPA/HIPAA alignment, 3.4):
// HttpOnly keeps the token out of JS, SameSite=Strict blocks cross-site sending, and
// Secure restricts it to HTTPS. The SPA re-validates via same-origin /auth/me, and a
// client-side inactivity timer signs idle users out well before the cookie expires.
export function setAuthCookie(token: string, secure: boolean): string {
  const flags = [
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${60 * 60 * 24 * 7}`, // 7 days
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
  return `auth_token=${token}; ${flags}`;
}

export function clearAuthCookie(): string {
  return 'auth_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0';
}
