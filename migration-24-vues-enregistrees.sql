-- ============================================================
-- Le Carnet · migration 24 : vues enregistrées
--   Chaque personne garde ses propres filtres favoris de la liste des tâches (20 au maximum).
--   Privées : personne d'autre ne les voit. Sans danger si relancée.
-- ============================================================
create table if not exists public.saved_views (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  server_id uuid not null references public.servers(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  filters jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);
create index if not exists saved_views_idx on public.saved_views (user_id, created_at);
alter table public.saved_views enable row level security;
drop policy if exists "vues: lecture" on public.saved_views;
drop policy if exists "vues: ajout" on public.saved_views;
drop policy if exists "vues: modification" on public.saved_views;
drop policy if exists "vues: suppression" on public.saved_views;
create policy "vues: lecture" on public.saved_views for select using (user_id = auth.uid());
create policy "vues: ajout" on public.saved_views for insert with check (user_id = auth.uid() and server_id = public.my_approved_server());
create policy "vues: modification" on public.saved_views for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "vues: suppression" on public.saved_views for delete using (user_id = auth.uid());

create or replace function public.saved_views_limit()
returns trigger language plpgsql as $$
begin
  if (select count(*) from public.saved_views where user_id = new.user_id) >= 20 then
    raise exception 'Vous pouvez enregistrer 20 vues au maximum.';
  end if;
  return new;
end $$;
drop trigger if exists trg_saved_views_limit on public.saved_views;
create trigger trg_saved_views_limit before insert on public.saved_views for each row execute function public.saved_views_limit();

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'saved_views') then
    alter publication supabase_realtime add table public.saved_views;
  end if;
end $$;
