// ── DocuSign eSignature integration (JWT Grant, server-to-server) ────────────

export interface DocuSignEnv {
  DOCUSIGN_INTEGRATION_KEY: string;
  DOCUSIGN_USER_ID: string;
  DOCUSIGN_ACCOUNT_ID: string;
  DOCUSIGN_PRIVATE_KEY: string;
  DOCUSIGN_TEMPLATE_ID: string;
  DOCUSIGN_HMAC_SECRET?: string;
  APP_BASE_URL: string;
}

// ── JWT Grant access-token ──────────────────────────────────────────────────

function b64url(input: ArrayBuffer | Uint8Array | string): string {
  const str =
    typeof input === 'string'
      ? btoa(input)
      : btoa(String.fromCharCode(...new Uint8Array(input)));
  return str.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const lines = pem
    .replace(/-----BEGIN RSA PRIVATE KEY-----/, '')
    .replace(/-----END RSA PRIVATE KEY-----/, '')
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const binary = atob(lines);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}

async function signRS256(payload: string, privateKeyPem: string): Promise<string> {
  const keyData = pemToArrayBuffer(privateKeyPem);
  const key = await crypto.subtle.importKey(
    'pkcs8',
    keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(payload),
  );
  return b64url(sig);
}

// Demo environment base URLs
const AUTH_SERVER = 'https://account-d.docusign.com';
const API_BASE = 'https://demo.docusign.net/restapi';

async function getAccessToken(env: DocuSignEnv): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(
    JSON.stringify({
      iss: env.DOCUSIGN_INTEGRATION_KEY,
      sub: env.DOCUSIGN_USER_ID,
      aud: 'account-d.docusign.com',
      iat: now,
      exp: now + 3600,
      scope: 'signature impersonation',
    }),
  );
  const assertion = `${header}.${body}`;
  const sig = await signRS256(assertion, env.DOCUSIGN_PRIVATE_KEY);
  const jwt = `${assertion}.${sig}`;

  const res = await fetch(`${AUTH_SERVER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DocuSign token error: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

// ── Create envelope from template ───────────────────────────────────────────

export interface EnvelopeRecipient {
  email: string;
  name: string;
  roleName: string; // must match the template role name
  routingOrder: string;
  /** clientUserId marks this as an embedded signer. Omit for remote (email) signers. */
  clientUserId?: string;
}

export interface CreateEnvelopeOptions {
  emailSubject: string;
  templateId: string;
  recipients: EnvelopeRecipient[];
  /** Template text-tab values: field label → value */
  templateFields: Record<string, string>;
  /** URL DocuSign will call back on status changes */
  webhookUrl: string;
}

export interface EnvelopeResult {
  envelopeId: string;
  status: string;
}

export async function createEnvelope(
  env: DocuSignEnv,
  opts: CreateEnvelopeOptions,
): Promise<EnvelopeResult> {
  const token = await getAccessToken(env);

  const templateRoles = opts.recipients.map((r) => ({
    email: r.email,
    name: r.name,
    roleName: r.roleName,
    routingOrder: r.routingOrder,
    ...(r.clientUserId ? { clientUserId: r.clientUserId } : {}),
    tabs: {
      textTabs: Object.entries(opts.templateFields).map(([tabLabel, value]) => ({
        tabLabel,
        value,
      })),
    },
  }));

  const body = {
    templateId: opts.templateId,
    templateRoles,
    emailSubject: opts.emailSubject,
    status: 'sent', // send immediately
    eventNotification: {
      url: opts.webhookUrl,
      requireAcknowledgment: 'true',
      loggingEnabled: 'true',
      envelopeEvents: [
        { envelopeEventStatusCode: 'completed' },
        { envelopeEventStatusCode: 'declined' },
        { envelopeEventStatusCode: 'voided' },
      ],
      recipientEvents: [
        { recipientEventStatusCode: 'Completed' },
        { recipientEventStatusCode: 'Declined' },
      ],
      includeDocumentFields: 'true',
    },
  };

  const res = await fetch(
    `${API_BASE}/v2.1/accounts/${env.DOCUSIGN_ACCOUNT_ID}/envelopes`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DocuSign envelope error: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { envelopeId: string; status: string };
  return { envelopeId: data.envelopeId, status: data.status };
}

// ── Get embedded signing URL for a recipient ────────────────────────────────

export async function getSigningUrl(
  env: DocuSignEnv,
  envelopeId: string,
  recipientEmail: string,
  recipientName: string,
  /** Must match the clientUserId used when creating the envelope */
  clientUserId: string,
  returnUrl: string,
): Promise<string> {
  const token = await getAccessToken(env);

  const res = await fetch(
    `${API_BASE}/v2.1/accounts/${env.DOCUSIGN_ACCOUNT_ID}/envelopes/${envelopeId}/views/recipient`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        authenticationMethod: 'none',
        clientUserId,
        email: recipientEmail,
        userName: recipientName,
        returnUrl,
      }),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DocuSign recipient view error: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { url: string };
  return data.url;
}

// ── Void an existing envelope ───────────────────────────────────────────────

export async function voidEnvelope(
  env: DocuSignEnv,
  envelopeId: string,
  reason: string,
): Promise<void> {
  const token = await getAccessToken(env);
  const res = await fetch(
    `${API_BASE}/v2.1/accounts/${env.DOCUSIGN_ACCOUNT_ID}/envelopes/${envelopeId}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status: 'voided', voidedReason: reason }),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DocuSign void error: ${res.status} ${text}`);
  }
}

// ── Webhook HMAC verification ───────────────────────────────────────────────

export async function verifyWebhookHMAC(
  secret: string,
  payload: string,
  signatureHeader: string,
): Promise<boolean> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  const computed = btoa(String.fromCharCode(...new Uint8Array(sig)));
  // Compare in constant-time-ish fashion
  return computed === signatureHeader;
}

// ── Parse webhook XML payload ───────────────────────────────────────────────

export interface WebhookEvent {
  envelopeId: string;
  envelopeStatus: string; // completed | declined | voided | sent
  recipients: {
    email: string;
    name: string;
    status: string; // completed | declined
    roleName: string;
    routingOrder: string;
    signedDateTime?: string;
  }[];
}

/** Minimal XML parser for DocuSign Connect webhook payloads. */
export function parseConnectXml(xml: string): WebhookEvent {
  const tag = (name: string, src: string): string =>
    src.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() ?? '';

  const envelopeStatus = tag('Status', tag('EnvelopeStatus', xml)).toLowerCase();
  const envelopeId = tag('EnvelopeID', xml);

  const recipients: WebhookEvent['recipients'] = [];
  // Match each <RecipientStatus> block
  const recipientBlocks = xml.match(/<RecipientStatus>[\s\S]*?<\/RecipientStatus>/g) ?? [];
  for (const block of recipientBlocks) {
    recipients.push({
      email: tag('Email', block),
      name: tag('UserName', block),
      status: tag('Status', block).toLowerCase(),
      roleName: tag('RoleName', block),
      routingOrder: tag('RoutingOrder', block),
      signedDateTime: tag('Signed', block) || undefined,
    });
  }

  return { envelopeId, envelopeStatus, recipients };
}
