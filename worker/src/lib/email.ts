function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface Env {
  DB: D1Database;
  RESEND_API_KEY?: string;
  FROM_NAME?: string;
  FROM_EMAIL: string;
  /** Monitored mailbox for replies. Mail with no reply path scores badly with filters. */
  REPLY_TO_EMAIL?: string;
  APP_BASE_URL: string;
  /**
   * Last-resort recipient when no active CFO account exists, and the visible contact in
   * every footer. A role address, never a person: getCfoEmails() returns [] on an empty
   * roster and notifyPendingCFO would otherwise send to nobody, silently.
   */
  FALLBACK_NOTIFICATION_EMAIL: string;

  /**
   * Forces the mail mode regardless of app_settings. Set on env.preview so a preview
   * build cannot mail anyone — as a var it survives someone adding RESEND_API_KEY and
   * survives restoring a production database into the preview D1.
   */
  MAIL_LOCKED_MODE?: string;
  MAIL_TEST_ADDRESS?: string;
  /** Stamped by getConfiguredEnv so the normal path costs no extra D1 read. */
  MAIL_POLICY?: MailPolicy;
}

export interface EmailData {
  studentName: string;
  rocketNumber: string;
  studentEmail?: string;
  sport: string;
  sportName: string;
  term: string;
  premiumCost: number;
  fundingSource?: string; // operating_budget | foundation_account
  coachName: string;
  coachEmail: string;
  requestId: string;
  status: string;
  sportAdminName?: string;
  sportAdminEmail?: string;
  sportAdminEmails?: string[]; // all admins assigned to the sport (fan-out)
  headCoachName?: string;
  headCoachEmail?: string;
  cfoEmails?: string[]; // resolved from active CFO users, not a hardcoded env var
  voidReason?: string;
  denialReason?: string;
  submissionDeadline?: string; // human-readable deadline (PDF / display)
  submissionDeadlineISO?: string; // YYYY-MM-DD, parsed deterministically for the .ics reminder
}

export interface EmailAttachment {
  filename: string;
  /** base64-encoded file content */
  content: string;
}

function fundingSourceLabel(source?: string): string {
  return source === 'foundation_account' ? 'Foundation Account' : 'operating budget';
}

function actionUrl(env: Env, requestId: string): string {
  return `${env.APP_BASE_URL.replace(/\/$/, '')}/request/${requestId}`;
}

/** Chunked base64 encoder — avoids call-stack limits on large PDF buffers. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ── Message construction ──────────────────────────────────────────────────────
//
// Deliverability notes. UToledo runs Exchange Online, which accepts a message at the
// MX (so the provider reports success) and then quarantines it silently. Several
// properties of the original templates read as phishing to Microsoft Defender and are
// deliberately avoided here:
//
//   - HTML-only bodies. Every message now carries a matching text/plain part.
//   - No reply path. A Reply-To pointing at a monitored mailbox is set when configured.
//   - Bracketed urgency prefixes such as "[Action Required]" in the subject line.
//   - A bare call-to-action button with no visible destination. The full URL is now
//     printed next to the button so a recipient (and a filter) can see where it goes.
//   - Calendar attachments on first contact from an unrecognised sender. The .ics is
//     still generated but is offered as a download in the portal instead.
//
// The remaining half of the fix is DNS: SPF, DKIM, and strictly aligned DMARC on a
// dedicated sending subdomain. See EMAIL_SETUP.md.

// Two footers, because one sentence cannot honestly describe both kinds of message.
// Telling someone resetting a password that they are "named on this insurance request"
// is false, and on a mail that already asks them to click a link and change a credential
// it reads exactly like the incoherence a phishing filter is looking for.
const FOOTER_REQUEST =
  'University of Toledo Athletics, Health Insurance Request System. '
  + 'You are receiving this because you are named on this insurance request.';

const FOOTER_ACCOUNT =
  'University of Toledo Athletics, Health Insurance Request System. '
  + 'You are receiving this because an account exists for this address.';

// Brand tokens, matching lib/pdf.ts so a notification and the authorization PDF it links
// to are visibly the same document. That shared letterhead is the point: a recipient who
// has seen one recognises the other, which is worth more from a three-week-old domain
// than any amount of styling.
const NAVY = '#0B223F';
const GOLD = '#FFC72C';
const INK = '#1A1A1A';
const MUTED = '#555555';
const RULE = '#CED4DA';
const FILL = '#F1F3F5';
const CANVAS = '#EEF1F5';

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/**
 * Message chrome: navy letterhead, gold rule, white record card, quiet footer.
 *
 * Written for Outlook, which renders through Word and supports neither flexbox nor grid,
 * so structure is tables and every colour is set with both a `bgcolor` attribute and CSS.
 * Remote images are blocked by default in most clients, so the letterhead is a background
 * colour with the logo placed on top rather than an image of a letterhead — blocked, it
 * degrades to a navy band with alt text instead of a white gap.
 *
 * Restraint here is deliverability, not taste. The text/plain part, the visible URL beside
 * the button, and the absence of attachments are what earned an SCL of 1 against Exchange
 * Online; a heavier, image-led design would put that back at risk. See EMAIL_SETUP.md.
 */
function emailHtml(
  env: Env, title: string, body: string, actionLink?: string, actionLabel?: string,
  footer: string = FOOTER_REQUEST,
): string {
  const base = env.APP_BASE_URL.replace(/\/$/, '');
  const replyTo = env.REPLY_TO_EMAIL || env.FALLBACK_NOTIFICATION_EMAIL;
  const cell = `font-family:${FONT};color:${INK};font-size:15px;line-height:1.6`;

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(title)}</title>
<style>
  /* Progressive enhancement only — every rule below is duplicated inline for clients
     that discard the style block entirely. */
  a{color:${NAVY}}
  @media (max-width:620px){
    .shell{padding:0!important}
    .pad{padding:24px 20px!important}
    .band{padding:20px!important}
  }
</style>
</head>
<body style="margin:0;padding:0;background:${CANVAS};-webkit-text-size-adjust:100%" bgcolor="${CANVAS}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${CANVAS}" style="background:${CANVAS}">
<tr><td class="shell" align="center" style="padding:28px 12px">

<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;border-collapse:collapse;border:1px solid ${RULE}">

  <!-- Letterhead -->
  <tr><td class="band" bgcolor="${NAVY}" style="background:${NAVY};padding:24px 32px">
    <img src="${base}/logo-dark.png" width="168" alt="University of Toledo Athletics"
         style="display:block;width:168px;max-width:168px;height:auto;border:0;outline:none;text-decoration:none">
    <div style="font-family:${FONT};color:${GOLD};font-size:11px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;padding-top:14px">
      Athletics Business Office
    </div>
    <div style="font-family:${FONT};color:#C6D2E2;font-size:12px;letter-spacing:.3px;padding-top:3px">
      Student-Athlete Health Insurance
    </div>
  </td></tr>

  <!-- Gold rule -->
  <tr><td bgcolor="${GOLD}" height="4" style="background:${GOLD};height:4px;line-height:4px;font-size:0">&nbsp;</td></tr>

  <!-- Record -->
  <tr><td class="pad" bgcolor="#FFFFFF" style="background:#FFFFFF;padding:32px">
    <h1 style="margin:0 0 18px;font-family:${FONT};color:${NAVY};font-size:21px;line-height:1.3;font-weight:700">${escapeHtml(title)}</h1>
    <div style="${cell}">${body}</div>
${actionLink ? `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 14px">
      <tr><td bgcolor="${NAVY}" style="background:${NAVY};padding:13px 28px">
        <a href="${actionLink}" style="font-family:${FONT};color:#FFFFFF;font-size:15px;font-weight:600;text-decoration:none;display:inline-block">${escapeHtml(actionLabel ?? 'View request')}</a>
      </td></tr>
    </table>
    <p style="margin:0;font-family:${FONT};color:${MUTED};font-size:13px;line-height:1.55">
      If the button does not work, open this address:<br>
      <span style="word-break:break-all;color:${NAVY}">${escapeHtml(actionLink)}</span>
    </p>` : ''}
  </td></tr>

  <!-- Footer -->
  <tr><td bgcolor="${FILL}" style="background:${FILL};padding:20px 32px;border-top:1px solid ${RULE}">
    <p style="margin:0 0 6px;font-family:${FONT};color:${MUTED};font-size:12px;line-height:1.55">${escapeHtml(footer)}</p>
    <p style="margin:0;font-family:${FONT};color:${MUTED};font-size:12px;line-height:1.55">
      Questions: <a href="mailto:${escapeHtml(replyTo)}" style="color:${NAVY}">${escapeHtml(replyTo)}</a>
    </p>
  </td></tr>

</table>

</td></tr></table>
</body></html>`;
}

/**
 * Plain-text counterpart, built from the same inputs as the HTML rather than by
 * stripping tags, so the two parts cannot drift apart.
 */
function emailText(
  env: Env, title: string, lines: string[], actionLink?: string,
  actionLabel: string = 'Open the request', footer: string = FOOTER_REQUEST,
): string {
  const out = [title, '', ...lines];
  if (actionLink) out.push('', `${actionLabel}: ${actionLink}`);
  out.push('', '---', footer, `Questions: ${env.REPLY_TO_EMAIL || env.FALLBACK_NOTIFICATION_EMAIL}`);
  return out.join('\n');
}

/**
 * The request as a record, styled to match the boxed data fields on the authorization
 * PDF: a stated label above its value rather than a two-column grid, because at phone
 * width a 40/60 split wraps the value into a column two words wide.
 */
/**
 * A boxed record: each label stated above its value rather than beside it. The two-column
 * version wrapped the value into a column two words wide on a phone, and the stacked form
 * also matches how the fields read on the authorization PDF.
 *
 * `value` is trusted HTML so callers can emphasise inside a field; every caller escapes
 * its own interpolations.
 */
function recordTable(pairs: [label: string, value: string][]): string {
  const label = `font-family:${FONT};color:${MUTED};font-size:10px;font-weight:700;letter-spacing:1.1px;text-transform:uppercase;padding:10px 14px 0`;
  const value = `font-family:${FONT};color:${INK};font-size:15px;line-height:1.45;padding:2px 14px 11px`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${FILL}" style="width:100%;border-collapse:collapse;background:${FILL};border:1px solid ${RULE};margin:18px 0">
${pairs.map(([l, v]) => `<tr><td style="${label}">${escapeHtml(l)}</td></tr><tr><td style="${value}">${v}</td></tr>`).join('\n')}
</table>`;
}

function detailsTable(d: EmailData): string {
  const rows: [string, string][] = [
    ['Student-Athlete', escapeHtml(d.studentName)],
    ['Rocket Number', escapeHtml(d.rocketNumber)],
    ['Sport', escapeHtml(d.sportName)],
    ['Term', escapeHtml(d.term)],
    ['Premium', `<strong style="color:${NAVY};font-size:17px">$${d.premiumCost.toFixed(2)}</strong>`
      + `<span style="color:${MUTED};font-size:13px"> &middot; ${escapeHtml(fundingSourceLabel(d.fundingSource))}</span>`],
    ['Requesting Coach', `${escapeHtml(d.coachName)}`
      + (d.coachEmail ? `<span style="color:${MUTED};font-size:13px"><br>${escapeHtml(d.coachEmail)}</span>` : '')],
  ];
  if (d.submissionDeadline) rows.push(['Submission Deadline', escapeHtml(d.submissionDeadline)]);
  return recordTable(rows);
}

/** The same details as detailsTable, for the text/plain part. */
function detailsLines(d: EmailData): string[] {
  const lines = [
    `Student-Athlete: ${d.studentName}`,
    `Rocket Number: ${d.rocketNumber}`,
    `Sport: ${d.sportName}`,
    `Term: ${d.term}`,
    `Premium Cost: $${d.premiumCost.toFixed(2)}, to be deducted from the ${fundingSourceLabel(d.fundingSource)}`,
    `Requesting Coach: ${d.coachName}${d.coachEmail ? ` (${d.coachEmail})` : ''}`,
  ];
  if (d.submissionDeadline) lines.push(`Submission Deadline: ${d.submissionDeadline}`);
  return lines;
}

// ── Send + delivery log ───────────────────────────────────────────────────────

interface SendOptions {
  attachments?: EmailAttachment[];
  /** Correlates the log row with a request. Omitted for password resets. */
  requestId?: string;
  /** Template name recorded in email_log, e.g. "notifyPendingHeadCoach". */
  template: string;
}

/**
 * Persist one row per recipient per send.
 *
 * Delivery to utoledo.edu is unreliable and a 200 from the provider only means the
 * receiving MX accepted the message. Without a durable record there is no way to answer
 * "did the head coach get it", which is exactly the question that comes up when an
 * approval stalls. Logging must never break a send, so failures here are swallowed.
 */
async function logEmail(
  env: Env, to: string, subject: string, template: string,
  status: 'sent' | 'failed' | 'skipped' | 'suppressed',
  providerId?: string | null, error?: string | null, requestId?: string,
  redirectedTo?: string | null,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO email_log (id, request_id, to_email, subject, template, provider_id, status, error, redirected_to)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(), requestId ?? null, to, subject, template,
      providerId ?? null, status, error ? error.slice(0, 1000) : null,
      redirectedTo ?? null,
    ).run();
  } catch (e) {
    console.warn(`[email] log write failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── Mail safety mode ──────────────────────────────────────────────────────────

export type MailMode = 'live' | 'redirect' | 'suppress';

export interface MailPolicy {
  mode: MailMode;
  /** Sole recipient in redirect mode. Empty otherwise. */
  testAddress: string;
  /** Why the effective mode differs from the stored one, recorded in email_log. */
  reason: string | null;
  /** True when env.MAIL_LOCKED_MODE forced it and Settings cannot loosen it. */
  locked: boolean;
}

export const MAIL_MODES: MailMode[] = ['live', 'redirect', 'suppress'];

const MAIL_ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Decide what sendEmail is allowed to do. This function must never throw.
 *
 * sendEmail only wraps the provider fetch in try/catch, so a throw before that point
 * escapes to deferNotify's handler and produces no email_log row at all — a silent hole
 * exactly like the one this feature exists to close. Every failure path below therefore
 * resolves to `suppress`, which is the safe direction: worst case mail stops and the
 * reason is written to the log where someone can see it.
 *
 * Precedence:
 *   1. env.MAIL_LOCKED_MODE   — a var, so Settings cannot loosen it and neither can
 *                               restoring a production database into preview.
 *   2. app_settings.mail_mode — the operator's choice, default live.
 *   3. a lapsed expiry reverts to live.
 *   4. redirect with no valid test address degrades to suppress. It fails closed.
 */
export async function resolveMailPolicy(env: Env): Promise<MailPolicy> {
  try {
    if (env.MAIL_POLICY) return env.MAIL_POLICY;

    const locked = (env.MAIL_LOCKED_MODE ?? '').trim() as MailMode;
    if (MAIL_MODES.includes(locked)) {
      return {
        mode: locked, testAddress: (env.MAIL_TEST_ADDRESS ?? '').trim(),
        reason: 'Locked by MAIL_LOCKED_MODE', locked: true,
      };
    }

    const { results } = await env.DB.prepare(
      `SELECT setting_key, setting_value FROM app_settings
       WHERE setting_key IN ('mail_mode', 'mail_test_address', 'mail_mode_expires_at')`
    ).all<{ setting_key: string; setting_value: string }>();
    const map = new Map(results.map(r => [r.setting_key, r.setting_value]));

    const stored = (map.get('mail_mode') ?? 'live').trim() as MailMode;
    let mode: MailMode = MAIL_MODES.includes(stored) ? stored : 'live';
    const testAddress = (map.get('mail_test_address') ?? '').trim();
    let reason: string | null = null;

    const expiresAt = (map.get('mail_mode_expires_at') ?? '').trim();
    if (mode !== 'live' && expiresAt && Date.parse(expiresAt) <= Date.now()) {
      return { mode: 'live', testAddress: '', reason: 'Test mode expired', locked: false };
    }

    if (mode === 'redirect' && !MAIL_ADDRESS_RE.test(testAddress)) {
      mode = 'suppress';
      reason = 'Redirect mode has no valid test address — suppressed rather than delivered';
    }

    return { mode, testAddress, reason, locked: false };
  } catch (e) {
    return {
      mode: 'suppress', testAddress: '', locked: false,
      reason: `Mail policy unavailable: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

function redirectBannerHtml(intended: string[], testAddress: string): string {
  return `<div style="background:#FFF4CE;border-bottom:2px solid #C9A227;padding:12px 16px;`
    + `font-family:${FONT};font-size:13px;line-height:1.5;color:#4A3B00">`
    + `<strong>Test mode.</strong> This portal is redirecting mail to `
    + `${escapeHtml(testAddress)}. In production this message would have gone to `
    + `${escapeHtml(intended.join(', '))}.</div>`;
}

function redirectBannerText(intended: string[], testAddress: string): string {
  return `*** TEST MODE — redirected to ${testAddress} ***\n`
    + `In production this message would have gone to: ${intended.join(', ')}\n`
    + '─────────────────────────────────────────────';
}

async function sendEmail(
  env: Env,
  to: string | string[],
  subject: string,
  html: string,
  text: string,
  opts: SendOptions,
): Promise<void> {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (recipients.length === 0) return;

  // The safety gate sits ahead of the API-key check on purpose: `suppress` must hold even
  // when a key is present, and `redirect` still degrades into the no-key branch below.
  // This is the only place a message can reach the provider, so it is the only place the
  // mode has to be enforced — no template can route around it.
  const policy = await resolveMailPolicy(env);

  if (policy.mode === 'suppress') {
    console.log(`[EMAIL SUPPRESSED] To: ${recipients.join(', ')} | Subject: ${subject}`);
    for (const r of recipients) {
      await logEmail(env, r, subject, opts.template, 'suppressed', null,
        policy.reason ?? 'Portal mail is suppressed', opts.requestId);
    }
    return;
  }

  const redirecting = policy.mode === 'redirect';
  const envelope = redirecting ? [policy.testAddress] : recipients;
  const redirectedTo = redirecting ? policy.testAddress : null;

  if (!env.RESEND_API_KEY) {
    console.log(`[EMAIL SKIPPED — no RESEND_API_KEY] To: ${recipients.join(', ')} | Subject: ${subject}`);
    for (const r of recipients) {
      await logEmail(env, r, subject, opts.template, 'skipped', null, 'RESEND_API_KEY not configured', opts.requestId, redirectedTo);
    }
    return;
  }

  let outSubject = subject;
  let outHtml = html;
  let outText = text;

  if (redirecting) {
    // The deliverability notes above forbid bracketed subject prefixes — that reasoning is
    // about production. Here the only recipient is a tester's inbox, where knowing who the
    // message was for is the most useful thing on the row.
    outSubject = `[TEST → ${recipients.join(', ')}] ${subject}`;
    const banner = redirectBannerHtml(recipients, policy.testAddress);
    outHtml = /<body[^>]*>/i.test(html)
      ? html.replace(/(<body[^>]*>)/i, `$1${banner}`)
      : banner + html;
    outText = `${redirectBannerText(recipients, policy.testAddress)}\n\n${text}`;
  }

  const unsubscribe = `mailto:${env.REPLY_TO_EMAIL || env.FALLBACK_NOTIFICATION_EMAIL}?subject=unsubscribe`;

  // Email delivery is best-effort: a provider or configuration problem must never break
  // the approval flow. Every outcome is recorded in email_log either way.
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${(env.FROM_NAME || 'Athletics Business Office').trim()} <${env.FROM_EMAIL}>`,
        to: envelope,
        ...(env.REPLY_TO_EMAIL ? { reply_to: env.REPLY_TO_EMAIL } : {}),
        subject: outSubject,
        html: outHtml,
        text: outText,
        headers: {
          'List-Unsubscribe': `<${unsubscribe}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
        ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
      }),
    });

    // Every log row below is keyed on the INTENDED recipient, not the envelope, so the
    // fan-out record stays truthful under redirect and "did the head coach get it" keeps
    // its meaning. redirected_to carries where it actually went.
    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      console.warn(`[email] send to ${envelope.join(', ')} returned ${res.status}: ${body}`);
      for (const r of recipients) {
        await logEmail(env, r, subject, opts.template, 'failed', null, `${res.status}: ${body}`, opts.requestId, redirectedTo);
      }
      return;
    }

    const payload = await res.json<{ id?: string }>().catch(() => ({} as { id?: string }));
    for (const r of recipients) {
      await logEmail(env, r, subject, opts.template, 'sent', payload.id ?? null, null, opts.requestId, redirectedTo);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`[email] send failed: ${message}`);
    for (const r of recipients) {
      await logEmail(env, r, subject, opts.template, 'failed', null, message, opts.requestId, redirectedTo);
    }
  }
}

/** Collect the unique, non-empty set of everyone involved in a request. */
export function allPartyRecipients(env: Env, d: EmailData): string[] {
  const list = [
    d.coachEmail,
    d.headCoachEmail,
    ...(d.sportAdminEmails ?? []),
    d.sportAdminEmail,
    ...(d.cfoEmails?.length ? d.cfoEmails : [env.FALLBACK_NOTIFICATION_EMAIL]),
  ].filter((e): e is string => !!e);
  return [...new Set(list.map(e => e.toLowerCase()))];
}

/** CFO recipients for a message: the resolved user list, else the env fallback. */
function cfoRecipients(env: Env, d: EmailData): string[] {
  return d.cfoEmails?.length ? d.cfoEmails : [env.FALLBACK_NOTIFICATION_EMAIL].filter(Boolean);
}

// ── .ics calendar reminder ────────────────────────────────────────────────────

function icsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

/**
 * Build a one-event .ics reminding the approver of the submission deadline.
 *
 * No longer attached to notification email. Calendar attachments from an unrecognised
 * sender are a strong quarantine trigger in Exchange Online, and these messages are
 * first contact from a new domain. The portal serves this as a download instead.
 */
export function buildApprovalIcs(env: Env, d: EmailData): EmailAttachment | null {
  // Use the deterministic ISO date (YYYY-MM-DD); avoid parsing the human-formatted string.
  if (!d.submissionDeadlineISO || !/^\d{4}-\d{2}-\d{2}$/.test(d.submissionDeadlineISO)) return null;
  const due = new Date(`${d.submissionDeadlineISO}T17:00:00Z`); // 5pm UTC on the deadline day
  if (isNaN(due.getTime())) return null;
  const fmt = (dt: Date) =>
    dt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const start = fmt(due);
  const end = fmt(new Date(due.getTime() + 30 * 60 * 1000));
  const stamp = fmt(new Date());
  const uid = `req-${d.requestId}@utrockets-insurance`;
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//UT Athletics//Insurance Portal//EN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${icsEscape(`Approve insurance request: ${d.studentName} (${d.sportName})`)}`,
    `DESCRIPTION:${icsEscape(`Health insurance request for ${d.studentName} (${d.term}) needs your approval. ${actionUrl(env, d.requestId)}`)}`,
    `URL:${actionUrl(env, d.requestId)}`,
    'BEGIN:VALARM',
    'TRIGGER:-P1D',
    'ACTION:DISPLAY',
    'DESCRIPTION:Insurance approval deadline reminder',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  return { filename: 'approval-deadline.ics', content: btoa(ics) };
}

// ── Notification triggers ─────────────────────────────────────────────────────

// Confirmation to the coach that their request was submitted and is pending approval.
export async function notifyCoachSubmitted(env: Env, d: EmailData): Promise<void> {
  if (!d.coachEmail) return;
  const subject = `Insurance request submitted for ${d.studentName}, ${d.term}`;
  const intro = 'Your health insurance request has been submitted. It is now pending approval by the head coach, the sport administrator, and the CFO.';
  const closing = 'You will receive another message once the request is fully approved. No further action is needed from you right now.';
  const link = actionUrl(env, d.requestId);
  await sendEmail(
    env, d.coachEmail, subject,
    emailHtml(env, subject, `<p>${intro}</p>${detailsTable(d)}<p>${closing}</p>`, link),
    emailText(env, subject, [intro, '', ...detailsLines(d), '', closing], link),
    { template: 'notifyCoachSubmitted', requestId: d.requestId },
  );
}

// Confirmation to the student-athlete that a request was submitted on their behalf.
export async function notifyStudentSubmitted(env: Env, d: EmailData): Promise<void> {
  if (!d.studentEmail) return;
  const subject = `Your athletic health insurance enrollment request, ${d.term}`;
  const intro = `An athletic health insurance enrollment request has been submitted on your behalf by ${d.coachName} (${d.sportName}). It is now pending departmental approval.`;
  const closing = 'You will be notified once enrollment is complete. If you believe this was submitted in error, contact the Athletics Business Office.';
  await sendEmail(
    env, d.studentEmail, subject,
    emailHtml(env, subject, `<p>Hi ${escapeHtml(d.studentName)},</p><p>${escapeHtml(intro)}</p>${detailsTable(d)}<p>${closing}</p>`),
    emailText(env, subject, [`Hi ${d.studentName},`, '', intro, '', ...detailsLines(d), '', closing]),
    { template: 'notifyStudentSubmitted', requestId: d.requestId },
  );
}

// Step 1 approval request, to the head coach or their active delegate.
export async function notifyPendingHeadCoach(env: Env, d: EmailData, headCoachEmail: string): Promise<void> {
  if (!headCoachEmail) return;
  const subject = `Head coach approval needed: ${d.studentName}, ${d.sportName}`;
  const intro = 'A health insurance request for one of your student-athletes needs your approval before it moves on to the sport administrator and the CFO.';
  const closing = 'Please review the request and either approve or deny it.';
  const link = actionUrl(env, d.requestId);
  await sendEmail(
    env, headCoachEmail, subject,
    emailHtml(env, subject, `<p>${intro}</p>${detailsTable(d)}<p>${closing}</p>`, link, 'Review and approve'),
    emailText(env, subject, [intro, '', ...detailsLines(d), '', closing], link),
    { template: 'notifyPendingHeadCoach', requestId: d.requestId },
  );
}

export async function notifyPendingSportAdmin(env: Env, d: EmailData, adminEmail: string | string[]): Promise<void> {
  const subject = `Approval needed: insurance request for ${d.studentName}, ${d.sportName}`;
  const intro = 'A health insurance request needs your review and signature.';
  const closing = 'Please review and sign the request in the portal.';
  const link = actionUrl(env, d.requestId);
  await sendEmail(
    env, adminEmail, subject,
    emailHtml(env, subject, `<p>${intro}</p>${detailsTable(d)}<p>${closing}</p>`, link, 'Review and sign'),
    emailText(env, subject, [intro, '', ...detailsLines(d), '', closing], link),
    { template: 'notifyPendingSportAdmin', requestId: d.requestId },
  );
}

export async function notifyPendingCFO(env: Env, d: EmailData): Promise<void> {
  const subject = `Final approval needed: insurance request for ${d.studentName}`;
  const intro = 'A health insurance request needs your final approval.';
  const adminLine = d.sportAdminName ? `Sport administrator of record: ${d.sportAdminName}` : '';
  const link = actionUrl(env, d.requestId);
  await sendEmail(
    env, cfoRecipients(env, d), subject,
    emailHtml(env, subject,
      `<p>${intro}</p>${adminLine ? `<p>${escapeHtml(adminLine)}</p>` : ''}${detailsTable(d)}`,
      link, 'Final approval'),
    emailText(env, subject, [intro, ...(adminLine ? ['', adminLine] : []), '', ...detailsLines(d)], link),
    { template: 'notifyPendingCFO', requestId: d.requestId },
  );
}

/** Send the same message to each party individually (robust to a single bad address). */
async function sendToAllParties(
  env: Env, d: EmailData, subject: string, html: string, text: string,
  opts: SendOptions,
): Promise<void> {
  for (const to of allPartyRecipients(env, d)) {
    await sendEmail(env, to, subject, html, text, opts);
  }
}

// Final confirmation once all approvals are recorded, with the signed PDF attached.
export async function notifyExecuted(env: Env, d: EmailData, pdf?: EmailAttachment): Promise<void> {
  const subject = `Approved: insurance request for ${d.studentName}, ${d.term}`;
  const intro = `This health insurance request is fully approved and executed. The premium will be deducted from the program's ${fundingSourceLabel(d.fundingSource)}.`;
  const closing = 'Enrollment is complete. The signed authorization form is attached.';
  const link = actionUrl(env, d.requestId);
  await sendToAllParties(env, d, subject,
    emailHtml(env, subject, `<p>${escapeHtml(intro)}</p>${detailsTable(d)}<p style="color:#1a7a4a;font-weight:600">${closing}</p>`, link),
    emailText(env, subject, [intro, '', ...detailsLines(d), '', closing], link),
    { template: 'notifyExecuted', requestId: d.requestId, attachments: pdf ? [pdf] : undefined },
  );
}

export async function notifyVoided(env: Env, d: EmailData, pdf?: EmailAttachment): Promise<void> {
  const subject = `Voided: insurance request for ${d.studentName}`;
  const intro = 'This health insurance request has been voided by the CFO.';
  const reason = d.voidReason ? `Reason: ${d.voidReason}` : '';
  const closing = 'If you believe this was in error, contact the Athletics Business Office.';
  const link = actionUrl(env, d.requestId);
  await sendToAllParties(env, d, subject,
    emailHtml(env, subject,
      `<p>${intro}</p>${reason ? `<p><strong>Reason:</strong> ${escapeHtml(d.voidReason!)}</p>` : ''}${detailsTable(d)}<p>${closing}</p>`, link),
    emailText(env, subject, [intro, ...(reason ? ['', reason] : []), '', ...detailsLines(d), '', closing], link),
    { template: 'notifyVoided', requestId: d.requestId, attachments: pdf ? [pdf] : undefined },
  );
}

// Request denied by the head coach or a sport admin, fanned out with the reason.
export async function notifyDenied(env: Env, d: EmailData): Promise<void> {
  const subject = `Denied: insurance request for ${d.studentName}, ${d.term}`;
  const intro = 'This health insurance request has been denied and will not be processed as submitted.';
  const reason = d.denialReason ? `Reason for denial: ${d.denialReason}` : '';
  const closing = 'The requesting coach can correct the issue and resubmit from the request page.';
  const link = actionUrl(env, d.requestId);
  await sendToAllParties(env, d, subject,
    emailHtml(env, subject,
      `<p>${intro}</p>${reason ? `<p><strong>Reason for denial:</strong> ${escapeHtml(d.denialReason!)}</p>` : ''}${detailsTable(d)}<p>${closing}</p>`,
      link, 'View and resubmit'),
    emailText(env, subject, [intro, ...(reason ? ['', reason] : []), '', ...detailsLines(d), '', closing], link),
    { template: 'notifyDenied', requestId: d.requestId },
  );
}

/** A request whose term deadline passed while it was still awaiting a signature. */
export async function notifyExpired(env: Env, d: EmailData): Promise<void> {
  const subject = `Expired: insurance request for ${d.studentName}, ${d.term}`;
  const intro = `The submission deadline for ${d.term} has passed and this request was still awaiting approval, so it has been marked expired.`;
  const closing = 'Contact the Athletics Business Office if this athlete still needs coverage for this term.';
  const link = actionUrl(env, d.requestId);
  await sendToAllParties(env, d, subject,
    emailHtml(env, subject, `<p>${escapeHtml(intro)}</p>${detailsTable(d)}<p>${closing}</p>`, link),
    emailText(env, subject, [intro, '', ...detailsLines(d), '', closing], link),
    { template: 'notifyExpired', requestId: d.requestId },
  );
}

export async function notifyReminder(
  env: Env, d: EmailData, to: string, role: string, escalated = false,
): Promise<void> {
  const subject = escalated
    ? `Still awaiting your signature: insurance request for ${d.studentName}`
    : `Reminder: insurance request for ${d.studentName} needs your signature`;
  const intro = escalated
    ? `This request has been waiting on your signature as ${role} through several reminders. It will expire on ${d.submissionDeadline ?? 'the term deadline'} if it is not actioned.`
    : `A health insurance request assigned to you as ${role} has been pending for over 48 hours and still needs your signature.`;
  const closing = 'Please review and sign the request so it can be processed before the deadline.';
  const link = actionUrl(env, d.requestId);
  await sendEmail(
    env, to, subject,
    emailHtml(env, subject, `<p>${escapeHtml(intro)}</p>${detailsTable(d)}<p>${closing}</p>`, link, 'Review and sign'),
    emailText(env, subject, [intro, '', ...detailsLines(d), '', closing], link),
    { template: escalated ? 'notifyReminderEscalated' : 'notifyReminder', requestId: d.requestId },
  );
}

// ── Account email ─────────────────────────────────────────────────────────────

export async function notifyPasswordReset(
  env: Env, to: string, name: string, token: string,
): Promise<void> {
  const link = `${env.APP_BASE_URL.replace(/\/$/, '')}/reset-password?token=${token}`;
  const subject = 'Reset your Athletics Insurance Portal password';
  const intro = 'We received a request to reset your password for the University of Toledo Athletics Insurance Portal.';
  const closing = 'This link expires in one hour and can be used once. If you did not request a reset, you can ignore this message and your password will stay unchanged.';
  await sendEmail(
    env, to, subject,
    emailHtml(env, subject, `<p>Hi ${escapeHtml(name)},</p><p>${intro}</p><p style="color:#666;font-size:14px">${closing}</p>`, link, 'Reset my password', FOOTER_ACCOUNT),
    emailText(env, subject, [`Hi ${name},`, '', intro, '', closing], link, 'Open this link', FOOTER_ACCOUNT),
    { template: 'notifyPasswordReset' },
  );
}

/**
 * Credentials for an account an administrator created on someone's behalf.
 *
 * The password is sent in plaintext because there is no other channel to reach a person
 * who does not yet have an account. It is safe only because it is genuinely temporary:
 * `must_change_password` is set at creation and the `/api/*` gate in index.ts rejects
 * every call from that account until a new password is chosen, so an intercepted message
 * yields a credential that cannot be used for anything except setting a new one.
 */
export async function notifyAccountCreated(
  env: Env, to: string, name: string, tempPassword: string, roleLabel: string,
): Promise<void> {
  const link = `${env.APP_BASE_URL.replace(/\/$/, '')}/login`;
  const subject = 'Your Athletics Insurance Portal account';
  const intro = `An account has been created for you on the University of Toledo Athletics `
    + `Insurance Portal as ${roleLabel}. Sign in with the details below.`;
  const closing = 'You will be asked to choose your own password the first time you sign in. '
    + 'The temporary password stops working at that point.';
  await sendEmail(
    env, to, subject,
    emailHtml(
      env, subject,
      `<p style="margin:0 0 14px">Hi ${escapeHtml(name)},</p>`
      + `<p style="margin:0">${escapeHtml(intro)}</p>`
      + recordTable([
        ['Email', escapeHtml(to)],
        ['Temporary password',
          `<code style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:16px;`
          + `color:${NAVY};background:#FFFFFF;border:1px solid ${RULE};padding:5px 9px;display:inline-block">`
          + `${escapeHtml(tempPassword)}</code>`],
      ])
      + `<p style="margin:0;color:${MUTED};font-size:13.5px;line-height:1.55">${escapeHtml(closing)}</p>`,
      link, 'Sign in', FOOTER_ACCOUNT,
    ),
    emailText(env, subject, [
      `Hi ${name},`, '', intro, '',
      `Email: ${to}`,
      `Temporary password: ${tempPassword}`,
      '', closing,
    ], link, 'Sign in here', FOOTER_ACCOUNT),
    { template: 'notifyAccountCreated' },
  );
}

/** Tells a self-registered user their account request was approved or rejected. */
export async function notifyRegistrationDecision(
  env: Env, to: string, name: string, approved: boolean,
): Promise<void> {
  const subject = approved
    ? 'Your Athletics Insurance Portal account is active'
    : 'Your Athletics Insurance Portal account request';
  const intro = approved
    ? 'Your account request has been approved. You can now sign in with the email and password you registered with.'
    : 'Your account request was not approved. If you believe this is a mistake, contact the Athletics Business Office.';
  const link = approved ? `${env.APP_BASE_URL.replace(/\/$/, '')}/login` : undefined;
  await sendEmail(
    env, to, subject,
    emailHtml(env, subject, `<p>Hi ${escapeHtml(name)},</p><p>${escapeHtml(intro)}</p>`, link, 'Sign in', FOOTER_ACCOUNT),
    emailText(env, subject, [`Hi ${name},`, '', intro], link, 'Sign in here', FOOTER_ACCOUNT),
    { template: approved ? 'notifyRegistrationApproved' : 'notifyRegistrationRejected' },
  );
}

/**
 * A configuration check the operator can trigger from Settings.
 *
 * Routed through the ordinary sendEmail path on purpose: it proves the From address, the
 * DNS, and the current mail mode all at once, rather than testing a path nothing else uses.
 * Under suppress it sends nothing and says so in the log, which is itself the useful answer.
 */
export async function notifyTestMessage(env: Env, to: string, requestedBy: string): Promise<void> {
  const subject = 'Athletics Insurance Portal configuration test';
  const intro = 'This is a configuration test from the University of Toledo Athletics Insurance '
    + 'Portal. If you are reading it, the portal can reach this address.';
  const detail = `Requested by ${requestedBy}. No action is needed.`;
  await sendEmail(
    env, to, subject,
    emailHtml(
      env, subject,
      `<p style="margin:0 0 14px">${escapeHtml(intro)}</p>`
      + recordTable([
        ['From address', escapeHtml(env.FROM_EMAIL)],
        ['Reply-To', escapeHtml(env.REPLY_TO_EMAIL || env.FALLBACK_NOTIFICATION_EMAIL)],
        ['Portal', escapeHtml(env.APP_BASE_URL)],
      ])
      + `<p style="margin:0;color:${MUTED};font-size:13.5px">${escapeHtml(detail)}</p>`,
      undefined, undefined, FOOTER_ACCOUNT,
    ),
    emailText(env, subject, [intro, '', `From address: ${env.FROM_EMAIL}`,
      `Reply-To: ${env.REPLY_TO_EMAIL || env.FALLBACK_NOTIFICATION_EMAIL}`,
      `Portal: ${env.APP_BASE_URL}`, '', detail], undefined, undefined, FOOTER_ACCOUNT),
    { template: 'notifyTestMessage' },
  );
}
