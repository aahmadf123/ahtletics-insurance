import { eq } from 'drizzle-orm';
import { type Db, schema } from './db';
import type { SessionUser } from './auth';

/**
 * Determines the role of a user from their email address.
 * - If the email matches a sport_admin with is_cfo=1  → 'cfo'
 * - If the email matches any sport_admin               → 'sport_admin'
 * - Otherwise                                          → 'coach'
 */
export async function resolveRole(db: Db, email: string): Promise<SessionUser['role']> {
  const admin = await db
    .select()
    .from(schema.sportAdministrators)
    .where(eq(schema.sportAdministrators.email, email.toLowerCase()))
    .get();

  if (!admin) return 'coach';
  return admin.isCfo ? 'cfo' : 'sport_admin';
}

/**
 * Returns the sport IDs that a sport_admin is responsible for.
 */
export async function getAdminSportIds(db: Db, email: string): Promise<string[]> {
  const admin = await db
    .select()
    .from(schema.sportAdministrators)
    .where(eq(schema.sportAdministrators.email, email.toLowerCase()))
    .get();

  if (!admin) return [];

  const sports = await db
    .select({ id: schema.sportsPrograms.id })
    .from(schema.sportsPrograms)
    .where(eq(schema.sportsPrograms.sportAdminId, admin.id))
    .all();

  return sports.map(s => s.id);
}

/**
 * Middleware helper — returns 403 JSON if the user's role is not in `allowed`.
 */
export function requireRole(user: SessionUser | null, ...allowed: string[]): Response | null {
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthenticated' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!allowed.includes(user.role)) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return null;
}
