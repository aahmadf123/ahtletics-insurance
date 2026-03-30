function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface Env {
  RESEND_API_KEY?: string;
  FROM_EMAIL: string;
  APP_BASE_URL: string;
  CFO_EMAIL: string;
}

interface EmailData {
  studentName: string;
  rocketNumber: string;
  sport: string;
  sportName: string;
  term: string;
  premiumCost: number;
  coachName: string;
  coachEmail: string;
  requestId: string;
  status: string;
  sportAdminName?: string;
  voidReason?: string;
}

function actionUrl(env: Env, requestId: string): string {
  return `${env.APP_BASE_URL}/request/${requestId}`;
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
<tr><td style="padding:6px 12px;background:#f8f9fa;font-weight:600">Premium Cost</td><td style="padding:6px 12px;border:1px solid #e9ecef"><strong>$${d.premiumCost.toFixed(2)}</strong> — will be deducted from ${escapeHtml(d.coachName)}'s operating budget</td></tr>
<tr><td style="padding:6px 12px;background:#f8f9fa;font-weight:600">Requesting Coach</td><td style="padding:6px 12px;border:1px solid #e9ecef">${escapeHtml(d.coachName)} (${escapeHtml(d.coachEmail)})</td></tr>
</table>`;
}

async function sendEmail(env: Env, to: string, subject: string, html: string): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.log(`[EMAIL SKIPPED — no RESEND_API_KEY] To: ${to} | Subject: ${subject}`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `Athletics Business Office <${env.FROM_EMAIL}>`,
      to,
      subject,
      html,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`Email send failed: ${err}`);
  }
}

// ── Notification triggers ─────────────────────────────────────────────────────

export async function notifyPendingSportAdmin(env: Env, d: EmailData, adminEmail: string): Promise<void> {
  const subject = `Action Required: Health Insurance Request for ${d.studentName} – ${d.sportName}`;
  const body = `<p>A new health insurance request requires your review and signature.</p>
${detailsTable(d)}
<p>Please click the button below to review and sign this request.</p>`;
  await sendEmail(env, adminEmail, subject, emailHtml(subject, body, actionUrl(env, d.requestId), 'Review & Sign'));
}

export async function notifyPendingCFO(env: Env, d: EmailData): Promise<void> {
  const subject = `Action Required: Final Approval – Health Insurance Request for ${d.studentName}`;
  const body = `<p>A health insurance request has been approved by the Sport Administrator and now requires your final approval.</p>
${d.sportAdminName ? `<p>Approved by Sport Admin: <strong>${escapeHtml(d.sportAdminName)}</strong></p>` : ''}
${detailsTable(d)}`;
  await sendEmail(env, env.CFO_EMAIL, subject, emailHtml(subject, body, actionUrl(env, d.requestId), 'Final Approval'));
}

export async function notifyExecuted(env: Env, d: EmailData, adminEmail?: string): Promise<void> {
  const subject = `Executed: Health Insurance Request for ${d.studentName} – ${d.term}`;
  const body = `<p>This health insurance request has been fully executed. The premium will be deducted from the program's operating budget.</p>
${detailsTable(d)}
<p style="color:#1a7a4a;font-weight:600">✓ Enrollment is complete.</p>`;
  const recipients = [d.coachEmail, env.CFO_EMAIL];
  if (adminEmail && adminEmail !== env.CFO_EMAIL) recipients.push(adminEmail);
  for (const to of [...new Set(recipients)]) {
    await sendEmail(env, to, subject, emailHtml(subject, body, actionUrl(env, d.requestId)));
  }
}

export async function notifyVoided(env: Env, d: EmailData, adminEmail?: string): Promise<void> {
  const subject = `Voided: Health Insurance Request for ${d.studentName}`;
  const body = `<p>This health insurance request has been voided by the CFO.</p>
${d.voidReason ? `<p><strong>Reason:</strong> ${escapeHtml(d.voidReason)}</p>` : ''}
${detailsTable(d)}
<p>If you believe this was in error, please contact the Athletics Business Office.</p>`;
  const recipients = [d.coachEmail];
  if (adminEmail && adminEmail !== env.CFO_EMAIL) recipients.push(adminEmail);
  for (const to of [...new Set(recipients)]) {
    await sendEmail(env, to, subject, emailHtml(subject, body));
  }
}

export async function notifyReminder(env: Env, d: EmailData, to: string, role: string): Promise<void> {
  const subject = `Reminder: Action Required – Health Insurance Request Pending Your Signature`;
  const body = `<p>A health insurance request assigned to you as <strong>${role}</strong> has been pending for over 48 hours and still requires your signature.</p>
${detailsTable(d)}
<p>Please take action at your earliest convenience to avoid the request expiring.</p>`;
  await sendEmail(env, to, subject, emailHtml(subject, body, actionUrl(env, d.requestId), 'Review & Sign'));
}
