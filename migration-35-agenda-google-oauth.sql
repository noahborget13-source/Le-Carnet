-- Migration 35 : liaison de l'agenda Google par autorisation (OAuth), en plus du lien secret iCal.
-- La table calendar_feeds n'a aucune politique RLS : seules les fonctions serveur (clé de service) y accèdent.
-- Le jeton Google n'est donc jamais lisible depuis le navigateur.

alter table public.calendar_feeds alter column ics_url drop not null;
alter table public.calendar_feeds add column if not exists source text not null default 'ics';
alter table public.calendar_feeds add column if not exists google_refresh_token text;

do $$ begin
  alter table public.calendar_feeds add constraint calendar_feeds_source_check check (source in ('ics', 'google'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.calendar_feeds add constraint calendar_feeds_source_data check (
    (source = 'ics' and ics_url is not null) or (source = 'google' and google_refresh_token is not null));
exception when duplicate_object then null; end $$;

drop function if exists public.my_calendar_status();
create or replace function public.my_calendar_status()
returns table(connected boolean, last_sync timestamptz, last_error text, slots integer, source text)
language sql stable security definer set search_path = public as $$
  select true, f.last_sync, f.last_error, jsonb_array_length(f.busy), f.source
    from public.calendar_feeds f where f.user_id = auth.uid();
$$;
revoke all on function public.my_calendar_status() from public;
grant execute on function public.my_calendar_status() to authenticated;
