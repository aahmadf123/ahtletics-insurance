function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface Env {
  RESEND_API_KEY?: string;
  FROM_NAME?: string;
  FROM_EMAIL: string;
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
  return `${env.APP_BASE_URL}/request/${requestId}`;
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

function emailHtml(title: string, body: string, actionLink?: string, actionLabel?: string): string {
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
<h2 style="color:#003DA5">${title}</h2>
${body}
${actionLink ? `<p><a href="${actionLink}" style="background:#003DA5;color:white;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:12px">${actionLabel ?? 'View Request'}</a></p>` : ''}
<hr style="margin-top:30px;border:none;border-top:1px solid #eee"/>
<p style="color:#888;font-size:12px">University of Toledo Athletics — Health Insurance Request System<br/>This is an automated notification. Do not reply to this email.</p>
</body></html>`;
}

function detailsTable(d: EmailData): string {
  return `<table style="border-collapse:collapse;width:100%;margin:12px 0">
<tr><td style="padding:6px 12px;background:#f8f9fa;font-weight:600;width:40%">Student-Athlete</td><td style="padding:6px 12px;border:1px solid #e9ecef">${escapeHtml(d.studentName)}</td></tr>
<tr><td style="padding:6px 12px;background:#f8f9fa;font-weight:600">Rocket Number</td><td style="padding:6px 12px;border:1px solid #e9ecef">${escapeHtml(d.rocketNumber)}</td></tr>
<tr><td style="padding:6px 12px;background:#f8f9fa;font-weight:600">Sport</td><td style="padding:6px 12px;border:1px solid #e9ecef">${escapeHtml(d.sportName)}</td></tr>
<tr><td style="padding:6px 12px;background:#f8f9fa;font-weight:600">Term</td><td style="padding:6px 12px;border:1px solid #e9ecef">${escapeHtml(d.term)}</td></tr>
<tr><td style="padding:6px 12px;background:#f8f9fa;font-weight:600">Premium Cost</td><td style="padding:6px 12px;border:1px solid #e9ecef"><strong>$${d.premiumCost.toFixed(2)}</strong> — will be deducted from ${escapeHtml(d.coachName)}'s ${escapeHtml(fundingSourceLabel(d.fundingSource))}</td></tr>
<tr><td style="padding:6px 12px;background:#f8f9fa;font-weight:600">Requesting Coach</td><td style="padding:6px 12px;border:1px solid #e9ecef">${escapeHtml(d.coachName)}${d.coachEmail ? ` (${escapeHtml(d.coachEmail)})` : ''}</td></tr>
</table>`;
}

interface SendOptions {
  attachments?: EmailAttachment[];
}

async function sendEmail(
  env: Env,
  to: string | string[],
  subject: string,
  html: string,
  opts: SendOptions = {},
): Promise<void> {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (recipients.length === 0) return;
  if (!env.RESEND_API_KEY) {
    console.log(`[EMAIL SKIPPED — no RESEND_API_KEY] To: ${recipients.join(', ')} | Subject: ${subject}`);
    return;
  }
  // Email delivery is best-effort: a provider/config problem (e.g. an unverified sending
  // domain) must never break the approval flow or flood the logs with stack traces.
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
        subject,
        html,
        ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
      }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      console.warn(`[email] send to ${recipients.join(', ')} returned ${res.status}: ${err}`);
    }
  } catch (e) {
    console.warn(`[email] send failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Collect the unique, non-empty set of everyone involved in a request. */
export function allPartyRecipients(env: Env, d: EmailData): string[] {
  const list = [
    d.coachEmail,
    d.headCoachEmail,
    ...(d.sportAdminEmails ?? []),
    d.sportAdminEmail,
    env.CFO_EMAIL,
  ].filter((e): e is string => !!e);
  return [...new Set(list)];
}

// ── .ics calendar reminder (3.1 Phase 2) ─────────────────────────────────────

function icsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

/** Build a one-event .ics reminding the approver of the submission deadline. */
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
    `SUMMARY:${icsEscape(`Approve insurance request — ${d.studentName} (${d.sportName})`)}`,
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
  const subject = `Submitted: Health Insurance Request for ${d.studentName} – ${d.term}`;
  const body = `<p>Your health insurance request has been submitted and is now pending approval by the Head Coach, Sport Administrator, and the CFO.</p>
${detailsTable(d)}
<p>You will receive another email once the request has been fully approved. No further action is required from you at this time.</p>`;
  await sendEmail(env, d.coachEmail, subject, emailHtml(subject, body, actionUrl(env, d.requestId)));
}

// Confirmation to the student-athlete that a request was submitted on their behalf.
export async function notifyStudentSubmitted(env: Env, d: EmailData): Promise<void> {
  if (!d.studentEmail) return;
  const subject = `Health Insurance Enrollment Request – ${d.term}`;
  const body = `<p>Hi ${escapeHtml(d.studentName)},</p>
<p>An athletic health insurance enrollment request has been submitted on your behalf by ${escapeHtml(d.coachName)} (${escapeHtml(d.sportName)}). It is now pending departmental approval.</p>
${detailsTable(d)}
<p>You will be notified once enrollment is complete. If you believe this was submitted in error, please contact the Athletics Business Office.</p>`;
  await sendEmail(env, d.studentEmail, subject, emailHtml(subject, body));
}

// Step 1 approval request — goes to the HEAD COACH (or active delegate) only (1.1 / 1.8).
export async function notifyPendingHeadCoach(env: Env, d: EmailData, headCoachEmail: string): Promise<void> {
  if (!headCoachEmail) return;
  const subject = `[Action Required] Head Coach approval needed: ${d.studentName} – ${d.sportName}`;
  const body = `<p>A health insurance request for one of your student-athletes requires your approval before it advances to the Sport Administrator and CFO.</p>
${detailsTable(d)}
<p>Please review and approve (or deny) this request.</p>`;
  const ics = buildApprovalIcs(env, d);
  await sendEmail(env, headCoachEmail, subject, emailHtml(subject, body, actionUrl(env, d.requestId), 'Review & Approve'), {
    attachments: ics ? [ics] : undefined,
  });
}

export async function notifyPendingSportAdmin(env: Env, d: EmailData, adminEmail: string | string[]): Promise<void> {
  const subject = `[Action Required] Insurance request for ${d.studentName} needs your approval – ${d.sportName}`;
  const body = `<p>A health insurance request requires your review and signature.</p>
${detailsTable(d)}
<p>Please click the button below to review and sign this request.</p>`;
  const ics = buildApprovalIcs(env, d);
  await sendEmail(env, adminEmail, subject, emailHtml(subject, body, actionUrl(env, d.requestId), 'Review & Sign'), {
    attachments: ics ? [ics] : undefined,
  });
}

export async function notifyPendingCFO(env: Env, d: EmailData): Promise<void> {
  const subject = `[Action Required] Final approval needed: Insurance request for ${d.studentName}`;
  const body = `<p>A health insurance request requires your final approval.</p>
${d.sportAdminName ? `<p>Sport Admin of record: <strong>${escapeHtml(d.sportAdminName)}</strong></p>` : ''}
${detailsTable(d)}`;
  const ics = buildApprovalIcs(env, d);
  await sendEmail(env, env.CFO_EMAIL, subject, emailHtml(subject, body, actionUrl(env, d.requestId), 'Final Approval'), {
    attachments: ics ? [ics] : undefined,
  });
}

/** Send the same message to each party individually (robust to a single bad address). */
async function sendToAllParties(env: Env, d: EmailData, subject: string, html: string, opts: SendOptions = {}): Promise<void> {
  for (const to of allPartyRecipients(env, d)) {
    await sendEmail(env, to, subject, html, opts);
  }
}

// Final confirmation once all approvals are recorded — sent to ALL parties with the
// signed/completed PDF attached (1.6).
export async function notifyExecuted(env: Env, d: EmailData, pdf?: EmailAttachment): Promise<void> {
  const subject = `Approved: Health Insurance Request for ${d.studentName} – ${d.term}`;
  const body = `<p>This health insurance request has been fully approved and executed. The premium will be deducted from the program's ${escapeHtml(fundingSourceLabel(d.fundingSource))}.</p>
${detailsTable(d)}
<p style="color:#1a7a4a;font-weight:600">✓ Enrollment is complete. The signed authorization form is attached.</p>`;
  await sendToAllParties(env, d, subject, emailHtml(subject, body, actionUrl(env, d.requestId)), {
    attachments: pdf ? [pdf] : undefined,
  });
}

export async function notifyVoided(env: Env, d: EmailData, pdf?: EmailAttachment): Promise<void> {
  const subject = `Voided: Health Insurance Request for ${d.studentName}`;
  const body = `<p>This health insurance request has been voided by the CFO.</p>
${d.voidReason ? `<p><strong>Reason:</strong> ${escapeHtml(d.voidReason)}</p>` : ''}
${detailsTable(d)}
<p>If you believe this was in error, please contact the Athletics Business Office.</p>`;
  await sendToAllParties(env, d, subject, emailHtml(subject, body, actionUrl(env, d.requestId)), {
    attachments: pdf ? [pdf] : undefined,
  });
}

// Request denied by the head coach or a sport admin — fan out with the reason (1.4).
export async function notifyDenied(env: Env, d: EmailData): Promise<void> {
  const subject = `Denied: Health Insurance Request for ${d.studentName} – ${d.term}`;
  const body = `<p>This health insurance request has been <strong>denied</strong> and will not be processed as submitted.</p>
${d.denialReason ? `<p><strong>Reason for denial:</strong> ${escapeHtml(d.denialReason)}</p>` : ''}
${detailsTable(d)}
<p>The requesting coach can correct the issue and resubmit from the request page.</p>`;
  await sendToAllParties(env, d, subject, emailHtml(subject, body, actionUrl(env, d.requestId), 'View & Resubmit'));
}

export async function notifyReminder(env: Env, d: EmailData, to: string, role: string): Promise<void> {
  const subject = `Reminder: Action Required – Health Insurance Request Pending Your Signature`;
  const body = `<p>A health insurance request assigned to you as <strong>${role}</strong> has been pending for over 48 hours and still requires your signature.</p>
${detailsTable(d)}
<p>Please take action at your earliest convenience to avoid the request expiring.</p>`;
  await sendEmail(env, to, subject, emailHtml(subject, body, actionUrl(env, d.requestId), 'Review & Sign'));
}
