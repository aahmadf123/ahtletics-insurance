import { Hono } from 'hono';
import { eq, desc, sql } from 'drizzle-orm';
import { getDb, schema } from '../lib/db';
import { getSessionUser } from '../lib/auth';
import { requireRole } from '../lib/rbac';

const reports = new Hono<{ Bindings: Env }>();

// ─── GET /api/reports/summary — aggregate premiums per sport/term/coach ───────
reports.get('/summary', async (c) => {
  const user = await getSessionUser(c.req.raw, c.env.JWT_SECRET);
  const guard = requireRole(user, 'cfo');
  if (guard) return guard;

  const db = getDb(c.env.DB);

  const sportFilter   = c.req.query('sport')   ?? undefined;
  const termFilter    = c.req.query('term')    ?? undefined;
  const statusFilter  = c.req.query('status')  ?? undefined;
  const coachFilter   = c.req.query('coach')   ?? undefined;

  // Build filtered request list
  let query = db.select().from(schema.insuranceRequests);
  const rows = await query.orderBy(desc(schema.insuranceRequests.createdAt)).all();

  const filtered = rows.filter(r =>
    (!sportFilter  || r.sport      === sportFilter)  &&
    (!termFilter   || r.term       === termFilter)   &&
    (!statusFilter || r.status     === statusFilter) &&
    (!coachFilter  || r.coachEmail === coachFilter),
  );

  // Aggregate: total premium per sport
  const bySport: Record<string, number> = {};
  const byTerm:  Record<string, number> = {};
  const byCoach: Record<string, number> = {};

  for (const r of filtered) {
    bySport[r.sport]      = (bySport[r.sport]      ?? 0) + r.premiumCost;
    byTerm[r.term]        = (byTerm[r.term]         ?? 0) + r.premiumCost;
    byCoach[r.coachEmail] = (byCoach[r.coachEmail]  ?? 0) + r.premiumCost;
  }

  return c.json({ requests: filtered, totals: { bySport, byTerm, byCoach } });
});

// ─── GET /api/reports/export — CSV export ────────────────────────────────────
reports.get('/export', async (c) => {
  const user = await getSessionUser(c.req.raw, c.env.JWT_SECRET);
  const guard = requireRole(user, 'cfo');
  if (guard) return guard;

  const db = getDb(c.env.DB);
  const rows = await db
    .select()
    .from(schema.insuranceRequests)
    .orderBy(desc(schema.insuranceRequests.createdAt))
    .all();

  const header = 'ID,Student Name,Rocket Number,Sport,Term,Premium Cost,Status,Coach Email,Coach Name,Created At\r\n';
  const lines = rows.map(r =>
    [r.id, `"${r.studentName}"`, r.rocketNumber, r.sport, r.term,
     r.premiumCost, r.status, r.coachEmail, `"${r.coachName}"`, r.createdAt].join(','),
  );

  await db.insert(schema.auditLog).values({
    id: crypto.randomUUID(),
    requestId: null,
    action: 'EXPORTED_CSV',
    performedBy: user!.email,
    details: JSON.stringify({ rowCount: rows.length }),
  });

  return new Response(header + lines.join('\r\n'), {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="insurance-requests-${Date.now()}.csv"`,
    },
  });
});

export default reports;
