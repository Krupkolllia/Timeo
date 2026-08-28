# keepalive-worker

Cloudflare Worker for block 9. A cron trigger once a day makes a request to Supabase so the
free project doesn't go to sleep after a week of inactivity (section 4 of TIMEO-SPEC.md, "Keep-alive").
