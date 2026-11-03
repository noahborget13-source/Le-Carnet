-- ============================================================
-- Le Carnet · migration 25 : point quotidien d'équipe
--   Chaque personne peut donner chaque jour : son humeur (1 à 5), ce qu'elle a fait, ce qu'elle prévoit, ses blocages.
--   Visible par tout le serveur ; seule la personne concernée l'écrit. Un seul point par personne et par jour.
--   Sans danger si relancée.
-- ============================================================
create table if not exists public.checkins (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers(id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  day date not null,
  mood smallint check (mood between 1 and 5),
  did text not null default '' check (char_length(did) <= 600),
  will text not null default '' check (char_length(will) <= 600),
  blockers text not null default '' check (char_length(blockers) <= 600),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, day),
  check (day <= current_date + 1)
);
create index if not exists checkins_idx on public.checkins (server_id, day desc);
alter table public.checkins enable row level security;
drop policy if exists "points: lecture" on public.checkins;
drop policy if exists "points: ajout" on public.checkins;
drop policy if exists "points: modification" on public.checkins;
drop policy if exists "points: suppression" on public.checkins;
create policy "points: lecture" on public.checkins for select using (server_id = public.my_approved_server());
create policy "points: ajout" on public.checkins for insert with check (user_id = auth.uid() and server_id = public.my_approved_server() and public.my_role() <> 'guest');
create policy "points: modification" on public.checkins for update using (user_id = auth.uid()) with check (user_id = auth.uid() and server_id = public.my_approved_server());
create policy "points: suppression" on public.checkins for delete using (user_id = auth.uid() or public.my_role() = 'admin');

create or replace function public.checkins_touch()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and (new.user_id <> old.user_id or new.server_id <> old.server_id or new.day <> old.day) then raise exception 'Modification interdite.'; end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists trg_checkins_touch on public.checkins;
create trigger trg_checkins_touch before insert or update on public.checkins for each row execute function public.checkins_touch();

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'checkins') then
    alter publication supabase_realtime add table public.checkins;
  end if;
end $$;
