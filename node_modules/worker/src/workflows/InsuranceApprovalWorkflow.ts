import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../lib/db';
import {
  sendSportAdminNotification,
  sendCfoNotification,
  sendExecutedConfirmation,
  sendReminderEmail,
  sendEscalationEmail,
} from '../lib/email';

export interface InsurancePayload {
  requestId: string;
  sport: string;
  sportDisplayName: string;
  studentName: string;
  rocketNumber: string;
  term: string;
  premiumCost: number;
  coachEmail: string;
  coachName: string;
  sportAdminEmail: string | null;
  sportAdminName: string | null;
}

type ApprovalEvent = { approved: boolean; signatoryEmail: string; signatoryName: string; ipAddress: string };

export class InsuranceApprovalWorkflow extends WorkflowEntrypoint<Env, InsurancePayload> {
  async run(event: WorkflowEvent<InsurancePayload>, step: WorkflowStep) {
    const p = event.payload;
    const db = getDb(this.env.DB);
    const isSoftball = p.sport === 'womens_softball';
    const appUrl = this.env.APP_BASE_URL;
    const actionUrl = `${appUrl}/request/${p.requestId}`;

    const emailCtx = {
      studentName: p.studentName,
      rocketNumber: p.rocketNumber,
      sport: p.sportDisplayName,
      term: p.term,
      premiumCost: p.premiumCost,
      coachName: p.coachName,
      coachEmail: p.coachEmail,
      actionUrl,
      currentStatus: '',
    };

    // ─── Step 1: Sport Admin (skip for softball) ────────────────────────────
    if (!isSoftball && p.sportAdminEmail) {
      await step.do('notify-sport-admin', async () => {
        await sendSportAdminNotification(this.env.RESEND_API_KEY, p.sportAdminEmail!, {
          ...emailCtx,
          currentStatus: 'Pending Sport Administrator Signature',
        });
      });

      // Send 48h reminder via a scheduled sleep + do
      await step.do('schedule-sport-admin-reminder', async () => {
        // Reminder timing is handled by the hourly cron in index.ts
        // which checks request age and sends reminders.
        // This step is intentionally a no-op marker.
      });

      const adminEvent = await step.waitForEvent<ApprovalEvent>('wait-sport-admin', {
        type: 'sport-admin-approval',
        timeout: '72 hours',
      });

      await step.do('log-sport-admin-signature', async () => {
        await db.insert(schema.signatures).values({
          id: crypto.randomUUID(),
          requestId: p.requestId,
          signatoryRole: 'SPORT_ADMIN',
          signatoryEmail: adminEvent.payload.signatoryEmail,
          signatoryName: adminEvent.payload.signatoryName,
          ipAddress: adminEvent.payload.ipAddress,
        });

        await db
          .update(schema.insuranceRequests)
          .set({ status: 'PENDING_CFO' })
          .where(eq(schema.insuranceRequests.id, p.requestId));

        await db.insert(schema.auditLog).values({
          id: crypto.randomUUID(),
          requestId: p.requestId,
          action: 'SIGNED_SPORT_ADMIN',
          performedBy: adminEvent.payload.signatoryEmail,
          details: JSON.stringify({ role: 'SPORT_ADMIN' }),
        });
      });
    } else if (!isSoftball) {
      // No sport admin assigned — escalate directly to CFO
      await step.do('update-to-pending-cfo-no-admin', async () => {
        await db
          .update(schema.insuranceRequests)
          .set({ status: 'PENDING_CFO' })
          .where(eq(schema.insuranceRequests.id, p.requestId));
      });
    } else {
      // Softball: collapse to single CFO step
      await step.do('softball-set-pending-cfo', async () => {
        await db
          .update(schema.insuranceRequests)
          .set({ status: 'PENDING_CFO' })
          .where(eq(schema.insuranceRequests.id, p.requestId));
      });
    }

    // ─── Step 2: CFO Final Approval ─────────────────────────────────────────
    await step.do('notify-cfo', async () => {
      await sendCfoNotification(this.env.RESEND_API_KEY, this.env.CFO_EMAIL, {
        ...emailCtx,
        currentStatus: 'Pending CFO Final Approval',
      });
    });

    const cfoEvent = await step.waitForEvent<ApprovalEvent>('wait-cfo', {
      type: 'cfo-approval',
      timeout: '72 hours',
    });

    // ─── Step 3: Execute ─────────────────────────────────────────────────────
    await step.do('execute-request', async () => {
      await db.insert(schema.signatures).values({
        id: crypto.randomUUID(),
        requestId: p.requestId,
        signatoryRole: isSoftball ? 'SPORT_ADMIN_CFO' : 'CFO',
        signatoryEmail: cfoEvent.payload.signatoryEmail,
        signatoryName: cfoEvent.payload.signatoryName,
        ipAddress: cfoEvent.payload.ipAddress,
      });

      await db
        .update(schema.insuranceRequests)
        .set({ status: 'EXECUTED' })
        .where(eq(schema.insuranceRequests.id, p.requestId));

      await db.insert(schema.auditLog).values({
        id: crypto.randomUUID(),
        requestId: p.requestId,
        action: 'EXECUTED',
        performedBy: cfoEvent.payload.signatoryEmail,
        details: JSON.stringify({ role: isSoftball ? 'SPORT_ADMIN_CFO' : 'CFO' }),
      });

      // Send confirmation to all parties
      const recipients = [p.coachEmail, this.env.CFO_EMAIL];
      if (p.sportAdminEmail && !isSoftball) recipients.push(p.sportAdminEmail);

      await sendExecutedConfirmation(this.env.RESEND_API_KEY, recipients, {
        ...emailCtx,
        currentStatus: 'EXECUTED',
      });
    });
  }
}
