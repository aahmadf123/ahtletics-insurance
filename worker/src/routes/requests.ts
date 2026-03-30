import { Hono } from 'hono';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { getDb, schema } from '../lib/db';
import { getSessionUser } from '../lib/auth';
import { requireRole } from '../lib/rbac';
import { isValidRocketNumber, isValidTerm, sanitiseText } from '../lib/validation';
import { isDeadlinePassed, getPremiumForTerm } from '../data/deadlines';

const requests = new Hono<{ Bindings: Env }>();

// ─── GET /api/requests — list requests filtered by role ──────────────────────
requests.get('/', async (c) => {
  const user = await getSessionUser(c.req.raw, c.env.JWT_SECRET);
  const guard = requireRole(user, 'coach', 'sport_admin', 'cfo');
  if (guard) return guard;

  const db = getDb(c.env.DB);

  let rows;
  if (user!.role === 'coach') {
    rows = await db
      .select()
      .from(schema.insuranceRequests)
      .where(eq(schema.insuranceRequests.coachEmail, user!.email))
      .orderBy(desc(schema.insuranceRequests.createdAt))
      .all();
  } else if (user!.role === 'sport_admin') {
    const sportIds = user!.adminSportIds ?? [];
    if (sportIds.length === 0) return c.json([]);
    rows = await db
      .select()
      .from(schema.insuranceRequests)
      .where(inArray(schema.insuranceRequests.sport, sportIds))
      .orderBy(desc(schema.insuranceRequests.createdAt))
      .all();
  } else {
    // cfo — all requests
    rows = await db
      .select()
      .from(schema.insuranceRequests)
      .orderBy(desc(schema.insuranceRequests.createdAt))
      .all();
  }

  // Log access
  await db.insert(schema.auditLog).values({
    id: crypto.randomUUID(),
    requestId: null,
    action: 'LISTED_REQUESTS',
    performedBy: user!.email,
    details: JSON.stringify({ count: rows.length }),
  });

  return c.json(rows);
});

// ─── POST /api/requests — submit new request (coaches only) ──────────────────
requests.post('/', async (c) => {
  const user = await getSessionUser(c.req.raw, c.env.JWT_SECRET);
  const guard = requireRole(user, 'coach');
  if (guard) return guard;

  const body = await c.req.json<{
    studentName: string;
    rocketNumber: string;
    sport: string;
    term: string;
  }>();

  // Validate inputs
  const studentName  = sanitiseText(body.studentName);
  const rocketNumber = sanitiseText(body.rocketNumber);
  const sport        = sanitiseText(body.sport);
  const term         = sanitiseText(body.term);

  if (!isValidRocketNumber(rocketNumber)) {
    return c.json({ error: 'Invalid Rocket Number format. Must be R followed by 8 digits.' }, 400);
  }
  if (!isValidTerm(term)) {
    return c.json({ error: 'Invalid term format.' }, 400);
  }
  if (isDeadlinePassed(term)) {
    return c.json({ error: 'Enrollment deadline for this term has passed. Contact the Athletics Business Office.' }, 400);
  }

  const premiumCost = getPremiumForTerm(term);
  if (premiumCost === null) {
    return c.json({ error: 'Unknown term. Cannot determine premium.' }, 400);
  }

  const db = getDb(c.env.DB);

  // Verify sport exists
  const sportRow = await db
    .select()
    .from(schema.sportsPrograms)
    .where(eq(schema.sportsPrograms.id, sport))
    .get();
  if (!sportRow) return c.json({ error: 'Unknown sport.' }, 400);

  // Get sport admin info (if assigned)
  let sportAdminEmail: string | null = null;
  let sportAdminName: string | null  = null;
  if (sportRow.sportAdminId) {
    const admin = await db
      .select()
      .from(schema.sportAdministrators)
      .where(eq(schema.sportAdministrators.id, sportRow.sportAdminId))
      .get();
    if (admin) {
      sportAdminEmail = admin.email;
      sportAdminName  = admin.name;
    }
  }

  // Determine initial status
  const isSoftball = sport === 'womens_softball';
  const initialStatus = (isSoftball || !sportAdminEmail) ? 'PENDING_CFO' : 'PENDING_SPORT_ADMIN';

  const requestId = crypto.randomUUID();

  // Write request to D1
  await db.insert(schema.insuranceRequests).values({
    id: requestId,
    studentName,
    rocketNumber,
    sport,
    term,
    premiumCost,
    status: initialStatus,
    coachEmail: user!.email,
    coachName: user!.displayName,
  });

  // Log coach signature
  const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? 'unknown';
  await db.insert(schema.signatures).values({
    id: crypto.randomUUID(),
    requestId,
    signatoryRole: 'COACH',
    signatoryEmail: user!.email,
    signatoryName: user!.displayName,
    ipAddress: ip,
  });

  await db.insert(schema.auditLog).values({
    id: crypto.randomUUID(),
    requestId,
    action: 'SUBMITTED',
    performedBy: user!.email,
    details: JSON.stringify({ studentName, rocketNumber, sport, term, premiumCost }),
  });

  // Start the Cloudflare Workflow
  const workflowInstance = await c.env.INSURANCE_WORKFLOW.create({
    id: requestId,
    params: {
      requestId,
      sport,
      sportDisplayName: sportRow.name,
      studentName,
      rocketNumber,
      term,
      premiumCost,
      coachEmail: user!.email,
      coachName: user!.displayName,
      sportAdminEmail,
      sportAdminName,
    },
  });

  // Store workflow instance ID
  await db
    .update(schema.insuranceRequests)
    .set({ workflowInstanceId: workflowInstance.id })
    .where(eq(schema.insuranceRequests.id, requestId));

  return c.json({ id: requestId, status: initialStatus }, 201);
});

// ─── GET /api/requests/:id — request detail ──────────────────────────────────
requests.get('/:id', async (c) => {
  const user = await getSessionUser(c.req.raw, c.env.JWT_SECRET);
  const guard = requireRole(user, 'coach', 'sport_admin', 'cfo');
  if (guard) return guard;

  const { id } = c.req.param();
  const db = getDb(c.env.DB);

  const row = await db
    .select()
    .from(schema.insuranceRequests)
    .where(eq(schema.insuranceRequests.id, id))
    .get();

  if (!row) return c.json({ error: 'Not found' }, 404);

  // RBAC: coaches can only view their own requests
  if (user!.role === 'coach' && row.coachEmail !== user!.email) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  // RBAC: sport admins can only view requests for their sports
  if (user!.role === 'sport_admin' && !(user!.adminSportIds ?? []).includes(row.sport)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  // Fetch signatures
  const sigs = await db
    .select()
    .from(schema.signatures)
    .where(eq(schema.signatures.requestId, id))
    .all();

  // Log access
  await db.insert(schema.auditLog).values({
    id: crypto.randomUUID(),
    requestId: id,
    action: 'VIEWED',
    performedBy: user!.email,
    details: null,
  });

  return c.json({ ...row, signatures: sigs });
});

// ─── POST /api/requests/:id/sign — apply signature ───────────────────────────
requests.post('/:id/sign', async (c) => {
  const user = await getSessionUser(c.req.raw, c.env.JWT_SECRET);
  const guard = requireRole(user, 'sport_admin', 'cfo');
  if (guard) return guard;

  const { id } = c.req.param();
  const db = getDb(c.env.DB);

  const row = await db
    .select()
    .from(schema.insuranceRequests)
    .where(eq(schema.insuranceRequests.id, id))
    .get();

  if (!row) return c.json({ error: 'Not found' }, 404);

  // Validate allowed state transitions
  if (user!.role === 'sport_admin') {
    if (row.status !== 'PENDING_SPORT_ADMIN') {
      return c.json({ error: 'Request is not awaiting Sport Administrator signature.' }, 409);
    }
    // Ensure this sport admin is assigned to this sport
    if (!(user!.adminSportIds ?? []).includes(row.sport)) {
      return c.json({ error: 'Forbidden: you are not the administrator for this sport.' }, 403);
    }
  }
  if (user!.role === 'cfo' && row.status !== 'PENDING_CFO') {
    return c.json({ error: 'Request is not awaiting CFO signature.' }, 409);
  }

  if (!row.workflowInstanceId) {
    return c.json({ error: 'Workflow instance not found.' }, 500);
  }

  const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? 'unknown';
  const eventType = user!.role === 'cfo' ? 'cfo-approval' : 'sport-admin-approval';

  // Send the approval event to the workflow
  const instance = await c.env.INSURANCE_WORKFLOW.get(row.workflowInstanceId);
  await instance.sendEvent({
    type: eventType,
    payload: {
      approved: true,
      signatoryEmail: user!.email,
      signatoryName: user!.displayName,
      ipAddress: ip,
    },
  });

  return c.json({ ok: true });
});

// ─── POST /api/requests/:id/void — CFO only ──────────────────────────────────
requests.post('/:id/void', async (c) => {
  const user = await getSessionUser(c.req.raw, c.env.JWT_SECRET);
  const guard = requireRole(user, 'cfo');
  if (guard) return guard;

  const { id } = c.req.param();
  const { reason } = await c.req.json<{ reason: string }>();

  if (!reason?.trim()) {
    return c.json({ error: 'A written reason is required to void a request.' }, 400);
  }

  const db = getDb(c.env.DB);

  const row = await db
    .select()
    .from(schema.insuranceRequests)
    .where(eq(schema.insuranceRequests.id, id))
    .get();

  if (!row) return c.json({ error: 'Not found' }, 404);
  if (row.status === 'EXECUTED' || row.status === 'VOIDED' || row.status === 'EXPIRED') {
    return c.json({ error: `Cannot void a request in status: ${row.status}` }, 409);
  }

  await db
    .update(schema.insuranceRequests)
    .set({ status: 'VOIDED' })
    .where(eq(schema.insuranceRequests.id, id));

  await db.insert(schema.auditLog).values({
    id: crypto.randomUUID(),
    requestId: id,
    action: 'VOIDED',
    performedBy: user!.email,
    details: JSON.stringify({ reason: reason.trim() }),
  });

  // Terminate the workflow instance if running
  if (row.workflowInstanceId) {
    try {
      const instance = await c.env.INSURANCE_WORKFLOW.get(row.workflowInstanceId);
      await instance.terminate();
    } catch {
      // Instance may already be completed; ignore
    }
  }

  // Notify coach (and sport admin if assigned)
  // Import lazily to avoid circular deps
  const { sendVoidedNotification } = await import('../lib/email');
  const sportRow = await db
    .select()
    .from(schema.sportsPrograms)
    .where(eq(schema.sportsPrograms.id, row.sport))
    .get();

  const recipients = [row.coachEmail];
  if (sportRow?.sportAdminId) {
    const admin = await db
      .select()
      .from(schema.sportAdministrators)
      .where(eq(schema.sportAdministrators.id, sportRow.sportAdminId))
      .get();
    if (admin) recipients.push(admin.email);
  }

  await sendVoidedNotification(c.env.RESEND_API_KEY, recipients, {
    studentName: row.studentName,
    rocketNumber: row.rocketNumber,
    sport: sportRow?.name ?? row.sport,
    term: row.term,
    premiumCost: row.premiumCost,
    coachName: row.coachName,
    coachEmail: row.coachEmail,
    actionUrl: `${c.env.APP_BASE_URL}/request/${id}`,
    currentStatus: 'VOIDED',
    voidReason: reason.trim(),
  });

  return c.json({ ok: true });
});

export default requests;
