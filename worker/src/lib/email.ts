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
  CFO_EMAIL: string;
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

const FOOTER_TEXT =
  'University of Toledo Athletics, Health Insurance Request System. '
  + 'You are receiving this because you are named on this insurance request.';

function emailHtml(
  env: Env, title: string, body: string, actionLink?: string, actionLabel?: string,
): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,Segoe UI,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222">
<h2 style="color:#003DA5;font-size:20px">${escapeHtml(title)}</h2>
${body}
${actionLink ? `<p style="margin-top:20px"><a href="${actionLink}" style="background:#003DA5;color:#ffffff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(actionLabel ?? 'View Request')}</a></p>
<p style="font-size:13px;color:#555">Or open this address directly:<br/><span style="word-break:break-all">${escapeHtml(actionLink)}</span></p>` : ''}
<hr style="margin-top:30px;border:none;border-top:1px solid #eee"/>
<p style="color:#888;font-size:12px">${escapeHtml(FOOTER_TEXT)}<br/>
Questions: <a href="mailto:${escapeHtml(env.REPLY_TO_EMAIL || env.CFO_EMAIL)}">${escapeHtml(env.REPLY_TO_EMAIL || env.CFO_EMAIL)}</a></p>
</body></html>`;
}

/**
 * Plain-text counterpart, built from the same inputs as the HTML rather than by
 * stripping tags, so the two parts cannot drift apart.
 */
function emailText(env: Env, title: string, lines: string[], actionLink?: string): string {
  const out = [title, '', ...lines];
  if (actionLink) out.push('', `Open the request: ${actionLink}`);
  out.push('', '---', FOOTER_TEXT, `Questions: ${env.REPLY_TO_EMAIL || env.CFO_EMAIL}`);
  return out.join('\n');
}

function detailsTable(d: EmailData): string {
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 12px;background:#f8f9fa;font-weight:600;width:40%">${label}</td><td style="padding:6px 12px;border:1px solid #e9ecef">${value}</td></tr>`;
  return `<table style="border-collapse:collapse;width:100%;margin:12px 0">
${row('Student-Athlete', escapeHtml(d.studentName))}
${row('Rocket Number', escapeHtml(d.rocketNumber))}
${row('Sport', escapeHtml(d.sportName))}
${row('Term', escapeHtml(d.term))}
${row('Premium Cost', `<strong>$${d.premiumCost.toFixed(2)}</strong>, to be deducted from the ${escapeHtml(fundingSourceLabel(d.fundingSource))}`)}
${row('Requesting Coach', `${escapeHtml(d.coachName)}${d.coachEmail ? ` (${escapeHtml(d.coachEmail)})` : ''}`)}
${d.submissionDeadline ? row('Submission Deadline', escapeHtml(d.submissionDeadline)) : ''}
</table>`;
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
  status: 'sent' | 'failed' | 'skipped',
  providerId?: string | null, error?: string | null, requestId?: string,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO email_log (id, request_id, to_email, subject, template, provider_id, status, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(), requestId ?? null, to, subject, template,
      providerId ?? null, status, error ? error.slice(0, 1000) : null,
    ).run();
  } catch (e) {
    console.warn(`[email] log write failed: ${e instanceof Error ? e.message : String(e)}`);
  }
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

  if (!env.RESEND_API_KEY) {
    console.log(`[EMAIL SKIPPED — no RESEND_API_KEY] To: ${recipients.join(', ')} | Subject: ${subject}`);
    for (const r of recipients) {
      await logEmail(env, r, subject, opts.template, 'skipped', null, 'RESEND_API_KEY not configured', opts.requestId);
    }
    return;
  }

  const unsubscribe = `mailto:${env.REPLY_TO_EMAIL || env.CFO_EMAIL}?subject=unsubscribe`;

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
        to: recipients,
        ...(env.REPLY_TO_EMAIL ? { reply_to: env.REPLY_TO_EMAIL } : {}),
        subject,
        html,
        text,
        headers: {
          'List-Unsubscribe': `<${unsubscribe}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
        ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      console.warn(`[email] send to ${recipients.join(', ')} returned ${res.status}: ${body}`);
      for (const r of recipients) {
        await logEmail(env, r, subject, opts.template, 'failed', null, `${res.status}: ${body}`, opts.requestId);
      }
      return;
    }

    const payload = await res.json<{ id?: string }>().catch(() => ({} as { id?: string }));
    for (const r of recipients) {
      await logEmail(env, r, subject, opts.template, 'sent', payload.id ?? null, null, opts.requestId);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`[email] send failed: ${message}`);
    for (const r of recipients) {
      await logEmail(env, r, subject, opts.template, 'failed', null, message, opts.requestId);
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
    ...(d.cfoEmails?.length ? d.cfoEmails : [env.CFO_EMAIL]),
  ].filter((e): e is string => !!e);
  return [...new Set(list.map(e => e.toLowerCase()))];
}

/** CFO recipients for a message: the resolved user list, else the env fallback. */
function cfoRecipients(env: Env, d: EmailData): string[] {
  return d.cfoEmails?.length ? d.cfoEmails : [env.CFO_EMAIL].filter(Boolean);
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
    emailHtml(env, subject, `<p>Hi ${escapeHtml(name)},</p><p>${intro}</p><p style="color:#666;font-size:14px">${closing}</p>`, link, 'Reset my password'),
    emailText(env, subject, [`Hi ${name},`, '', intro, '', closing], link),
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
  const cell = 'padding:6px 12px;border:1px solid #e9ecef';
  const label = 'padding:6px 12px;background:#f8f9fa;font-weight:600;width:40%';
  await sendEmail(
    env, to, subject,
    emailHtml(
      env, subject,
      `<p>Hi ${escapeHtml(name)},</p><p>${escapeHtml(intro)}</p>`
      + `<table style="border-collapse:collapse;width:100%;margin:12px 0">`
      + `<tr><td style="${label}">Email</td><td style="${cell}">${escapeHtml(to)}</td></tr>`
      + `<tr><td style="${label}">Temporary password</td>`
      + `<td style="${cell}"><code style="font-size:15px">${escapeHtml(tempPassword)}</code></td></tr>`
      + `</table>`
      + `<p style="color:#666;font-size:14px">${escapeHtml(closing)}</p>`,
      link, 'Sign in',
    ),
    emailText(env, subject, [
      `Hi ${name},`, '', intro, '',
      `Email: ${to}`,
      `Temporary password: ${tempPassword}`,
      '', closing,
    ], link),
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
    emailHtml(env, subject, `<p>Hi ${escapeHtml(name)},</p><p>${escapeHtml(intro)}</p>`, link, 'Sign in'),
    emailText(env, subject, [`Hi ${name},`, '', intro], link),
    { template: approved ? 'notifyRegistrationApproved' : 'notifyRegistrationRejected' },
  );
}
