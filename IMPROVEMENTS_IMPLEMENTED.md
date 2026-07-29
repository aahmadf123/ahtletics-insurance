# Athletics Insurance — Improvements Implemented

This document maps the improvement brief to the code that implements it, and lists the
deployment steps the changes require.

## Architectural decisions (confirmed with stakeholder)

- **Coach identity:** kept the one-click anonymous *Coach* login. After a coach picks a
  sport, they select their **registered name** from the new `coaches` table (the request
  form no longer accepts free-text identity unless the sport has no coaches on file yet).
  No per-coach passwords were introduced.
- **Approval flow:** kept the flexible **parallel** approval (`PENDING_APPROVAL` = Sport
  Admin + CFO in any order) and added a **head-coach approval step in front of it**, plus
  `DENIED` as a terminal state:

  ```
  PENDING_COACH (head-coach approval) → PENDING_APPROVAL (Sport Admin + CFO) → EXECUTED
                              └────────────────→ DENIED / VOIDED
  ```

## Database

All schema changes are in **`worker/migrations/0006_improvements.sql`** (existing
migrations are untouched). It adds: `coaches`, `sport_admin_assignments`,
`sports_programs.budget_cap`, `insurance_requests.denial_reason` +
`parent_request_id`, `audit_log.ip_address`, the `uq_request_student_term` partial
unique index, and backfills the head coach of each sport into `coaches`.
`db/schema.ts` (Drizzle reference) was updated to match.

Apply it before/with the next deploy:

```bash
cd worker
npx wrangler d1 migrations apply athletics-insurance-db --remote
```

## Brief → implementation map

| Item | Where |
|---|---|
| 1.1 Head-coach approval routing | `getHeadCoachForSport`, `notifyPendingHeadCoach` (worker); email sent on submit/resubmit/bulk |
| 1.2 Coach name auto-selection | `web/.../request/New.tsx` (registered-coach dropdown per sport) |
| 1.3 Sport-admin sport scoping | `sport_admin_assignments`, `sportAdminScopeIds`, scoping in list/detail/sign/deny + email fan-out |
| 1.4 Denial with reason | `POST /api/requests/:id/deny`, `denial_reason`, deny modal in `Detail.tsx` |
| 1.5 Re-submission after denial | `parent_request_id`, "Fix & Resubmit" prefill flow, `POST /api/requests/:id/resubmit` |
| 1.6 Completion email + PDF | `notifyExecuted/Voided/Denied` fan out to all parties; `buildRequestPdfAttachment` (pdf-lib) |
| 1.7 Full-Year term | `worker/.../validation.ts`, `types.ts` (premium $2,292, Sept 8 deadline) |
| 1.8 Delegation / out-of-office | `coaches.delegated_approver_email` + `delegation_expires_at`; honored in head-coach routing; UI in Sports & Coaches |
| 2.1 Duplicate guard | improved inline 409 message + `uq_request_student_term` index |
| 2.2 Bulk CSV import | client-side CSV parse + preview in `New.tsx`; `POST /api/requests/bulk` |
| 2.3 CFO budget dashboard | `budget_cap`, `GET /api/reports/budget`, Budget tab in `Reports.tsx` (bars + projection) |
| 3.1 Notifications + calendar | `[Action Required]` subjects, deep links, `.ics` attachments (`buildApprovalIcs`) |
| 3.2 Mobile responsiveness | 44px touch targets, responsive checkbox/tab/coach layouts in `index.css` |
| 3.3 Audit log viewer | `audit_log.ip_address`, `GET /api/audit` + `/api/audit/csv`, `pages/AuditLog.tsx` |
| 3.4 Session timeout | `components/SessionTimeout.tsx` (15 min idle + 60 s countdown); cookie `SameSite=Strict; Secure; HttpOnly` |
| 3.5 Rate limiting | in-memory limiter middleware on sign/void/deny/resubmit + auth endpoints → `429` + `Retry-After` |
| 4.1–4.3 Coaches table + UI | `coaches` table, CRUD routes, redesigned Sports & Coaches page with expandable rosters |
| 4.4 Auto-resolved identity | registered-coach dropdown (see 1.2); graceful fallback when a sport has no coaches yet |
| 4.5 Head vs staff workflow | any staff may submit; Step-1 email always routes to the head coach |
| 4.6 Sport-admin registration/management | sport checkboxes at registration and in the Users table; server-side scope enforcement |

## Deployment

Single-origin deploy is unchanged (`cd worker && npx wrangler deploy`). `wrangler.jsonc`
already points at the custom domain and the dedicated sending subdomain; the DNS records
that make that sender deliverable are in `EMAIL_SETUP.md`.

Apply migrations before or with the deploy:

```bash
cd worker
npx wrangler d1 migrations apply athletics-insurance-db --remote
```

## Hardening pass

A later review found a set of defects across auth, authorization, notification delivery,
and the request lifecycle. `migrations/0008_hardening.sql` and the changes alongside it
cover:

| Area | Change |
|---|---|
| Session validity | `currentUser()` re-reads the user row on every request; `users.token_version` in the JWT revokes sessions on password change, reset, and rejection |
| Forced password change | `/change-password` is routed and gated, so admin-issued temporary passwords no longer last indefinitely |
| Reset tokens | Stored as a SHA-256 digest, single live link per account, sessions revoked on use |
| Login | Per-account failure counter and lockout window, backed by D1 rather than per-isolate memory |
| PDF endpoint | Sport-admin scoping applied, and unsigned requests refused |
| Deletion | Requests leave a tombstone audit row; users cannot be deleted by an equal or lower role |
| Submission | Whole batch validated before any write, then committed with `DB.batch()` |
| Query binding | Filters bound in one `bind(...params)` call; chained `.bind()` silently broke any query with two or more parameters |
| Notifications | Plain-text parts, Reply-To, List-Unsubscribe, no urgency-prefixed subjects, no first-contact calendar attachment, visible link target |
| Delivery visibility | `email_log` records every send; shown on the request page with a copy-link fallback |
| Throughput | Fan-out moved to `ctx.waitUntil`, so a large batch no longer blocks the response on dozens of sequential provider calls |
| Reminders | Cover `PENDING_COACH` as well as `PENDING_APPROVAL`, capped at four with escalation, batched per tick |
| Expiry | `EXPIRED` is now actually set by the cron, which also frees the duplicate guard for corrected resubmissions |
| Terms | Premiums and deadlines live once in `shared/terms.ts`; the dropdown resolves each term's year from its own deadline |
| Approval rule | `sports_programs.single_approval` replaces the hardcoded `womens_softball` string |

## Notes / follow-ups

- The one-click anonymous Coach login is unchanged by product decision. A coach session
  requires no verification and can read every request in the system, including student
  names and Rocket numbers, and can sign the head-coach approval step.
- Rate limiting is best-effort per-isolate; for globally-consistent limits, swap in a
  Cloudflare `ratelimit` binding. Login lockout is not affected, being D1-backed.
- Backfilled head coaches inherit whatever email was on `sports_programs`; many are blank
  and should be filled in via **Sports & Coaches** so head-coach approval emails route.
- DNS authentication improves inbox placement at Microsoft but does not guarantee it. If
  the SCL stays at 5 or above after SPF, DKIM, and aligned DMARC all pass, the remaining
  step is a UToledo IT allowlist entry. See the end of `EMAIL_SETUP.md`.
