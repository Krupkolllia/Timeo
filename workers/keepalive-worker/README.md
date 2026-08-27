# keepalive-worker

Cloudflare Worker для блока 9. Cron-триггер раз в сутки делает запрос к Supabase, чтобы
бесплатный проект не засыпал через неделю бездействия (раздел 4 TIMEO-SPEC.md, "Keep-alive").
