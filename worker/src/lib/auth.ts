import { SignJWT, jwtVerify } from 'jose';

export interface SessionUser {
  email: string;
  displayName: string;
  role: string;
  adminSportIds?: string[];
}

const COOKIE_NAME = 'session';
const ALGORITHM  = 'HS256';
const TTL_SECONDS = 60 * 60 * 8; // 8 hours

function secretKey(jwtSecret: string): Uint8Array {
  return new TextEncoder().encode(jwtSecret);
}

export async function createSessionCookie(user: SessionUser, jwtSecret: string): Promise<string> {
  const token = await new SignJWT({ ...user })
    .setProtectedHeader({ alg: ALGORITHM })
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(secretKey(jwtSecret));

  const expires = new Date(Date.now() + TTL_SECONDS * 1000).toUTCString();
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Secure; Expires=${expires}`;
}

export async function getSessionUser(request: Request, jwtSecret: string): Promise<SessionUser | null> {
  const cookie = request.headers.get('Cookie') ?? '';
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (!match) return null;

  try {
    const { payload } = await jwtVerify(match[1], secretKey(jwtSecret));
    return payload as unknown as SessionUser;
  } catch {
    return null;
  }
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`;
}

// Password hashing using Web Crypto PBKDF2
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key,
    256,
  );
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
  const hashHex = Array.from(new Uint8Array(derived)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${saltHex}:${hashHex}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key,
    256,
  );
  const computedHex = Array.from(new Uint8Array(derived)).map(b => b.toString(16).padStart(2, '0')).join('');
  return computedHex === hashHex;
}
