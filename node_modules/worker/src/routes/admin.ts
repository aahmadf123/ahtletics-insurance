import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../lib/db';
import { getSessionUser } from '../lib/auth';
import { requireRole } from '../lib/rbac';

const admin = new Hono<{ Bindings: Env }>();

// ─── GET /api/admin/sports — list all sports with admin assignments ───────────
admin.get('/sports', async (c) => {
  const user = await getSessionUser(c.req.raw, c.env.JWT_SECRET);
  const guard = requireRole(user, 'cfo', 'sport_admin');
  if (guard) return guard;

  const db = getDb(c.env.DB);

  const sports = await db
    .select({
      id:            schema.sportsPrograms.id,
      name:          schema.sportsPrograms.name,
      gender:        schema.sportsPrograms.gender,
      headCoach:     schema.sportsPrograms.headCoach,
      sportAdminId:  schema.sportsPrograms.sportAdminId,
      adminName:     schema.sportAdministrators.name,
      adminEmail:    schema.sportAdministrators.email,
    })
    .from(schema.sportsPrograms)
    .leftJoin(schema.sportAdministrators, eq(schema.sportsPrograms.sportAdminId, schema.sportAdministrators.id))
    .all();

  return c.json(sports);
});

// ─── GET /api/admin/administrators — list all sport administrators ────────────
admin.get('/administrators', async (c) => {
  const user = await getSessionUser(c.req.raw, c.env.JWT_SECRET);
  const guard = requireRole(user, 'cfo', 'sport_admin');
  if (guard) return guard;

  const db = getDb(c.env.DB);
  const admins = await db.select().from(schema.sportAdministrators).all();
  return c.json(admins);
});

// ─── PUT /api/admin/sports/:id — reassign sport admin (CFO only) ─────────────
admin.put('/sports/:id', async (c) => {
  const user = await getSessionUser(c.req.raw, c.env.JWT_SECRET);
  const guard = requireRole(user, 'cfo');
  if (guard) return guard;

  const { id } = c.req.param();
  const { sportAdminId } = await c.req.json<{ sportAdminId: string | null }>();

  const db = getDb(c.env.DB);

  const sport = await db
    .select()
    .from(schema.sportsPrograms)
    .where(eq(schema.sportsPrograms.id, id))
    .get();

  if (!sport) return c.json({ error: 'Sport not found' }, 404);

  if (sportAdminId) {
    const admin = await db
      .select()
      .from(schema.sportAdministrators)
      .where(eq(schema.sportAdministrators.id, sportAdminId))
      .get();
    if (!admin) return c.json({ error: 'Administrator not found' }, 404);
  }

  await db
    .update(schema.sportsPrograms)
    .set({ sportAdminId: sportAdminId ?? null })
    .where(eq(schema.sportsPrograms.id, id));

  await db.insert(schema.auditLog).values({
    id: crypto.randomUUID(),
    requestId: null,
    action: 'SPORT_ADMIN_REASSIGNED',
    performedBy: user!.email,
    details: JSON.stringify({ sport: id, newAdminId: sportAdminId }),
  });

  return c.json({ ok: true });
});

export default admin;
