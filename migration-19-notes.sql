-- ============================================================
-- Le Carnet · migration 19 : notes partagées de l'équipe
--   Pages de notes que tout le monde (sauf les invités) peut lire et modifier ;
--   la personne qui l'a créée ou l'administrateur peut la supprimer.
--   Une note peut être liée à un projet (elle suit alors la visibilité du projet).
--   Sans danger si relancée.
-- ============================================================
create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  body text not null default '' check (char_length(body) <= 20000),
  pinned boolean not null default false,
  project_id uuid references public.projects(id) on delete set null,
  created_by uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists notes_idx on public.notes (server_id, pinned desc, updated_at desc);
alter table public.notes enable row level security;
drop policy if exists "notes: lecture" on public.notes;
drop policy if exists "notes: ajout" on public.notes;
drop policy if exists "notes: modification" on public.notes;
drop policy if exists "notes: suppression" on public.notes;
create policy "notes: lecture" on public.notes for select
  using (server_id = public.my_approved_server() and (project_id is null or public.can_see_project(project_id)));
create policy "notes: ajout" on public.notes for insert
  with check (created_by = auth.uid() and server_id = public.my_approved_server() and public.my_role() <> 'guest'
              and (project_id is null or public.can_see_project(project_id)));
create policy "notes: modification" on public.notes for update
  using (server_id = public.my_approved_server() and public.my_role() <> 'guest' and (project_id is null or public.can_see_project(project_id)))
  with check (server_id = public.my_approved_server() and (project_id is null or public.can_see_project(project_id)));
create policy "notes: suppression" on public.notes for delete
  using (server_id = public.my_approved_server() and (created_by = auth.uid() or public.my_role() = 'admin'));

create or replace function public.notes_touch()
returns trigger language plpgsql as $$
begin
  if new.server_id <> old.server_id or new.created_by <> old.created_by then
    raise exception 'Modification interdite.';
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
drop trigger if exists trg_notes_touch on public.notes;
create trigger trg_notes_touch before update on public.notes
  for each row execute function public.notes_touch();

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'notes') then
    alter publication supabase_realtime add table public.notes;
  end if;
end $$;
