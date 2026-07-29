import { describe, it, expect } from 'vitest';
import {
  hashPassword, verifyPassword, signJWT, verifyJWT, getUser,
  setAuthCookie, clearAuthCookie, sha256Hex, type JWTPayload,
} from '../src/lib/auth';

const SECRET = 'test-secret';

function payload(overrides: Partial<JWTPayload> = {}): JWTPayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: 'user-1',
    email: 'admin@example.edu',
    name: 'Admin',
    role: 'super_admin',
    tv: 0,
    iat: now,
    exp: now + 3600,
    ...overrides,
  };
}

describe('password hashing', () => {
  it('round-trips a correct password', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', stored)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse batter', stored)).toBe(false);
  });

  it('salts, so the same password hashes differently each time', async () => {
    const a = await hashPassword('same password');
    const b = await hashPassword('same password');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same password', a)).toBe(true);
    expect(await verifyPassword('same password', b)).toBe(true);
  });

  it('rejects malformed stored hashes instead of throwing', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', 'pbkdf2:only-two-parts')).toBe(false);
    expect(await verifyPassword('x', 'pbkdf2:!!!not-base64!!!:zzz')).toBe(false);
  });
});

describe('JWT', () => {
  it('round-trips a payload', async () => {
    const p = payload();
    const decoded = await verifyJWT(await signJWT(p, SECRET), SECRET);
    expect(decoded?.sub).toBe('user-1');
    expect(decoded?.role).toBe('super_admin');
    expect(decoded?.tv).toBe(0);
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signJWT(payload(), SECRET);
    expect(await verifyJWT(token, 'other-secret')).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    const token = await signJWT(payload({ role: 'coach' }), SECRET);
    const [header, , sig] = token.split('.');
    const forged = btoa(JSON.stringify(payload({ role: 'super_admin' })))
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    expect(await verifyJWT(`${header}.${forged}.${sig}`, SECRET)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT(payload({ iat: now - 7200, exp: now - 60 }), SECRET);
    expect(await verifyJWT(token, SECRET)).toBeNull();
  });

  it('rejects structurally invalid tokens', async () => {
    expect(await verifyJWT('', SECRET)).toBeNull();
    expect(await verifyJWT('a.b', SECRET)).toBeNull();
    expect(await verifyJWT('a.b.c.d', SECRET)).toBeNull();
  });

  it('carries the token version, which is what makes session revocation possible', async () => {
    const decoded = await verifyJWT(await signJWT(payload({ tv: 7 }), SECRET), SECRET);
    expect(decoded?.tv).toBe(7);
  });
});

describe('getUser', () => {
  const withCookie = (cookie: string) =>
    new Request('https://portal.example.test/api/requests', { headers: { Cookie: cookie } });

  it('reads the token from the auth cookie', async () => {
    const token = await signJWT(payload(), SECRET);
    const user = await getUser(withCookie(`auth_token=${token}`), SECRET);
    expect(user?.sub).toBe('user-1');
  });

  it('finds the cookie alongside others', async () => {
    const token = await signJWT(payload(), SECRET);
    const user = await getUser(withCookie(`other=1; auth_token=${token}; another=2`), SECRET);
    expect(user?.sub).toBe('user-1');
  });

  it('returns null with no cookie at all', async () => {
    const req = new Request('https://portal.example.test/api/requests');
    expect(await getUser(req, SECRET)).toBeNull();
  });

  it('returns null for a garbage cookie value', async () => {
    expect(await getUser(withCookie('auth_token=garbage'), SECRET)).toBeNull();
  });
});

describe('auth cookie flags', () => {
  it('sets HttpOnly, SameSite=Strict, and Secure over HTTPS', () => {
    const cookie = setAuthCookie('tok', true);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Secure');
  });

  it('omits Secure over plain HTTP so local development works', () => {
    expect(setAuthCookie('tok', false)).not.toContain('Secure');
  });

  it('expires the cookie on clear', () => {
    expect(clearAuthCookie()).toContain('Max-Age=0');
  });
});

describe('sha256Hex', () => {
  it('produces a stable 64-character lowercase digest', async () => {
    const digest = await sha256Hex('reset-token-value');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex('reset-token-value')).toBe(digest);
  });

  it('produces different digests for different inputs', async () => {
    expect(await sha256Hex('a')).not.toBe(await sha256Hex('b'));
  });
});
