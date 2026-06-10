# Email Notifications — Setup (Resend)

The app already contains the full notification workflow. It just needs a sending
provider configured. **Cloudflare Workers cannot send transactional email on their own**
(the old free MailChannels route shut down in 2024), so we use [Resend](https://resend.com).

## What gets sent (already coded, in `worker/src/lib/email.ts`)

When a coach **submits** a request:
- ✅ Coach → confirmation ("submitted, pending approval")
- ✅ Student-athlete(s) → confirmation (only if a student email was entered)
- ✅ Sport Administrator → "Action Required: review & sign"
- ✅ CFO → "Action Required: final approval"

When the request is **fully approved (executed)**:
- ✅ Coach + CFO → "Approved / enrollment complete"

Plus: void notices, and a 48-hour reminder to any approver who hasn't signed
(runs hourly via the cron trigger already in `wrangler.jsonc`).

> Softball is special-cased: its Sport Admin *is* the CFO (Melissa DeAngelo), so a single
> CFO approval finalizes it.

## One-time setup steps

1. **Create a Resend account** at https://resend.com (free tier covers low volume).

2. **Verify a sending domain.**
   - Best: a subdomain you control DNS for, e.g. `mail.athletics.utoledo.edu`, and add
     the DKIM/SPF records Resend shows you. (You may need UT IT to add the DNS records.)
   - For quick testing without a domain, Resend lets you send from `onboarding@resend.dev`
     to your own verified address.

3. **Create an API key** in the Resend dashboard (starts with `re_...`).

4. **Set the key as a Worker secret** (it must NOT go in `wrangler.jsonc`):
   ```bash
   cd worker
   npx wrangler secret put RESEND_API_KEY
   # paste the re_... key when prompted
   ```

5. **Point `FROM_EMAIL` at your verified domain** in `worker/wrangler.jsonc` `vars`:
   ```jsonc
   "FROM_EMAIL": "noreply@mail.athletics.utoledo.edu",
   ```
   It is currently `noreply@athletics.utoledo.edu` — that domain must be verified in
   Resend or sends will be rejected.

6. **Set the real CFO address.** `CFO_EMAIL` in `wrangler.jsonc` is currently
   `firas.azfar@gmail.com` (a test inbox). For production, set it to the CFO
   (e.g. `melissa.deangelo@utoledo.edu`).

7. **Redeploy** so the new secret/vars take effect (see below).

## How to tell it's working

If `RESEND_API_KEY` is unset, the Worker **silently skips** every email and logs
`[EMAIL SKIPPED — no RESEND_API_KEY]` (visible in `wrangler tail`). Once the key is set,
the same log lines disappear and Resend's dashboard shows delivered messages.
