-- ─────────────────────────────────────────────────────────────────────────────
-- Mail safety mode.
--
-- Exercising the portal used to mean mailing whoever the data pointed at. A test
-- submission reached two real staff members and the hourly reminder chased them
-- again two days later; the only way to prevent it was `wrangler secret delete
-- RESEND_API_KEY`, which is all-or-nothing, easy to forget to restore, and not
-- available to a non-technical operator.
--
-- `app_settings.mail_mode` is now one of live | redirect | suppress, enforced at
-- the single choke point in sendEmail(). Redirect reroutes every message to one
-- nominated address while still recording who it was meant for, which is what
-- makes a full rehearsal possible without a rebuilt database.
-- ─────────────────────────────────────────────────────────────────────────────

-- Who the message was actually delivered to when redirect rerouted it. NULL in
-- live and suppress. `to_email` keeps meaning "who this message was about", so the
-- fan-out record and the "did the head coach get it" query stay honest.
ALTER TABLE email_log ADD COLUMN redirected_to TEXT;

-- Ship suppressed. The deploy that introduces the switch also stops the bleeding,
-- and going live becomes one deliberate click in Super Admin, Settings. Every send
-- is still recorded, so the fan-out is inspectable before it is ever real.
--
-- email_log.status has no CHECK constraint, so the new 'suppressed' value needs no DDL.
INSERT OR IGNORE INTO app_settings (setting_key, setting_value) VALUES ('mail_mode', 'suppress');
