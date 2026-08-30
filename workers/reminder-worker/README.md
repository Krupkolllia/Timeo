# reminder-worker

Cloudflare Worker for block 9 ("Notifications and keep-alive"). A cron trigger once an hour; for each user
with reminders enabled, checks in Supabase whether today's day is filled in and sends a Web Push
if not (section 4 of TIMEO-SPEC.md, "Notifications").

Works only for authenticated users with an active push subscription — without an account the
server has no way to know the device address.
