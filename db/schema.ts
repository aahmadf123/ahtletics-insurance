import { sqliteTable, text, real, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ─── Users ──────────────────────────────────────────────────────────────────

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});

// ─── Core Tables ────────────────────────────────────────────────────────────

export const insuranceRequests = sqliteTable("insurance_requests", {
  id: text("id").primaryKey(),
  studentName: text("student_name").notNull(),
  rocketNumber: text("rocket_number").notNull(),
  sport: text("sport").notNull(),
  term: text("term").notNull(),
  premiumCost: real("premium_cost").notNull(),
  status: text("status").notNull().default("PENDING_SPORT_ADMIN"),
  workflowInstanceId: text("workflow_instance_id"),
  coachEmail: text("coach_email").notNull(),
  coachName: text("coach_name").notNull(),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export const signatures = sqliteTable("signatures", {
  id: text("id").primaryKey(),
  requestId: text("request_id")
    .notNull()
    .references(() => insuranceRequests.id),
  signatoryRole: text("signatory_role").notNull(), // COACH | SPORT_ADMIN | CFO
  signatoryEmail: text("signatory_email").notNull(),
  signatoryName: text("signatory_name").notNull(),
  ipAddress: text("ip_address").notNull(),
  timestamp: text("timestamp").default(sql`CURRENT_TIMESTAMP`),
});

// ─── Lookup Tables ───────────────────────────────────────────────────────────

export const sportsPrograms = sqliteTable("sports_programs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  gender: text("gender").notNull(), // Mens | Womens
  headCoach: text("head_coach"),
  sportAdminId: text("sport_admin_id").references(() => sportAdministrators.id),
});

export const sportAdministrators = sqliteTable("sport_administrators", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  title: text("title").notNull(),
  email: text("email").notNull(),
  isCfo: integer("is_cfo").notNull().default(0), // 1 = also the CFO
});

// ─── Audit Log ───────────────────────────────────────────────────────────────

export const auditLog = sqliteTable("audit_log", {
  id: text("id").primaryKey(),
  requestId: text("request_id").references(() => insuranceRequests.id),
  action: text("action").notNull(),
  performedBy: text("performed_by").notNull(),
  details: text("details"),
  timestamp: text("timestamp").default(sql`CURRENT_TIMESTAMP`),
});