import { Resend } from 'resend';

interface EmailContext {
  studentName: string;
  rocketNumber: string;
  sport: string;
  term: string;
  premiumCost: number;
  coachName: string;
  coachEmail: string;
  actionUrl: string;
  currentStatus: string;
  voidReason?: string;
}

function formatPremium(cost: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cost);
}

function baseHtml(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
<h2 style="color:#003087">${title}</h2>${bodyHtml}
<hr><p style="font-size:12px;color:#666">University of Toledo Athletics — Business Office<br>
This is an automated message. Do not reply directly to this email.</p></body></html>`;
}

function requestDetails(ctx: EmailContext): string {
  return `<table style="border-collapse:collapse;width:100%">
<tr><td style="padding:6px;background:#f5f5f5"><strong>Student-Athlete</strong></td><td style="padding:6px">${ctx.studentName}</td></tr>
<tr><td style="padding:6px;background:#f5f5f5"><strong>Rocket Number</strong></td><td style="padding:6px">${ctx.rocketNumber}</td></tr>
<tr><td style="padding:6px;background:#f5f5f5"><strong>Sport</strong></td><td style="padding:6px">${ctx.sport}</td></tr>
<tr><td style="padding:6px;background:#f5f5f5"><strong>Term</strong></td><td style="padding:6px">${ctx.term}</td></tr>
<tr><td style="padding:6px;background:#f5f5f5"><strong>Premium Cost</strong></td><td style="padding:6px"><strong>${formatPremium(ctx.premiumCost)}</strong> — will be deducted from the coach's program operating budget</td></tr>
<tr><td style="padding:6px;background:#f5f5f5"><strong>Requesting Coach</strong></td><td style="padding:6px">${ctx.coachName} (${ctx.coachEmail})</td></tr>
<tr><td style="padding:6px;background:#f5f5f5"><strong>Status</strong></td><td style="padding:6px">${ctx.currentStatus}</td></tr>
</table>`;
}

export async function sendSportAdminNotification(resendKey: string, to: string, ctx: EmailContext): Promise<void> {
  const resend = new Resend(resendKey);
  await resend.emails.send({
    from: `Athletics Business Office <${ctx.coachEmail.replace(ctx.coachEmail, 'noreply@athletics.utoledo.edu')}>`,
    to,
    subject: `Action Required: Health Insurance Request for ${ctx.studentName} – ${ctx.sport}`,
    html: baseHtml('Action Required: Sport Administrator Signature', `
      <p>A health insurance enrollment request requires your signature.</p>
      ${requestDetails(ctx)}
      <p><a href="${ctx.actionUrl}" style="background:#003087;color:#fff;padding:10px 20px;text-decoration:none;border-radius:4px">Review & Sign Request</a></p>
    `),
  });
}

export async function sendCfoNotification(resendKey: string, to: string, ctx: EmailContext): Promise<void> {
  const resend = new Resend(resendKey);
  await resend.emails.send({
    from: 'Athletics Business Office <noreply@athletics.utoledo.edu>',
    to,
    subject: `Action Required: Final Approval – Health Insurance Request for ${ctx.studentName}`,
    html: baseHtml('Final CFO Approval Required', `
      <p>A health insurance request has cleared Sport Administrator review and now requires your final signature.</p>
      ${requestDetails(ctx)}
      <p><a href="${ctx.actionUrl}" style="background:#003087;color:#fff;padding:10px 20px;text-decoration:none;border-radius:4px">Review & Sign Request</a></p>
    `),
  });
}

export async function sendExecutedConfirmation(resendKey: string, recipients: string[], ctx: EmailContext): Promise<void> {
  const resend = new Resend(resendKey);
  await resend.emails.send({
    from: 'Athletics Business Office <noreply@athletics.utoledo.edu>',
    to: recipients,
    subject: `Executed: Health Insurance Request for ${ctx.studentName} – ${ctx.term}`,
    html: baseHtml('Request Fully Executed', `
      <p>The following health insurance enrollment request has been fully executed and approved.</p>
      ${requestDetails(ctx)}
      <p>${formatPremium(ctx.premiumCost)} will be deducted from the coach's program operating budget for the ${ctx.term} term.</p>
    `),
  });
}

export async function sendReminderEmail(resendKey: string, to: string, ctx: EmailContext): Promise<void> {
  const resend = new Resend(resendKey);
  await resend.emails.send({
    from: 'Athletics Business Office <noreply@athletics.utoledo.edu>',
    to,
    subject: `Reminder: Action Required – Health Insurance Request Pending Your Signature`,
    html: baseHtml('Reminder: Signature Required', `
      <p>This is a reminder that the following health insurance request is still awaiting your signature.</p>
      ${requestDetails(ctx)}
      <p><a href="${ctx.actionUrl}" style="background:#003087;color:#fff;padding:10px 20px;text-decoration:none;border-radius:4px">Review & Sign Request</a></p>
    `),
  });
}

export async function sendEscalationEmail(resendKey: string, recipients: string[], ctx: EmailContext): Promise<void> {
  const resend = new Resend(resendKey);
  await resend.emails.send({
    from: 'Athletics Business Office <noreply@athletics.utoledo.edu>',
    to: recipients,
    subject: `Urgent Escalation: Health Insurance Request Near Deadline for ${ctx.studentName}`,
    html: baseHtml('Urgent: Request Near Deadline', `
      <p><strong>This request is approaching the enrollment deadline.</strong> If not signed, it will expire.</p>
      ${requestDetails(ctx)}
      <p><a href="${ctx.actionUrl}" style="background:#c8102e;color:#fff;padding:10px 20px;text-decoration:none;border-radius:4px">Take Action Now</a></p>
    `),
  });
}

export async function sendVoidedNotification(resendKey: string, recipients: string[], ctx: EmailContext): Promise<void> {
  const resend = new Resend(resendKey);
  await resend.emails.send({
    from: 'Athletics Business Office <noreply@athletics.utoledo.edu>',
    to: recipients,
    subject: `Voided: Health Insurance Request for ${ctx.studentName}`,
    html: baseHtml('Request Voided', `
      <p>The following health insurance enrollment request has been voided by the CFO.</p>
      ${requestDetails(ctx)}
      ${ctx.voidReason ? `<p><strong>Reason:</strong> ${ctx.voidReason}</p>` : ''}
      <p>If this was an error, please contact the Athletics Business Office to initiate a new request.</p>
    `),
  });
}
