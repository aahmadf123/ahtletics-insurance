# Email setup and deliverability

Cloudflare Workers cannot send mail on their own, so the portal sends through
[Resend](https://resend.com). Getting a message accepted by Resend is the easy part.
Getting it into a utoledo.edu inbox is the part that needs the configuration below.

## The problem this configuration solves

UToledo runs Exchange Online. Microsoft accepts a message at the mail exchanger, which
is what makes Resend report success, and then decides separately whether the recipient
ever sees it. When it decides against, the message goes to quarantine or is dropped, and
nothing bounces. From the sending side it looks identical to a successful delivery.

Two things drive that decision: whether the sending domain is authenticated, and whether
the message looks like phishing. Both are addressed here.

**A utoledo.edu sending address is not available**, so `utrockets-insurance.com` has to
earn its own reputation. A brand-new domain whose name resembles a university, sending
mail about student records with a prominent link, starts from a bad position. The
message templates were changed to stop making that worse.

### What changed in the messages

All of this is already done in `worker/src/lib/email.ts`. It is listed so nobody
reintroduces one of these by accident.

- Every message carries a `text/plain` part alongside the HTML. HTML-only mail scores
  materially worse with Microsoft filtering. The two parts are generated from the same
  data rather than by stripping tags, so they cannot drift.
- A `Reply-To` header points at a monitored mailbox. Mail with no reply path reads as
  automated bulk sending.
- `List-Unsubscribe` and `List-Unsubscribe-Post` headers are set.
- Subjects no longer begin with `[Action Required]`. A bracketed urgency prefix is a
  long-standing spam heuristic.
- The call-to-action button is accompanied by the full URL in visible text, so both the
  recipient and the filter can see where the link goes.
- Approval notifications no longer carry a `.ics` attachment. Calendar files from an
  unrecognised sender are a strong quarantine trigger, and these are first contact from
  a new domain. The calendar file is now a download on the request page instead.

## DNS records

Mail is sent from the subdomain `mail.utrockets-insurance.com`, not the apex. A
reputation problem then stays contained, and the apex remains available if the sending
domain ever has to be replaced.

That subdomain is the domain registered in Resend, and the From address must be on it
exactly. Resend rejects a send whose From domain it has not verified, so pointing
`FROM_EMAIL` at any other host does not degrade deliverability — it stops mail entirely.

Resend publishes its Return-Path on a further `send.` prefix of the sending domain,
which is why the SPF and MX records below sit on `send.mail.utrockets-insurance.com`
rather than on the sending domain itself. All four records are live on the
`utrockets-insurance.com` zone in Cloudflare.

| Record | Host | Value |
|---|---|---|
| MX | `send.mail.utrockets-insurance.com` | `feedback-smtp.us-east-1.amazonses.com` (priority 10) — the Return-Path |
| TXT (SPF) | `send.mail.utrockets-insurance.com` | `v=spf1 include:amazonses.com ~all` |
| TXT (DKIM) | `resend._domainkey.mail.utrockets-insurance.com` | `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQChQIW2JRtAYtEJczUsswoIT1fIE0fuSxtAUQtF9pUYvEGQ21Nvz5FjdWwMTU0bVWuv9Cha75cIoqg0EwwRS+2+QBFwqDu+rlZGYWwyVMt9xc2lqqkW+u9raWMPTFqrHqkZrtb3uLhUsstRWMi1EBa5xwkccPzT21HPB0S+Lpbh9wIDAQAB` |
| TXT (DMARC) | `_dmarc.utrockets-insurance.com` | `v=DMARC1; p=none; rua=mailto:dmarc@utrockets-insurance.com; adkim=s; aspf=r; fo=1` |

The SPF, DKIM and MX values are generated per Resend account. If the domain is ever
removed and re-added in Resend, they change and must be re-copied from there; the DKIM
key above is specific to the current registration.

### Why `aspf=r` and not `aspf=s`

`adkim=s` requires the DKIM signing domain to match the From domain exactly. Resend
signs with `d=mail.utrockets-insurance.com` and the From address is on
`mail.utrockets-insurance.com`, so strict DKIM alignment passes. That is the alignment
that carries the weight.

`aspf=s` would require the envelope sender domain to match the From domain exactly. The
envelope sender is `send.mail.utrockets-insurance.com` — a subdomain — so strict SPF
alignment can never pass with Resend's architecture. `aspf=r` accepts the shared
organisational domain and passes. DMARC needs only one aligned pass to succeed, so
`aspf=s` would not have broken DMARC, but it would have left a permanent `spf=fail` on
the alignment line for no benefit.

### The observation phase

Start DMARC at `p=none` and read the aggregate reports for about two weeks. Once they
show every legitimate message passing with aligned SPF and DKIM, move to
`p=quarantine`. Do not start at `p=quarantine`; a misconfiguration then silently
quarantines your own mail.

Reports go to `dmarc@utrockets-insurance.com`, which only receives once Email Routing is
enabled on the apex (see below). Until that is done the reports are generated by
receivers and dropped, and the two-week clock has not actually started.

## Email Routing (inbound)

The apex `utrockets-insurance.com` has no MX record, so nothing addressed to it is
deliverable. Two addresses depend on that being fixed:

- `dmarc@utrockets-insurance.com` — the DMARC `rua` target. Without it there is no
  observation phase, only the assumption of one.
- `athletics-insurance@utrockets-insurance.com` — the `Reply-To` on every notification.
  A reply path that bounces is worse than the automated-bulk signal it was added to
  avoid.

Enable it in the Cloudflare dashboard under **Email → Email Routing** on the
`utrockets-insurance.com` zone. Cloudflare adds the inbound MX and SPF records itself.
Add both addresses as custom routes forwarding to a real mailbox, and confirm the
destination from the verification mail Cloudflare sends before the routes go live.

Inbound MX on the apex does not affect outbound sending: that is governed by the
`mail.` subdomain records above, which Email Routing does not touch.

## Worker configuration

`worker/wrangler.jsonc` holds the fallbacks. Super Admin, Settings writes to the
`app_settings` table, which takes precedence at send time.

```jsonc
"FROM_NAME":       "UToledo Athletics Business Office",
"FROM_EMAIL":      "noreply@mail.utrockets-insurance.com",
"REPLY_TO_EMAIL":  "athletics-insurance@utrockets-insurance.com",
"CFO_EMAIL":       "melissa.deangelo@utoledo.edu",
"APP_BASE_URL":    "https://utrockets-insurance.com"
```

These must name the Resend-verified sending domain even though `app_settings` normally
wins, because they are exactly what gets used when the settings read fails. A fallback
pointing at an unverified domain converts a transient database error into a total
sending outage, which is the failure mode the fallback exists to prevent.

`app_settings` currently holds `from_email = noreply@mail.utrockets-insurance.com`; it
has no `reply_to` row, so `REPLY_TO_EMAIL` above is what ships on every message.

`CFO_EMAIL` is a fallback only. Notifications resolve the CFO from active `cfo` accounts
at send time, so adding a CFO in the Users page is enough.

The API key is a secret and must not go in `wrangler.jsonc`:

```bash
cd worker
npx wrangler secret put RESEND_API_KEY
```

With no key set, the Worker skips sending and records each message in `email_log` with
status `skipped`, which is useful for local work.

## Verifying it worked

Check the records resolve:

```bash
dig +short TXT send.mail.utrockets-insurance.com          # SPF
dig +short TXT resend._domainkey.mail.utrockets-insurance.com  # DKIM
dig +short TXT _dmarc.utrockets-insurance.com             # DMARC
dig +short MX  send.mail.utrockets-insurance.com          # Return-Path
dig +short MX  utrockets-insurance.com                    # inbound; empty until Email Routing is on
```

There is no `dig` on Windows and `Resolve-DnsName` needs UDP 53, which is often blocked.
Query Cloudflare over HTTPS instead:

```powershell
Invoke-RestMethod -Uri "https://cloudflare-dns.com/dns-query?name=_dmarc.utrockets-insurance.com&type=TXT" `
  -Headers @{accept='application/dns-json'} | Select-Object -ExpandProperty Answer
```

Send one notification to a Gmail address and open "Show original". You want `SPF: PASS`,
`DKIM: PASS`, and `DMARC: PASS`. A DMARC pass with lax alignment is not the same thing;
confirm the signing domain matches the From domain.

Then send one to an Outlook or Microsoft 365 address and read the headers:

- `Authentication-Results` should show `spf=pass`, `dkim=pass`, `dmarc=pass`.
- `X-Forefront-Antispam-Report` contains an `SCL` value. Below 5 is normal mail. **5 or
  higher means Microsoft is treating it as bulk**, which is the state that produces
  silent quarantine.

Finally, run the sending domain through mail-tester.com and aim for 9 out of 10 or
better. The deductions name whatever signal is still outstanding.

## If mail still does not arrive

Once SPF, DKIM, and strictly aligned DMARC all pass and the SCL is still 5 or higher,
the remaining problem is domain reputation and there is no configuration change that
fixes it from the sending side. At that point the options are:

1. Ask UToledo IT to add `send.utrockets-insurance.com` to the Exchange Online Tenant
   Allow/Block List, or to create an anti-spam policy that bypasses filtering for it.
   This is the only reliable fix and it needs their mail administrator.
2. Send to an address outside the university for the people who keep missing messages.

Either way, the portal no longer depends on mail alone. Every send is recorded in
`email_log` and shown on the request page under Notification Delivery for CFO and Super
Admin, along with a button that copies the request link so it can be sent through
whatever channel the recipient actually reads. A status of `sent` there means the
provider accepted the message, not that it reached an inbox; that distinction is the
whole reason the log exists.

## What gets sent

On submission: confirmation to the coach, confirmation to each student-athlete who has
an email on the request, and an approval request to the head coach or their active
delegate. The CSV import path sends the same set as the manual path.

After head coach approval: an approval request to every sport administrator assigned to
the sport, and to the CFO. Sports flagged `single_approval` (softball, whose
administrator is the CFO) skip the sport administrator step.

On execution: a notice to everyone named on the request, with the signed authorization
PDF attached. Denials, voids, and expiries fan out the same way.

Hourly cron: expires requests whose term deadline has passed, then chases approvers who
still owe a signature after 48 hours. Reminders cover requests stalled at the head coach
step as well as at the approval step, stop after four attempts, and escalate on the last
one.
