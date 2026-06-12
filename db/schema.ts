import { sqliteTable, text, real, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ─── Users (email+password auth, no SAML) ────────────────────────────────────

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  role: text("role").notNull(), // coach | sport_admin | cfo | super_admin
  sportId: text("sport_id"), // for coaches: their primary sport
  mustChangePassword: integer("must_change_password").notNull().default(0),
  status: text("status").notNull().default("active"), // active | pending | rejected
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});

// ─── Core Tables ────────────────────────────────────────────────────────────

export const insuranceRequests = sqliteTable("insurance_requests", {
  id: text("id").primaryKey(),
  studentName: text("student_name").notNull(),
  rocketNumber: text("rocket_number").notNull(),
  studentEmail: text("student_email"), // optional: student-athlete email for confirmations
  sport: text("sport").notNull(),
  term: text("term").notNull(),
  premiumCost: real("premium_cost").notNull(),
  fundingSource: text("funding_source").notNull().default("operating_budget"), // operating_budget | foundation_account
  status: text("status").notNull().default("PENDING_APPROVAL"),
  workflowInstanceId: text("workflow_instance_id"),
  coachEmail: text("coach_email"), // nullable for anonymous coaches
  coachName: text("coach_name").notNull(),
  denialReason: text("denial_reason"), // set when a head coach / sport admin denies (1.4)
  parentRequestId: text("parent_request_id"), // links a resubmission to the denied original (1.5)
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
  headCoach: text("head_coach"), // derived from coaches WHERE is_head_coach = 1
  headCoachEmail: text("head_coach_email"),
  sportAdminId: text("sport_admin_id").references(() => sportAdministrators.id),
  budgetCap: real("budget_cap"), // optional CFO budget cap per sport (2.3)
});

// ─── Coaches (all coaching staff per sport, multi-staff model) ───────────────

export const coaches = sqliteTable("coaches", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  email: text("email").notNull(),
  sportId: text("sport_id")
    .notNull()
    .references(() => sportsPrograms.id),
  title: text("title"), // Head Coach | Assistant Coach | Volunteer Coach | Other
  isHeadCoach: integer("is_head_coach").notNull().default(0),
  delegatedApproverEmail: text("delegated_approver_email"),
  delegationExpiresAt: text("delegation_expires_at"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

// ─── Sport Administrator ↔ Sport assignments (many-to-many) ──────────────────

export const sportAdminAssignments = sqliteTable("sport_admin_assignments", {
  id: text("id").primaryKey(),
  adminUserId: text("admin_user_id")
    .notNull()
    .references(() => users.id),
  sportId: text("sport_id")
    .notNull()
    .references(() => sportsPrograms.id),
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
  ipAddress: text("ip_address"), // captured for the compliance audit-log viewer (3.3)
  timestamp: text("timestamp").default(sql`CURRENT_TIMESTAMP`),
});

// ─── App Settings ────────────────────────────────────────────────────────────

export const appSettings = sqliteTable("app_settings", {
  settingKey: text("setting_key").primaryKey(),
  settingValue: text("setting_value").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});
