import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { eq, lt, and, inArray } from 'drizzle-orm';
import { getDb, schema } from './lib/db';
import { sendReminderEmail, sendEscalationEmail } from './lib/email';
import { getTermDeadline } from './data/deadlines';
import authRoutes     from './routes/auth';
import requestRoutes  from './routes/requests';
import adminRoutes    from './routes/admin';
import reportRoutes   from './routes/reports';

export { InsuranceApprovalWorkflow } from './workflows/InsuranceApprovalWorkflow';

const app = new Hono<{ Bindings: Env }>();

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use('*', async (c, next) => {
  const origin = c.env.APP_BASE_URL ?? 'http://localhost:5173';
  return cors({
    origin: [origin, 'http://localhost:5173'],
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  })(c, next);
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.route('/auth',         authRoutes);
app.route('/api/requests', requestRoutes);
app.route('/api/admin',    adminRoutes);
app.route('/api/reports',  reportRoutes);

app.get('/api/health', (c) => c.json({ status: 'ok', ts: new Date().toISOString() }));

// Returns sports + deadlines for the frontend form
app.get('/api/sports', async (c) => {
  const db = getDb(c.env.DB);
  const sports = await db
    .select({
      id:   schema.sportsPrograms.id,
      name: schema.sportsPrograms.name,
      gender: schema.sportsPrograms.gender,
    })
    .from(schema.sportsPrograms)
    .all();
  return c.json(sports);
});

// ─── Scheduled handler — hourly reminder/escalation cron ─────────────────────
async function handleReminders(env: Env): Promise<void> {
  const db = getDb(env.DB);
  const now = Date.now();
  const H48 = 48 * 60 * 60 * 1000;
  const H24 = 24 * 60 * 60 * 1000;

  const pending = await db
    .select()
    .from(schema.insuranceRequests)
    .where(inArray(schema.insuranceRequests.status, ['PENDING_SPORT_ADMIN', 'PENDING_CFO']))
    .all();

  for (const req of pending) {
    const created = new Date(req.createdAt ?? '').getTime();
    const age = now - created;

    // Build action URL
    const actionUrl = `${env.APP_BASE_URL}/request/${req.id}`;

    // Get sport admin email if needed
    let sportAdminEmail: string | null = null;
    if (req.status === 'PENDING_SPORT_ADMIN') {
      const sport = await db
        .select()
        .from(schema.sportsPrograms)
        .where(eq(schema.sportsPrograms.id, req.sport))
        .get();
      if (sport?.sportAdminId) {
        const admin = await db
          .select()
          .from(schema.sportAdministrators)
          .where(eq(schema.sportAdministrators.id, sport.sportAdminId))
          .get();
        sportAdminEmail = admin?.email ?? null;
      }
    }

    const emailCtx = {
      studentName: req.studentName,
      rocketNumber: req.rocketNumber,
      sport: req.sport,
      term: req.term,
      premiumCost: req.premiumCost,
      coachName: req.coachName,
      coachEmail: req.coachEmail,
      actionUrl,
      currentStatus: req.status,
    };

    // Check if near term deadline (escalate within 24h of term deadline)
    const deadline = getTermDeadline(req.term);
    if (deadline && (deadline.getTime() - now) < H24) {
      await sendEscalationEmail(env.RESEND_API_KEY, [env.CFO_EMAIL], emailCtx);
      continue;
    }

    // 48h reminder (send once around the 48h mark — within a 1h window)
    if (age >= H48 && age < H48 + 60 * 60 * 1000) {
      const to = req.status === 'PENDING_SPORT_ADMIN' && sportAdminEmail
        ? sportAdminEmail
        : env.CFO_EMAIL;
      await sendReminderEmail(env.RESEND_API_KEY, to, emailCtx);
    }
  }
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleReminders(env));
  },
};
