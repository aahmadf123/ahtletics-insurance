# Athletics Insurance Portal: End-to-End Audit and Implementation Plan

Date: 2026-07-29
Scope: `worker/` (Hono API + cron), `web/` (React SPA), `worker/migrations/`, deployment config.
Method: full read of every source file, TypeScript build of both workspaces, migration trace, workflow trace against `build.md`.

Both workspaces compile clean. Every problem below is a logic, security, data, configuration, or UX defect, not a build failure.

---

## Part 1: How the system is wired

Understanding where things connect is a prerequisite for the fixes, so this is the map.

### Deployment topology

There is one Cloudflare Worker. It serves both the API and the SPA.

`worker/wrangler.jsonc` sets `assets.directory = ../web/dist` with `run_worker_first: true`. Every request hits the Worker first. Routes matching `/auth/*` and `/api/*` are handled by Hono. Everything else falls through to `app.all('*')`, which proxies to the `ASSETS` binding and falls back to `index.html` for client-side routing.

The build command in `wrangler.jsonc` runs `npm run build -w web` from the repo root before upload, so `web/dist` exists at deploy time.

`web/functions/api/[[path]].ts` and `web/functions/auth/[[path]].ts` are Cloudflare Pages Functions from an older two-service topology. They are dead in the current single-Worker deploy and are a live footgun if anyone ever connects this repo to Pages.

### Data flow

D1 database `athletics-insurance-db`, id `bf574fd6-c5f2-46bf-aed5-532b2f48aa2d`, migrations `0001` through `0007` in `worker/migrations/`. `db/schema.ts` is a Drizzle reference model only. It is not used at runtime and is not enforced.

Auth is a self-signed HS256 JWT in an `auth_token` cookie, `HttpOnly; SameSite=Strict; Secure`, 7-day expiry. `JWT_SECRET` is a Worker secret. Passwords are PBKDF2-SHA256, 100k iterations, salted per user.

Email goes out through the Resend HTTP API from `worker/src/lib/email.ts`. Sender and portal base URL are resolved at send time by `getPortalSettings()`, which reads the `app_settings` D1 table first and falls back to the `wrangler.jsonc` vars.

The cron trigger is `0 * * * *`, hourly, and calls `runReminders()`.

### Approval workflow as built

```
Coach submits
  -> PENDING_COACH        (head coach or active delegate approves)
  -> PENDING_APPROVAL     (Sport Admin and CFO, in any order)
  -> EXECUTED
     branches: DENIED (with reason, resubmittable), VOIDED (CFO only)
```

Softball is special-cased. `isSoftball()` collapses the Sport Admin step because the Softball sport administrator is also the CFO.

### Where you configure each thing

| Setting | Where it lives now | Notes |
|---|---|---|
| Sender name, sender address, portal URL | Super Admin, Settings page, stored in `app_settings` | Overrides the wrangler vars at runtime |
| `CFO_EMAIL` | `worker/wrangler.jsonc` vars only | Not editable in the UI, requires a redeploy |
| `RESEND_API_KEY`, `JWT_SECRET` | Worker secrets via `wrangler secret put` | Correct |
| Sports, head coaches, staff coaches, delegation | Super Admin, Sports and Coaches page | Writes `sports_programs` and `coaches` |
| Sport Admin scoping | Super Admin, Users page | Writes `sport_admin_assignments` |
| Budget caps | CFO or Super Admin, Reports, Budget tab | Writes `sports_programs.budget_cap` |

---

## Part 2: Findings

Severity key. Blocker means the system is unsafe or a core path is broken. High means a user will hit it in normal use. Medium means it degrades trust or quality. Low means polish.

### Blocker 1: Anyone on the internet can act as a coach

`POST /auth/select` in `worker/src/index.ts:633` issues a valid 7-day coach JWT to any unauthenticated caller. No password, no email, no invite, no check of any kind. The Login page exposes this as a one-click "Coach" role card.

That token then grants:

- `GET /api/requests` returns every request in the system. Coaches are explicitly not scoped. That is every student-athlete name, Rocket Number, sport, term, and student email in the database.
- `GET /api/requests/:id` and `GET /api/requests/:id/pdf` for any request.
- `POST /api/requests/:id/sign` as role `COACH`, which is the head coach approval, on any request in `PENDING_COACH` for any sport.
- `POST /api/requests/:id/deny` and `/resubmit`, plus the bulk variants.

So an anonymous visitor can read every student record and single-handedly advance or kill any request at step one. `build.md` section 7 specifies "Coach: create new requests; view only their own requests". The build does the opposite. Student name, Rocket Number, and enrollment status are FERPA educational records, which the same document states in section 3.

This is the finding to fix first. Nothing else matters as much.

### Blocker 2: Requests can enter a state where nobody is ever notified and nothing ever reminds

Two defects compound.

First, `getHeadCoachForSport()` at `worker/src/index.ts:239` returns null when the head coach has no email. Migration `0006` backfilled the `coaches` table using `COALESCE(sp.head_coach_email, '')`, and `head_coach_email` was null for essentially every seeded sport. So most sports have a head coach row with an empty string email. When that happens `notifyOnCreate()` skips the step-1 email entirely and the submission returns 201 as if everything worked.

Second, `runReminders()` at `worker/src/index.ts:2044` filters `WHERE ir.status = 'PENDING_APPROVAL'`. `PENDING_COACH` is never reminded.

Net effect: a request submitted for a sport with no head coach email sends no approval email and never generates a reminder. It sits in `PENDING_COACH` forever, silently. The coach who submitted it sees "submitted, pending approval" and reasonably assumes it is moving. `IMPROVEMENTS_IMPLEMENTED.md` flags the blank-email backfill as a follow-up, but the code has no guard, no warning, and no recovery.

### Blocker 3: The term dropdown offers the wrong academic year for most of the calendar

`web/src/pages/request/New.tsx:12` builds the term list as:

```ts
value: `${t.label} ${t.label === 'Fall' || t.label === 'Full Year' ? CURRENT_YEAR : CURRENT_YEAR + 1}`
```

The year is derived from the wall clock with no reference to whether that term's deadline has passed. Deadlines are Fall on September 8, Spring/Summer on January 26, and Summer on July 1.

Consequences by date:

- Any time in January before the 26th, the coach needs Spring/Summer of the current year. The dropdown offers Spring/Summer of the following year. The current term cannot be submitted at all. January is the single busiest window for that term.
- Any time from January through June, the dropdown offers Summer of next year while the current-year Summer deadline of July 1 is still open.
- From September 9 through December 31, the only Fall option is the current year, whose deadline has already passed. The server rejects it with a 422 and the coach has no way to file for the next Fall.

The dropdown also never disables or hides an option whose deadline has passed. A coach picks a term, fills in the whole form, accepts three disclaimers, and only then gets "Submission deadline has passed for this term" back from the server.

### Blocker 4: Bulk import of a large CSV will fail partway through

`POST /api/requests/bulk` accepts up to 200 rows. Per row it runs a sport lookup, a duplicate check, an insert, an audit insert, then `loadRequestEmailData()` which runs three more queries, then a Resend call. That is roughly seven to eight subrequests per row, all sequential, all inside the request lifetime.

Cloudflare caps subrequests per invocation at 50 on Free and 1000 on Paid. At 200 rows this exceeds even the Paid limit. The handler writes rows as it goes and sends email after each insert. A mid-run failure therefore leaves a partial import, some students notified and some not, and returns nothing useful to the client.

The same pattern, sequential awaited sends inside the request path, appears in `bulk-sign`, `bulk-deny`, and `bulk-void`. None of them use `ctx.waitUntil`, so every email round trip is added directly to the user's response time.

### High 1: Forced password change is dead code

`web/src/pages/ChangePassword.tsx` exists and is complete. It is imported nowhere. `web/src/App.tsx` has no `/change-password` route, and the catch-all route redirects any unknown path to `/dashboard`.

`POST /api/admin/users` sets `must_change_password = 1` on every admin-created account. `POST /auth/login` returns `mustChangePassword` in the response body. The SPA reads it into the `User` type and never acts on it. `GET /auth/me` does not even return the field, so it is lost on page reload.

An admin creating a user hands out a temporary password that the user is never forced to change. On top of that, `ChangePassword.tsx` styles itself with `.auth-card` and `.form-group`, neither of which exists in `web/src/index.css`. If it were routed today it would render unstyled. This code has never been run.

### High 2: Password reset has no fallback when mail does not arrive

`/auth/forgot-password` is the only self-service recovery path, and it depends entirely on email reaching the user. Given the deliverability problem described in Part 3, a Sport Admin or CFO who forgets their password currently has no way back in. There is no Super Admin action to reset a user's password or issue a new temporary one. The Users page has Approve, Reject, Delete, and Edit Sports, and nothing else.

Three smaller issues in the same flow:

Reset tokens are stored in plaintext in `password_reset_tokens`. Anyone with read access to the database can mint a session for any account. Store a SHA-256 hash and compare hashes.

Requesting a new link does not invalidate previous unused links, so every link ever issued stays live for its full hour.

The reset handler inlines its own `fetch` to Resend at `worker/src/index.ts:563` instead of going through `sendEmail()`. It swallows all errors with `.catch(() => {})`, so a failure is completely invisible, and it skips the shared logging that every other send has.

### High 3: Privilege escalation through the admin user endpoints

`isAdmin()` at `worker/src/index.ts:1315` returns true for both `cfo` and `super_admin`. `POST /api/admin/users` is gated on `isAdmin()` and accepts any role including `super_admin`. A CFO can create a Super Admin account and then log into it. `DELETE /api/admin/users/:id` is likewise gated on `isAdmin()`, so a CFO can delete Super Admins. The only protection is that you cannot delete yourself.

Related gaps in the same area. `PUT /api/admin/sports/:id` allows `isAdmin()` while POST and DELETE on the same resource require `super_admin`. Deleting a user leaves orphaned rows in `sport_admin_assignments` because the delete is a single statement against `users`. Nothing prevents deleting the last Super Admin, which locks everyone out of the Sports, Coaches, and Settings pages permanently.

### High 4: The PDF endpoint has no access control beyond "logged in"

`GET /api/requests/:id/pdf` at `worker/src/index.ts:1015` checks only that a user exists. Every sibling route enforces sport-admin scoping through `sportAdminScopeIncludes()`. This one does not. A Sport Admin can download the signed authorization form, including the student's name and Rocket Number, for any sport in the system. Combined with Blocker 1, so can an anonymous visitor.

### High 5: Rate limiting does not work on Workers

`rateBuckets` at `worker/src/index.ts:75` is a module-level `Map`. Cloudflare runs many isolates per colo and many colos worldwide, each with its own copy. The effective limit is the configured limit multiplied by the number of live isolates, which is unbounded and unknowable. Treat login and reset as effectively unthrottled today.

The endpoints that most need throttling are also missing from the list. `/auth/register`, `/auth/setup`, `/auth/select`, and `POST /api/requests` have no limiter at all.

There is also no account lockout and no failed-login counter, so password guessing against a known Sport Admin address is unconstrained.

### High 6: The EXPIRED status is decorative

`EXPIRED` appears in the type union, in `STATUS_LABELS`, in `StatusBadge`, in both dashboard filters, in the Reports aggregate, and in the PDF status palette. Nothing anywhere in the codebase ever writes it. `build.md` section 6 specifies "Workflow timeout (72h): mark request as EXPIRED, notify coach" and a 24-hour-before-deadline escalation. Neither is implemented.

The practical effect is that requests pending past their term deadline stay pending forever, keep appearing in the approval queue, and keep counting toward committed premium in the budget report.

### High 7: CFO notifications go to a hardcoded test inbox

`CFO_EMAIL` in `worker/wrangler.jsonc` is `firas.azfar@gmail.com`. `notifyPendingCFO()`, `allPartyRecipients()`, and the CFO branch of `runReminders()` all read it directly. It is not exposed in the Settings page, and it is not derived from users with the `cfo` role. Every CFO notification in production goes to a personal Gmail account until someone edits the file and redeploys.

The same file still has `FROM_EMAIL: onboarding@resend.dev` and `APP_BASE_URL` pointing at the workers.dev subdomain, both marked as test mode in a comment. Your screenshot shows `mail.utrockets-insurance.com` verified in Resend, so these are stale. The `app_settings` overrides may be masking this in production, which means the checked-in config no longer describes what is running. That is its own risk.

### Medium 1: Deadline evaluation runs in UTC

`isBeforeDeadline()` at `worker/src/lib/validation.ts:29` builds `new Date(year, month - 1, day, 23, 59, 59)`. Worker local time is UTC. The cutoff therefore lands at 23:59:59 UTC, which is 19:59 Eastern Daylight Time. Coaches lose the last four hours of deadline day, and they lose them without warning. Deadlines this visible should be evaluated in `America/New_York`.

The `.ics` attachment has the same problem in the other direction. `buildApprovalIcs()` sets `DTSTART` to 17:00 UTC, which shows up as 1:00 PM Eastern rather than end of business.

### Medium 2: Term filter matches across terms

Both dashboards filter with `term LIKE '%value%'`. Selecting "Summer" matches both "Summer 2027" and "Spring/Summer 2027". The counts and the CSV export are wrong whenever anyone filters by Summer.

### Medium 3: No confirmation that email actually arrived

Every send path swallows failures into `console.warn`. `sendEmail()` logs a warning on a non-2xx from Resend and returns normally. The reset handler discards errors entirely. Nothing is written to the database, nothing surfaces in the UI, and nobody reads Worker logs day to day.

There is no Resend webhook handler, so bounces, complaints, deferrals, and drops are invisible. This is precisely why the current deliverability problem went unnoticed until a person reported it verbally.

### Medium 4: Notifications are the only signal that work is waiting

There is no in-app notification center, no unread badge, and no "needs your action" view. The dashboard is a flat filterable list. An approver who misses an email has no way to discover that something is waiting for them short of scrolling the table and reading status badges. When email is unreliable, and it currently is, this is the difference between a working system and a stalled one.

### Medium 5: PDF and email content inaccuracies

`worker/src/lib/pdf.ts:267` labels the submitting coach's field "Head Coach". Any assistant coach may submit, so the label is wrong for a large share of forms. Section 3 correctly labels the same person "Head Coach" for the signature block, which is the head coach approval and is right, so the two uses conflict.

The PDF footer at line 366 prints `athletics-insurance@utoledo.edu`. Confirm this mailbox exists. If it does not, a signed authorization form is telling recipients to contact an address that bounces.

`buildInsuranceFormPdf` falls back to a hardcoded `'September 8, 2026'` deadline at line 276 when `submissionDeadline` is absent.

Email HTML has no plain-text alternative, no `Reply-To`, and no `List-Unsubscribe`. It uses check-mark glyphs in the body and says "Do not reply to this email" with no reply path. Each of those is a spam-filter signal, discussed in Part 3.

### Medium 6: Unauthenticated endpoints leak staff contact data

`GET /api/sports` has no auth check and returns `headCoachEmail`, `sportAdminName`, and `sportAdminEmail`. The Register page needs the sport list before login, so the endpoint must stay public, but it should return only id, name, and gender to unauthenticated callers.

`GET /auth/identities` is also unauthenticated and returns every head coach name and every sport administrator name and title. Nothing in the SPA calls it any more. Delete it.

### Medium 7: Modals are not usable on short screens

The confirm-sign modal in `Detail.tsx`, the bulk-sign modal in `Dashboard.tsx`, and the PDF preview overlay are all built from inline styles with `position: fixed` and no `overflow: auto`. On a phone in landscape, or any short viewport, the confirm button can be pushed off screen with no way to scroll to it. The stylesheet already defines `.modal-overlay` and `.modal-card`, which handle this correctly. `SessionTimeout` uses them. The three inline modals do not.

Two more UX gaps in the same area. Bulk deny and bulk void collect their reason with `window.prompt`, which is unstyled, uncancellable on some mobile browsers, and inconsistent with the styled deny form on the detail page. And for a Super Admin, `isDeletable()` returns true for every row regardless of status, so Select All selects executed and voided records and offers Bulk Delete on them.

### Low: cleanup

`worker/src/lib/docusign.ts` is 302 lines of unused code pointing at DocuSign demo endpoints. Nothing imports it.

`worker/cookies.txt` is a committed curl cookie jar. Delete it and add it to `.gitignore`.

`pdf_script.py` at the repo root is a 398-line reportlab script superseded by `worker/src/lib/pdf.ts`.

`web/functions/` holds the two dead Pages Function proxies described in Part 1.

`branding/` duplicates the two logo files already in `web/public/`.

`web/src/lib/api.ts` still exports `getIdentities`, which nothing calls.

---

## Part 3: The email problem

This is the highest-value section, so it gets a full treatment.

### What is actually happening

Resend reporting "Delivered" means the receiving mail server returned a 250 and accepted the message. Everything after that happens inside the recipient's mail system and Resend cannot see it.

utoledo.edu and rockets.utoledo.edu are Microsoft 365. Once Exchange Online Protection accepts a message it can still quarantine it, drop it into Junk, or delete it silently through a mail flow rule. Quarantine is the most likely outcome here, and quarantined mail does not appear in the user's Junk folder. From the user's side it simply does not exist.

The specific trigger is almost certainly Microsoft Defender for Office 365 impersonation protection. Consider what your mail looks like to a filter:

- The sending domain, `utrockets-insurance.com`, is a few months old with no sending history.
- It is not utoledo.edu, but it contains "utrockets", which is the university's own athletics brand.
- The display name says "Athletics Business Office".
- The body is branded University of Toledo, in university colors, with a call-to-action button.
- The recipients are university staff and students.

That is the textbook profile of a lookalike-domain phishing campaign, which is exactly the pattern Defender is tuned to catch. A correct SPF, DKIM, and verified domain do not help here. They prove the mail is authentically from `utrockets-insurance.com`. The filter's objection is that `utrockets-insurance.com` is not the university.

### Step zero: get the message trace

Before changing anything, ask the UToledo Office 365 administrators to run a message trace for a few of the failed sends. They need the sender address, the recipient address, and an approximate timestamp. The trace tells you exactly what happened: Quarantined, Filtered as spam, Delivered to Junk, or dropped by a transport rule. It takes them about two minutes and it turns this from guesswork into a known fact.

Do this first. Every remedy below is cheaper to argue for once you can name the filter verdict.

### Option A: have IT allow the sender (smallest ask, fixes it completely)

None of these require you to own or control utoledo.edu DNS.

Ask for a transport rule keyed on a shared secret header. Your Worker adds a header such as `X-UTAthletics-Auth: <long random string>` to every send. IT writes an Exchange mail flow rule: if the sender domain is `mail.utrockets-insurance.com` and that header carries that exact value, set SCL to -1 and bypass spam filtering. The secret prevents anyone else from claiming the same exemption by spoofing your domain, which is normally the objection to a plain domain allow-list. This is the cleanest version of the ask and security teams generally accept it.

There are two simpler alternatives if they prefer. A Tenant Allow/Block List entry for the sending domain, paired with a spoof-intelligence allow. Or adding the domain to the trusted senders list in the anti-phishing policy, which stops impersonation protection firing.

Ask for all recipient domains at once, including `rockets.utoledo.edu`, since student mail may route differently.

### Option B: send from a real utoledo.edu mailbox through Microsoft Graph (the durable answer)

This removes the deliverability problem permanently instead of negotiating an exception to it.

Ask IT for two things. A shared service mailbox, for example `athletics-insurance@utoledo.edu`. And an Entra ID app registration with the `Mail.Send` application permission, restricted by an `ApplicationAccessPolicy` so the credential can only send as that one mailbox and nothing else.

The Worker then does a client-credentials token request against `login.microsoftonline.com` and posts to `https://graph.microsoft.com/v1.0/users/athletics-insurance@utoledo.edu/sendMail`. It is plain HTTPS, so it works from Workers, which cannot open raw SMTP connections.

The result is mail that originates inside the university tenant, from a genuine utoledo.edu address, delivered internally with no external filtering to survive. Replies go to a real monitored mailbox.

In practice this is often an easier approval than a filter exception, because the credential is narrowly scoped to one mailbox, is auditable, and can be revoked instantly. It is worth asking for both A and B in the same conversation and taking whichever they say yes to first.

### Option C: make the mail itself less suspicious (do this regardless)

These are cheap, they are entirely in your control, and they help under any of the options above.

Publish a DMARC record on `utrockets-insurance.com`. Start at `v=DMARC1; p=none; rua=mailto:dmarc@utrockets-insurance.com; fo=1`. You currently have SPF and DKIM from Resend but no DMARC policy, and the aggregate reports alone are worth it. Move to `p=quarantine` once the reports are clean.

Send a plain-text alternative alongside the HTML. Resend takes a `text` field. HTML-only mail is a mild spam signal on its own and a stronger one from a new domain.

Set a real, monitored `Reply-To` and delete "Do not reply to this email". A no-reply transactional message from an unknown domain is a worse signal than a message someone can answer.

Remove the check-mark and other decorative glyphs from subjects and body copy.

Include the destination URL in plain text next to every button, so the message still works when a filter strips or rewrites the anchor.

Add `List-Unsubscribe` and `List-Unsubscribe-Post` headers to the reminder mail. Approval requests are transactional and do not need them. Reminders benefit.

Change the display name away from "Athletics Business Office" until you are allow-listed. Something like "UT Rockets Insurance Portal" is accurate without asserting that you are a university office, which is the specific claim the impersonation filter is testing.

Warm the domain up. Keep early volume low and weighted toward recipients who will actually open the mail.

### Option D: stop depending on email for correctness (the architectural fix)

Options A through C make email work. This makes the system work even when email does not, which is what you actually asked for. It also solves the cron reminder problem directly.

The five pieces, in the order they pay off:

**Delivery status tracking.** Add a `POST /api/webhooks/resend` endpoint with signature verification. Subscribe to `email.sent`, `email.delivered`, `email.bounced`, `email.complained`, and `email.delivery_delayed`. Store each event in an `email_log` table keyed by request id and recipient, then surface it in the request detail view: "Approval request to coach@utoledo.edu: bounced, 2 hours ago." You would have caught the current problem on day one with this in place. It is the highest-value addition in this document after Blocker 1.

**In-app notification center.** Every `notify*` call also writes a `notifications` row for each internal recipient. Add an unread badge in the navbar and an "Awaiting your approval" panel at the top of the dashboard. This makes email an accelerator rather than a dependency, because an approver who logs in sees their queue regardless of what their mail filter did.

**Signed approval links.** Issue a per-request, per-role, single-use, expiring token. The link `/approve?t=...` grants a session scoped to that one request and nothing else. This formalizes the workaround you are already doing by hand. Instead of copying an access code out of band, the admin copies a real link from the request page. They send it through Teams, SMS, or whatever channel reaches that person. Every use is logged, the token expires, and it cannot be replayed or used to reach any other record.

**A cron escalation ladder that does not dead-end at email.** Rewrite `runReminders()` to do four things it does not do today. Cover `PENDING_COACH` as well as `PENDING_APPROVAL`. Expire requests past their term deadline and notify the coach. Escalate to the CFO 24 hours before the deadline, as `build.md` specifies. Send a daily digest to the Super Admin listing every request that is stuck, unreachable, or bouncing, routed to an address you know works, so a human can chase the person by phone. Reminders should also skip recipients whose last several sends bounced, to stop burning sender reputation on a dead address.

**Optional SMS fallback.** Twilio, opt-in per approver, used only for step-1 head coach approval and final CFO approval. Worth doing only if A and B both stall.

---

## Part 4: Implementation plan

Six phases. Phase 1 is not optional and should ship before anything else. Phases run in order because each depends on the one before, except that the Phase 0 email conversations should start today in parallel with all of it.

### Phase 0: start now, runs in parallel

Email UT IT and ask for three things in one message: a message trace for the failed sends, the transport-rule allow from Option A, and the Graph service mailbox from Option B. Get the ask in early. IT turnaround is the long pole here, and everything else in this plan is code you control.

Publish the DMARC record. It takes five minutes and costs nothing.

Correct `worker/wrangler.jsonc` so the checked-in config matches production: real `FROM_EMAIL` on the verified domain, real `APP_BASE_URL`, real `CFO_EMAIL`. Verify what `app_settings` currently holds so you know which values are actually in force.

### Phase 1: security and access control

Close Blocker 1. Replace anonymous coach login with real coach accounts. Coaches already exist as rows in the `coaches` table with names, emails, sports, and head-coach flags, so the identity model is already there. Add a `coach` login backed by the same magic-link mechanism from Option D, so coaches get a link rather than a password to remember. Scope `GET /api/requests` for coaches to their own sport and their own submissions. Restrict the `COACH` signature role to the head coach or active delegate of that specific sport. Delete `POST /auth/select`.

Add scope enforcement to `GET /api/requests/:id/pdf`.

Split `isAdmin()`. Creating, deleting, or changing the role of a user becomes `super_admin` only. CFO keeps read access to users, reports, and audit. Block deletion of the last Super Admin. Cascade `sport_admin_assignments` on user delete.

Move rate limiting to a Cloudflare rate limit binding or a Durable Object so it is globally consistent, and extend it to register, setup, and request creation. Add a failed-login counter with temporary lockout.

Hash password reset tokens before storing, invalidate prior unused tokens when a new one is issued, and invalidate active sessions after a successful reset.

Add a startup assertion that `JWT_SECRET` is present and long enough. Today an unset secret silently signs every token with the literal string `undefined`, which is trivially forgeable.

### Phase 2: make the workflow reliable

Wire the `/change-password` route, gate it on `mustChangePassword`, return that field from `GET /auth/me`, and replace the missing `.auth-card` and `.form-group` styles with the classes that exist.

Add a Super Admin action to reset a user's password and issue a new temporary one, so a lost account is recoverable without email.

Fix head coach routing. Block saving a head coach with no email in the Sports and Coaches UI. Return a warning from `POST /api/requests` when the sport has no reachable step-1 approver, and show it to the coach rather than reporting success. Add a Super Admin health panel listing every sport whose head coach email is missing or bouncing.

Rewrite `runReminders()` per Option D. Also cap the work per run and wrap each request in its own try/catch, so one failure does not kill the whole pass.

Move all email sends out of the request path with `ctx.waitUntil`. Chunk the bulk endpoints so a single invocation never approaches the subrequest ceiling, and make bulk import report partial success honestly.

### Phase 3: email resilience

Build the Resend webhook handler, the `email_log` table, and the delivery status display on the request detail page.

Build the notification center: table, API, navbar badge, and the dashboard "Awaiting your approval" panel.

Build signed approval links, including the copy-link affordance on the request page for out-of-band delivery.

Apply the Option C content fixes: plain-text alternative, `Reply-To`, no-glyph subjects, plain URLs beside buttons, `List-Unsubscribe` on reminders, revised display name.

Make `CFO_EMAIL` a Settings field backed by `app_settings`, and fall back to users with the `cfo` role rather than a single hardcoded address.

### Phase 4: data correctness

Rewrite the term option builder to derive both the term and its year from the deadline calendar rather than the wall clock. Offer the next term whose deadline has not passed, show each option's deadline in the dropdown, and disable rather than silently reject anything past cutoff.

Evaluate deadlines in `America/New_York` instead of UTC, in both `isBeforeDeadline()` and the `.ics` generator.

Fix the term filter so Summer does not match Spring/Summer. Filter on a parsed term key, not a substring.

Correct the PDF: relabel the submitting coach field, verify or replace the footer contact address, and remove the hardcoded deadline fallback.

Reconcile `db/schema.ts` with the migrations, or delete it. A reference model that drifts is worse than none.

### Phase 5: UX and cleanup

Convert the three inline modals to the existing `.modal-overlay` and `.modal-card` classes so they scroll on short viewports. Replace the two `window.prompt` reason collectors with the styled form already used on the detail page. Restrict Super Admin bulk delete to non-terminal statuses, or require typing a confirmation phrase.

Reduce `GET /api/sports` to id, name, and gender for unauthenticated callers. Delete `GET /auth/identities`.

Delete `worker/src/lib/docusign.ts`, `worker/cookies.txt`, `pdf_script.py`, `web/functions/`, the duplicated `branding/` folder, and the unused `getIdentities` export. Add `cookies.txt` to `.gitignore`.

### Phase 6: verification

There are currently zero tests. Start with unit tests for `isBeforeDeadline`, `getPremiumForTerm`, `getSubmissionDeadline`, `termKeyFor`, and `isDelegationActive`. Those five encode the business rules, and every one of them has a boundary bug or a timezone bug today.

Then add integration tests over the state machine: submit, head coach approve, both approver orders, softball collapse, deny, resubmit, void. Add RBAC tests asserting each role cannot reach the endpoints it should not. Those are the regression guard for Phase 1.

Finally, walk the whole thing by hand. Register, approve, log in, forced password change, forgot password, reset, submit single, submit bulk, approve at all three steps, deny, resubmit, void, download the PDF, run the reminder cron, and confirm delivery status appears for every send.

---

## Recommended order of attack

Phase 0 today, because IT is the long pole and the DMARC record is free.

Phase 1 next and on its own, because an unauthenticated stranger can currently read every student record in the database and approve requests. That is a reportable FERPA exposure and it outranks everything else here.

Then Phases 2 and 3 together. They are what make the system survive the email problem rather than depending on it being solved.

Phases 4 through 6 after that. Phase 4 matters most in January, when the term dropdown bug makes the app unusable for the Spring/Summer deadline, so it should not slip past December.
