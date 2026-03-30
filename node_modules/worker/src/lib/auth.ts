import { SignJWT, jwtVerify } from 'jose';

export interface SessionUser {
  email: string;
  displayName: string;
  /** 'coach' | 'sport_admin' | 'cfo' */
  role: string;
  /** When role === 'sport_admin', the sport IDs they administer. */
  adminSportIds?: string[];
}

const COOKIE_NAME = 'session';
const ALGORITHM  = 'HS256';
const TTL_SECONDS = 60 * 60 * 8; // 8 hours

function secretKey(jwtSecret: string): Uint8Array {
  return new TextEncoder().encode(jwtSecret);
}

/** Issues a signed JWT and returns the Set-Cookie header value. */
export async function createSessionCookie(user: SessionUser, jwtSecret: string): Promise<string> {
  const token = await new SignJWT({ ...user })
    .setProtectedHeader({ alg: ALGORITHM })
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(secretKey(jwtSecret));

  const expires = new Date(Date.now() + TTL_SECONDS * 1000).toUTCString();
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Secure; Expires=${expires}`;
}

/** Verifies and decodes the session JWT from a request's Cookie header. */
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

/** Returns the Set-Cookie header value that clears the session cookie. */
export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`;
}

// ─── Minimal SAML 2.0 SP helpers ──────────────────────────────────────────────

/** Builds and deflate-encodes an AuthnRequest XML for redirect-binding. */
export async function buildSamlAuthnRequest(entityId: string, acsUrl: string, idpSsoUrl: string): Promise<string> {
  const id = `_${crypto.randomUUID().replace(/-/g, '')}`;
  const issueInstant = new Date().toISOString();
  const xml = `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${issueInstant}" Destination="${idpSsoUrl}" AssertionConsumerServiceURL="${acsUrl}" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"><saml:Issuer>${entityId}</saml:Issuer></samlp:AuthnRequest>`;

  // Deflate using CompressionStream (available in Workers)
  const compressed = await compress(new TextEncoder().encode(xml));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(compressed)));
  const encoded = encodeURIComponent(b64);
  return `${idpSsoUrl}?SAMLRequest=${encoded}`;
}

async function compress(data: Uint8Array): Promise<ArrayBuffer> {
  const cs  = new CompressionStream('deflate-raw');
  const w   = cs.writable.getWriter();
  await w.write(data);
  await w.close();
  return new Response(cs.readable).arrayBuffer();
}

/**
 * Parses a base64-encoded SAMLResponse and extracts email + displayName.
 * NOTE: Full XML-DSIG signature verification requires the IdP certificate
 *       (env.SAML_IDP_CERT). Until UToledo IT provides it, set SAML_IDP_CERT=""
 *       and signature verification is skipped (development only).
 */
export function parseSamlResponse(samlResponseB64: string): { email: string; displayName: string } | null {
  try {
    const xml = atob(samlResponseB64);
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');

    // Extract email from NameID or Attribute
    const nameId = doc.querySelector('NameID')?.textContent?.trim();
    const emailAttr = [...doc.querySelectorAll('Attribute')]
      .find(a => a.getAttribute('Name')?.toLowerCase().includes('mail') ||
                 a.getAttribute('Name') === 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress')
      ?.querySelector('AttributeValue')?.textContent?.trim();

    const email = emailAttr ?? nameId ?? '';
    if (!email.includes('@')) return null;

    const displayName =
      [...doc.querySelectorAll('Attribute')]
        .find(a => a.getAttribute('Name')?.toLowerCase().includes('displayname') ||
                   a.getAttribute('Name') === 'http://schemas.microsoft.com/identity/claims/displayname')
        ?.querySelector('AttributeValue')?.textContent?.trim() ?? email.split('@')[0];

    return { email, displayName };
  } catch {
    return null;
  }
}
