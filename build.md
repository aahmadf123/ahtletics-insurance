# University of Toledo — Student-Athlete Health Insurance Request App
## Complete Build Guide

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Tech Stack](#2-tech-stack)
3. [Regulatory & Compliance Requirements](#3-regulatory--compliance-requirements)
4. [Entity & Data Modeling](#4-entity--data-modeling)
5. [Database Schema (Cloudflare D1)](#5-database-schema-cloudflare-d1)
6. [Workflow & State Machine](#6-workflow--state-machine)
7. [Authentication & Access Control](#7-authentication--access-control)
8. [Frontend UI Requirements](#8-frontend-ui-requirements)
9. [Email Notification System](#9-email-notification-system)
10. [Business Logic Rules](#10-business-logic-rules)
11. [Sports & Routing Reference Data](#11-sports--routing-reference-data)
12. [Insurance Premium & Deadline Reference Data](#12-insurance-premium--deadline-reference-data)
13. [Folder Structure](#13-folder-structure)
14. [Environment Variables & Secrets](#14-environment-variables--secrets)
15. [Deployment](#15-deployment)

---

## 1. Project Overview

The University of Toledo Athletics department needs a secure, digitized web application that allows **head or assistant coaches** to request enrollment of a student-athlete into the university-sponsored **Anthem Student Advantage** health insurance plan, charged to that coach's specific program operating budget.

**The central Athletics department does not subsidize this cost.** Each request must go through a 3-tier sequential signature workflow before it is considered executed.

### Who Uses This App

| Role | Action |
|---|---|
| **Coach** | Initiates the request, applies first signature |
| **Sport Administrator** | Reviews and applies second signature |
| **CFO (Melissa DeAngelo)** | Final approval, authorizes budget deduction |

### What It Replaces
Manual paper/email workflows — replaced with a centralized, auditable, deadline-enforced web app.

---

## 2. Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | Cloudflare Pages (React or HonoX) |
| **Backend / API** | Cloudflare Workers (TypeScript) |
| **Database** | Cloudflare D1 (SQLite-based, serverless) |
| **Workflow Engine** | Cloudflare Workflows (durable, human-in-the-loop) |
| **Authentication** | Microsoft Entra ID (Azure AD) + Shibboleth SAML SSO |
| **Email** | Resend API (via Workers) |
| **ORM (optional)** | Drizzle ORM or Kysely (D1-compatible) |

---

## 3. Regulatory & Compliance Requirements

### FERPA
- Protects student educational records.
- Student name, Rocket Number, and insurance enrollment status are educational records.
- Access must be limited strictly to authorized personnel.

### HIPAA
- The app does **not** store medical diagnoses or treatment codes (which would trigger strict HIPAA PHI rules).
- However, health insurance facilitation requires confidentiality protocols aligned with HIPAA principles.
- Athletic training staff and compliance officers must operate under a dual-compliance mindset.

### Implementation Requirements
- **Principle of Least Privilege**: Only the initiating coach, the relevant Sport Administrator, and the CFO may read or write a specific request record.
- **Comprehensive Audit Logging**: Every access, modification, and signature event must be permanently logged.
- **Immutability**: Once submitted, core fields (student name, Rocket Number, sport) are locked. Only workflow state fields may be updated.
- **Non-Repudiation**: MFA via Microsoft Authenticator (inherited from UToledo SSO) provides cryptographic identity assurance for each digital signature.

---

## 4. Entity & Data Modeling

### Rocket Number Validation
- Format: Letter `R` followed by exactly **8 numerical digits**
- Regex: `/^R\d{8}$/`
- Must be validated on **both** frontend and backend (Worker) before any DB transaction
- Optionally: perform a real-time lookup against the university Student Information System (SIS) API to confirm the Rocket Number matches the submitted student-athlete name

### Sports Programs
16 NCAA Division I sports. Must be stored in a `sports_programs` lookup table in D1.

### Sport Administrator Routing Matrix
Each sport maps to a specific administrator. This mapping drives the email routing for Step 2 of the workflow.

### Melissa DeAngelo — Dual Role Logic
- She is **both** the Sport Administrator for Softball **and** the final CFO signatory for all requests.
- For Softball requests: the workflow **collapses Steps 2 and 3** into a single approval step — she signs once, not twice.
- This must be handled in the Workflow code via a conditional check:
```typescript
if (sport === 'softball') {
  // Skip Step 2, go directly to combined Step 2+3 for CFO
}
```

---

## 5. Database Schema (Cloudflare D1)

### Table: `insurance_requests`

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY, UUID | Unique cryptographic identifier |
| `student_name` | TEXT | NOT NULL | Full name of the student-athlete |
| `rocket_number` | TEXT | NOT NULL | Validated Rocket Number (e.g., R12345678) |
| `sport` | TEXT | NOT NULL | Selected sport (e.g., 'womens_basketball') |
| `term` | TEXT | NOT NULL | Academic term (e.g., 'Fall 2025') |
| `premium_cost` | REAL | NOT NULL | Exact premium for the selected term |
| `status` | TEXT | NOT NULL | State machine value (see below) |
| `workflow_instance_id` | TEXT | NULL | Cloudflare Workflow instance ID |
| `coach_email` | TEXT | NOT NULL | Authenticated coach's email |
| `created_at` | DATETIME | DEFAULT CURRENT_TIMESTAMP | Timestamp of coach initiation |

**Valid `status` values:**
- `PENDING_SPORT_ADMIN` — awaiting Sport Admin signature
- `PENDING_CFO` — awaiting CFO signature
- `EXECUTED` — fully approved
- `VOIDED` — voided by CFO
- `EXPIRED` — deadline passed before completion

### Table: `signatures`

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY, UUID | Unique identifier for this signature event |
| `request_id` | TEXT | FOREIGN KEY → `insurance_requests.id` | Links to the parent request |
| `signatory_role` | TEXT | NOT NULL | `COACH`, `SPORT_ADMIN`, or `CFO` |
| `signatory_email` | TEXT | NOT NULL | Authenticated email of the signer |
| `ip_address` | TEXT | NOT NULL | Network IP address for audit |
| `timestamp` | DATETIME | DEFAULT CURRENT_TIMESTAMP | Exact server time of signature |

### Table: `sports_programs`

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | e.g., `womens_basketball` |
| `display_name` | TEXT | NOT NULL | e.g., `Women's Basketball` |
| `gender` | TEXT | NOT NULL | `mens` or `womens` |
| `head_coach` | TEXT | NULL | Head coach name |
| `sport_admin_email` | TEXT | NULL | Routed Sport Administrator email |
| `sport_admin_name` | TEXT | NULL | Routed Sport Administrator name |

### Table: `audit_log`

| Column | Type | Description |
|---|---|---|
| `id` | TEXT | UUID |
| `request_id` | TEXT | FK to insurance_requests |
| `actor_email` | TEXT | Who performed the action |
| `action` | TEXT | e.g., `VIEWED`, `SIGNED`, `VOIDED` |
| `timestamp` | DATETIME | Server time |
| `metadata` | TEXT | JSON blob of additional context |

### Immutability Enforcement (SQL)
```sql
-- Only these columns may ever be updated after creation:
-- status, workflow_instance_id
-- All others must be enforced as read-only at the Worker level (not DB triggers,
-- since D1/SQLite has limited trigger support)
```

---

## 6. Workflow & State Machine

### Overview
Uses **Cloudflare Workflows** for durable, asynchronous execution. The workflow pauses execution (without consuming compute) while waiting for human approval.

### State Machine Diagram

```
Coach Submits
     │
     ▼
[PENDING_SPORT_ADMIN]
  - Email sent to Sport Admin
  - waitForApproval(72h timeout)
  - 48h: reminder email
  - 24h before deadline: escalate to CFO + Compliance
     │
     ▼ (Sport Admin signs)
[PENDING_CFO]
  - Email sent to Melissa DeAngelo
  - waitForApproval(72h timeout)
     │
     ▼ (CFO signs)
[EXECUTED]
  - Confirmation email to Coach, Admin, CFO
  - PDF receipt generated
```

**Exception for Softball:**
```
Coach (Softball) Submits
     │
     ▼
[PENDING_CFO]  ← Step 2 skipped
  - Email sent directly to Melissa DeAngelo
  - waitForApproval(72h timeout)
     │
     ▼
[EXECUTED]
```

### Workflow TypeScript Skeleton

```typescript
import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

export class InsuranceWorkflow extends WorkflowEntrypoint {
  async run(event: WorkflowEvent<InsurancePayload>, step: WorkflowStep) {

    // Step 1: Write record to D1, log coach signature
    await step.do('initialize-request', async () => {
      // DB write, log signature
    });

    const isSoftball = event.payload.sport === 'softball';

    // Step 2: Sport Admin (skip for softball)
    if (!isSoftball) {
      await step.do('notify-sport-admin', async () => {
        // Send email to sport admin
      });

      await step.waitForEvent('sport-admin-approval', {
        timeout: '72h',
      });

      await step.do('log-sport-admin-signature', async () => {
        // Log signature, update status to PENDING_CFO
      });
    }

    // Step 3: CFO
    await step.do('notify-cfo', async () => {
      // Send email to melissa.deangelo@utoledo.edu
    });

    await step.waitForEvent('cfo-approval', {
      timeout: '72h',
    });

    await step.do('finalize-request', async () => {
      // Log CFO signature, update status to EXECUTED
      // Send confirmation emails
      // Generate PDF receipt
    });
  }
}
```

### Timeout & Escalation Logic

| Time Elapsed | Action |
|---|---|
| 48 hours with no action | Send reminder email to pending signatory |
| 24 hours before term deadline | Escalate to Melissa DeAngelo + Compliance Office |
| Workflow timeout (72h) | Mark request as `EXPIRED`, notify coach |

---

## 7. Authentication & Access Control

### SSO Integration
- **Identity Provider**: Microsoft Entra ID (Azure AD)
- **Protocol**: SAML 2.0 via Shibboleth proxy
- **MFA**: Microsoft Authenticator (push notification) — inherited automatically from UToledo SSO

### SAML Configuration (register app in Entra ID)

| Field | Value |
|---|---|
| **Identifier (Entity ID)** | Globally unique URI for this Cloudflare app |
| **Reply URL (ACS URL)** | `https://<your-worker>.workers.dev/auth/callback` |
| **Sign-on URL** | `https://<your-pages>.pages.dev` |

### Required SAML Attribute Claims

| Claim | Mapped To | Use |
|---|---|---|
| `SamAccountName` | `UTADusername` | Internal identity, DB lookups |
| `user.mail` | `email` | e.g., `firstname.lastname@utoledo.edu` — routing |
| `user.displayName` | `displayName` | UI display |

### RBAC Rules (enforced at Worker API level)

| Role | Can Do |
|---|---|
| **Coach** | Create new requests; view only their own requests |
| **Sport Admin** | View + sign requests assigned to their sports only; cannot initiate |
| **CFO** | Global read access to all requests; sign any pending final request; access aggregate financial reports; void any request |

### Role Determination Logic
- On SAML login, read the authenticated `email` from the claims.
- Cross-reference against the `sports_programs` table (for Sport Admins) and a `system_roles` table (for CFO).
- Coaches are any authenticated user not found in the admin tables.

---

## 8. Frontend UI Requirements

### Pages / Routes

| Route | Description |
|---|---|
| `/` | Login / SSO redirect |
| `/dashboard` | Role-based landing (Coach, Admin, or CFO view) |
| `/request/new` | New insurance request form (Coach only) |
| `/request/:id` | Request detail / signature page |
| `/admin/sports` | Manage sport-to-admin routing (admin only) |
| `/reports` | Aggregate budget deduction reports (CFO only) |

### New Request Form Fields

| Field | Type | Validation |
|---|---|---|
| Student-Athlete Full Name | Text | Required |
| Rocket Number | Text | Required; regex `/^R\d{8}$/` |
| Sport | Dropdown | Populated from `sports_programs` table; pre-selected based on coach's profile |
| Academic Term | Dropdown | Fall / Spring-Summer / Summer |
| Premium Cost | Display only | Auto-populated based on term selection |

### Mandatory Disclaimer Checkboxes
All three must be checked before the Submit button activates.

**Disclaimer 1 — Budget Deduction:**
> "By checking this box and applying my digital signature, I acknowledge and authorize that the total cost of the student-athlete health insurance premium for the selected term will be deducted entirely from my program's operating budget. I understand that the central Athletics department will not cover or subsidize this expense under any circumstances."

**Disclaimer 2 — Deadline Acknowledgment:**
> "Submission Deadline Disclaimer: All requests for health insurance enrollment must be fully executed and submitted prior to the start of the semester. The deadline for the upcoming term is **[DYNAMIC DATE]**. I acknowledge that requests submitted after this date will be automatically rejected by the system."

**Disclaimer 3 — Finality of Submission:**
> "Finality of Submission: I acknowledge that once this request is submitted and the signature routing process begins, no further changes, edits, or retractions can be made to this document. If an error is discovered regarding the student-athlete name or Rocket Number, the request must be formally voided by the Chief Financial Officer and a new request must be initiated."

### Deadline Enforcement (Frontend + Backend)
- On page load, the Worker fetches the current server date.
- If the current date exceeds the active term deadline, the entire form is **locked** — the coach sees a message directing them to contact the business office.
- This check must also run server-side in the Worker before writing to D1.

### Coach Dashboard — Required Features
- List of all requests they submitted with current status
- Status badge: `Pending Sport Admin` / `Pending CFO` / `Executed` / `Voided` / `Expired`
- Ability to view a read-only detail view of any submitted request
- No ability to edit or delete submitted requests

### Sport Admin Dashboard — Required Features
- List of all requests routed to them requiring action
- Ability to open the request detail, review all data, and apply signature
- View-only access to their previously signed requests and their final outcomes

### CFO Dashboard — Required Features
- Global view of all requests across all sports, all statuses
- Filter by sport, term, status, coach
- Ability to sign any `PENDING_CFO` request
- Ability to void any active request (with required reason field)
- Aggregate financial report: total premium commitments per sport, per term, per coach
- Export to CSV

---

## 9. Email Notification System

### Provider
**Resend API** — integrated via the official Resend SDK for Cloudflare Workers.

### DNS Configuration Required (UToledo IT)
- SPF record authorizing Resend to send from `@utoledo.edu` or `@athletics.utoledo.edu`
- DKIM signature record
- DMARC policy record

### Email Triggers & Recipients

| Trigger | Recipient | Subject Line |
|---|---|---|
| Request submitted | Sport Administrator | `Action Required: Health Insurance Request for [Student Name] – [Sport]` |
| Sport Admin signs | CFO (Melissa DeAngelo) | `Action Required: Final Approval – Health Insurance Request for [Student Name]` |
| CFO approves | Coach + Sport Admin + CFO | `Executed: Health Insurance Request for [Student Name] – [Term]` |
| 48h no action | Pending signatory | `Reminder: Action Required – Health Insurance Request Pending Your Signature` |
| 24h before deadline | CFO + Compliance Office | `Urgent Escalation: Health Insurance Request Near Deadline for [Student Name]` |
| Request voided | Coach + Sport Admin | `Voided: Health Insurance Request for [Student Name]` |

### Required Email Body Contents
Every notification email must include:
- Student-athlete full name
- Rocket Number
- Sport
- Requesting coach name and email
- Academic term
- **Exact premium cost** and explicit statement that it will be deducted from the coach's operating budget
- Current workflow status
- A secure, parameterized action link back to the app for signing

### Resend API Call Pattern (Worker)
```typescript
import { Resend } from 'resend';

const resend = new Resend(env.RESEND_API_KEY);

await resend.emails.send({
  from: 'Athletics Business Office <noreply@athletics.utoledo.edu>',
  to: recipientEmail,
  subject: `Action Required: Health Insurance Request for ${studentName}`,
  html: buildEmailTemplate({ studentName, rocketNumber, sport, term, premiumCost, actionUrl }),
});
```

---

## 10. Business Logic Rules

### Request Submission
1. Validate Rocket Number format client-side and server-side.
2. Verify current date is before the active term deadline.
3. All three disclaimer checkboxes must be checked.
4. Coach must be authenticated via SSO.
5. On submit: write to D1, instantiate Cloudflare Workflow, log coach signature in `signatures` table.

### Immutability
- After submission, `student_name`, `rocket_number`, `sport`, `term`, and `premium_cost` are permanently locked.
- The Worker must reject any API request attempting to modify these fields after creation.
- Only `status` and `workflow_instance_id` may be updated post-creation.

### Voiding
- Only the CFO can void a request.
- Voiding requires a written reason (stored in `audit_log`).
- Voiding terminates the Cloudflare Workflow instance.
- Coach is notified via email.

### Softball Exception
- If `sport === 'softball'`, skip the Sport Admin routing step.
- Send directly to Melissa DeAngelo as a combined Sport Admin + CFO approval.
- She signs once, request moves to `EXECUTED`.

### Unassigned Sport Admins
- Men's Golf, Women's Golf, Men's Tennis, Women's Tennis do not have a formally documented executive Sport Administrator.
- System administrator must be able to assign a Sport Admin to these sports via the `/admin/sports` management page.
- If no Sport Admin is assigned, the system must either:
  - Route to a "General Operations" queue, **or**
  - Escalate directly to the CFO
- This fallback must be configurable by the system admin.

---

## 11. Sports & Routing Reference Data

### All 16 Sports — Seed Data for `sports_programs` Table

| ID | Display Name | Gender | Head Coach | Sport Admin | Admin Email |
|---|---|---|---|---|---|
| `mens_baseball` | Baseball | Mens | Rob Reinstetle | Tim Warga | tim.warga@utoledo.edu |
| `mens_basketball` | Men's Basketball | Mens | Tod Kowalczyk | Connor Whelan | connor.whelan@utoledo.edu |
| `mens_cross_country` | Men's Cross Country | Mens | Linh Nguyen / Andrea Grove-McDonough | Brian Lutz | brian.lutz@utoledo.edu |
| `mens_football` | Football | Mens | Mike Jacobs | Nicole Harris | nicole.harris@utoledo.edu |
| `mens_golf` | Men's Golf | Mens | Jeff Roope | *Unassigned* | — |
| `mens_tennis` | Men's Tennis | Mens | TBD | *Unassigned* | — |
| `womens_basketball` | Women's Basketball | Womens | Ginny Boggess | Nicole Harris | nicole.harris@utoledo.edu |
| `womens_cross_country` | Women's Cross Country | Womens | Linh Nguyen / Andrea Grove-McDonough | Brian Lutz | brian.lutz@utoledo.edu |
| `womens_golf` | Women's Golf | Womens | Ali Green | *Unassigned* | — |
| `womens_rowing` | Women's Rowing | Womens | Chris Bailey-Greene | Nicole Harris | nicole.harris@utoledo.edu |
| `womens_soccer` | Women's Soccer | Womens | Mark Batman | Brian Lutz | brian.lutz@utoledo.edu |
| `womens_softball` | Softball | Womens | Jessica Bracamonte | **Melissa DeAngelo (CFO)** | melissa.deangelo@utoledo.edu |
| `womens_swimming` | Women's Swimming & Diving | Womens | Jacy Dyer | Nicole Harris | nicole.harris@utoledo.edu |
| `womens_tennis` | Women's Tennis | Womens | TBD | *Unassigned* | — |
| `womens_track` | Women's Track & Field | Womens | Linh Nguyen / Andrea Grove-McDonough | Brian Lutz | brian.lutz@utoledo.edu |
| `womens_volleyball` | Women's Volleyball | Womens | TBD | Connor Whelan | connor.whelan@utoledo.edu |

### Sport Administrator Reference

| Administrator | Title | Assigned Sports |
|---|---|---|
| **Nicole Harris** | Deputy AD / COO / Senior Woman Administrator | Football, Women's Basketball, Women's Swimming & Diving, Women's Rowing |
| **Connor Whelan** | Deputy AD / Chief Revenue Officer | Men's Basketball, Women's Volleyball |
| **Brian Lutz** | Senior Associate AD of Compliance and Integrity | Women's Soccer, Women's Track & Field, Women's Cross Country, Men's Cross Country |
| **Tim Warga** | Associate AD of Operations/Events | Baseball |
| **Melissa DeAngelo** | Senior Associate AD for Business Strategy / CFO | Softball (**+ Final CFO signatory for ALL sports**) |

---

## 12. Insurance Premium & Deadline Reference Data

### Anthem Student Advantage — Premium Costs

| Academic Term | Coverage Period | Student Premium |
|---|---|---|
| **Fall** | August 11 – December 31 | **$898.00** |
| **Spring/Summer** | January 1 – August 10 | **$1,394.00** |
| **Summer Only** | May 11 – August 10 | **$546.00** |

> The frontend must dynamically display the correct premium based on the selected term, before the coach applies their signature.

### Enrollment Deadlines

| Term | Deadline |
|---|---|
| **Fall** | September 8 |
| **Spring/Summer** | January 26 |
| **Summer** | July 1 |

> After these dates, the application must lock and prevent new submissions.

### Plan Details (display in UI for coach awareness)
- Plan: **Anthem Student Advantage — Blue Access PPO Network**
- **$0 deductible** at the University of Toledo Medical Center (UTMC)
- Access to Sydney Health App
- LiveHealth Online video visits
- GeoBlue global emergency coverage

---

## 13. Folder Structure

```
/
├── apps/
│   ├── web/                   # Cloudflare Pages (React frontend)
│   │   ├── src/
│   │   │   ├── pages/
│   │   │   │   ├── dashboard/
│   │   │   │   ├── request/
│   │   │   │   │   ├── new.tsx         # New request form
│   │   │   │   │   └── [id].tsx        # Request detail / signature
│   │   │   │   ├── admin/
│   │   │   │   │   └── sports.tsx      # Sport-admin routing management
│   │   │   │   └── reports.tsx         # CFO financial reports
│   │   │   ├── components/
│   │   │   │   ├── DisclaimerCheckboxes.tsx
│   │   │   │   ├── RequestStatusBadge.tsx
│   │   │   │   └── PremiumDisplay.tsx
│   │   │   └── lib/
│   │   │       ├── auth.ts             # SAML/SSO helpers
│   │   │       └── api.ts              # API client
│   │   └── wrangler.toml
│   │
│   └── worker/                # Cloudflare Worker (API + Workflow)
│       ├── src/
│       │   ├── index.ts               # Worker entry point / router
│       │   ├── routes/
│       │   │   ├── requests.ts        # CRUD for insurance_requests
│       │   │   ├── signatures.ts      # Signature submission endpoint
│       │   │   ├── auth.ts            # SAML callback handler
│       │   │   └── admin.ts           # Sport admin management
│       │   ├── workflows/
│       │   │   └── InsuranceWorkflow.ts
│       │   ├── lib/
│       │   │   ├── db.ts              # D1 query helpers
│       │   │   ├── email.ts           # Resend integration
│       │   │   ├── validation.ts      # Rocket Number + deadline checks
│       │   │   └── rbac.ts            # Role enforcement
│       │   └── data/
│       │       ├── sports.ts          # Sports seed data
│       │       └── deadlines.ts       # Term deadline constants
│       └── wrangler.toml
│
├── migrations/                # D1 SQL migration files
│   ├── 0001_initial_schema.sql
│   ├── 0002_sports_seed.sql
│   └── 0003_audit_log.sql
│
└── README.md
```

---

## 14. Environment Variables & Secrets

Store all secrets in **Cloudflare Secrets** (never commit to source):

```bash
wrangler secret put RESEND_API_KEY
wrangler secret put SAML_PRIVATE_KEY
wrangler secret put SAML_IDP_CERT
```

### `wrangler.toml` Bindings

```toml
name = "insurance-worker"
compatibility_date = "2024-01-01"

[[d1_databases]]
binding = "DB"
database_name = "insurance-db"
database_id = "<your-d1-database-id>"

[[workflows]]
binding = "INSURANCE_WORKFLOW"
name = "insurance-request-workflow"
class_name = "InsuranceWorkflow"

[vars]
CFO_EMAIL = "melissa.deangelo@utoledo.edu"
FROM_EMAIL = "noreply@athletics.utoledo.edu"
APP_BASE_URL = "https://<your-pages-domain>.pages.dev"
```

---

## 15. Deployment

### Initial Setup
```bash
# Install dependencies
npm install

# Create D1 database
wrangler d1 create insurance-db

# Run migrations
wrangler d1 migrations apply insurance-db

# Deploy Worker
wrangler deploy

# Deploy Frontend (Cloudflare Pages)
# Connect GitHub repo in Cloudflare Pages dashboard
# Set build command: npm run build
# Set output directory: dist
```

### SAML Setup Checklist
- [ ] Register app in Microsoft Entra ID as a non-gallery enterprise application
- [ ] Configure Entity ID and ACS (Reply) URL in Entra ID
- [ ] Download IdP XML metadata from Entra ID
- [ ] Configure Worker SAML SP using IdP metadata
- [ ] Exchange metadata with UToledo Central IT
- [ ] Request required SAML attribute claims: `SamAccountName`, `user.mail`, `user.displayName`
- [ ] Test SSO login end-to-end

### DNS Setup Checklist (via UToledo IT)
- [ ] Add SPF record for Resend
- [ ] Add DKIM record for Resend
- [ ] Add DMARC policy for `athletics.utoledo.edu`
- [ ] Verify domain in Resend dashboard

### Go-Live Checklist
- [ ] All 3 disclaimer checkboxes enforced before submit
- [ ] Deadline enforcement blocks submissions after cutoff
- [ ] Softball dual-role logic tested end-to-end
- [ ] Unassigned sport fallback (Golf/Tennis) configured
- [ ] 48h reminder emails firing correctly
- [ ] 24h escalation emails firing correctly
- [ ] RBAC confirmed: coaches cannot see other coaches' requests
- [ ] CFO void function tested
- [ ] Audit log recording all events
- [ ] D1 Time Travel / backups enabled

---

*Last updated: March 30, 2026 | University of Toledo Athletics — Business Office*