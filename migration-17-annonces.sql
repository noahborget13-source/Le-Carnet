-- ============================================================
-- Le Carnet · migration 17 : annonces de l'équipe
--   L'administrateur publie une annonce depuis l'Espace Administrateur ;
--   elle s'affiche en bandeau dans l'application pour tous les membres du serveur.
--   Sans danger si relancée.
-- ============================================================
create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  body text not null default '' check (char_length(body) <= 1000),
  level text not null default 'info' check (level in ('info', 'important', 'success')),
  active boolean not null default true,
  expires_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists announcements_idx on public.announcements (server_id, created_at desc);
alter table public.announcements enable row level security;
drop policy if exists "annonces: lecture" on public.announcements;
drop policy if exists "annonces: ajout" on public.announcements;
drop policy if exists "annonces: modification" on public.announcements;
drop policy if exists "annonces: suppression" on public.announcements;
create policy "annonces: lecture" on public.announcements for select using (server_id = public.my_approved_server());
create policy "annonces: ajout" on public.announcements for insert
  with check (server_id = public.my_approved_server() and public.my_role() = 'admin' and created_by = auth.uid());
create policy "annonces: modification" on public.announcements for update
  using (server_id = public.my_approved_server() and public.my_role() = 'admin')
  with check (server_id = public.my_approved_server());
create policy "annonces: suppression" on public.announcements for delete
  using (server_id = public.my_approved_server() and public.my_role() = 'admin');

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'announcements') then
    alter publication supabase_realtime add table public.announcements;
  end if;
end $$;
