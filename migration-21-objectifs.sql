-- ============================================================
-- Le Carnet · migration 21 : objectifs et résultats clés
--   Un objectif (par exemple « Lancer la nouvelle offre ») a une personne responsable, une échéance
--   et des résultats clés mesurables : une valeur à atteindre (12 clients sur 20)
--   ou la progression d'un groupe de tâches (3 tâches terminées sur 8).
--   Tout le monde voit les objectifs de son serveur ; le responsable, le créateur ou l'administrateur les modifient.
--   Sans danger si relancée.
-- ============================================================
create table if not exists public.objectives (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  description text not null default '' check (char_length(description) <= 1000),
  owner_id uuid references public.profiles(id) on delete set null,
  due date,
  status text not null default 'active' check (status in ('active', 'done', 'archived')),
  project_id uuid references public.projects(id) on delete set null,
  created_by uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists objectives_idx on public.objectives (server_id, status, created_at desc);

create table if not exists public.key_results (
  id uuid primary key default gen_random_uuid(),
  objective_id uuid not null references public.objectives(id) on delete cascade,
  server_id uuid not null references public.servers(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  kind text not null default 'manual' check (kind in ('manual', 'tasks')),
  target numeric not null default 100 check (target > 0 and target <= 1000000000),
  current numeric not null default 0 check (current >= 0 and current <= 1000000000),
  unit text not null default '' check (char_length(unit) <= 12),
  task_ids uuid[] not null default '{}',
  position int not null default 0,
  created_at timestamptz not null default now(),
  check (cardinality(task_ids) <= 100)
);
create index if not exists key_results_idx on public.key_results (objective_id, position);

alter table public.objectives enable row level security;
alter table public.key_results enable row level security;
drop policy if exists "objectifs: lecture" on public.objectives;
drop policy if exists "objectifs: ajout" on public.objectives;
drop policy if exists "objectifs: modification" on public.objectives;
drop policy if exists "objectifs: suppression" on public.objectives;
create policy "objectifs: lecture" on public.objectives for select
  using (server_id = public.my_approved_server() and (project_id is null or public.can_see_project(project_id)));
create policy "objectifs: ajout" on public.objectives for insert
  with check (created_by = auth.uid() and server_id = public.my_approved_server() and public.my_role() <> 'guest'
              and (project_id is null or public.can_see_project(project_id)));
create policy "objectifs: modification" on public.objectives for update
  using (server_id = public.my_approved_server() and (owner_id = auth.uid() or created_by = auth.uid() or public.my_role() = 'admin'))
  with check (server_id = public.my_approved_server() and (project_id is null or public.can_see_project(project_id)));
create policy "objectifs: suppression" on public.objectives for delete
  using (server_id = public.my_approved_server() and (created_by = auth.uid() or public.my_role() = 'admin'));

drop policy if exists "résultats clés: lecture" on public.key_results;
drop policy if exists "résultats clés: ajout" on public.key_results;
drop policy if exists "résultats clés: modification" on public.key_results;
drop policy if exists "résultats clés: suppression" on public.key_results;
create policy "résultats clés: lecture" on public.key_results for select
  using (server_id = public.my_approved_server() and exists (select 1 from public.objectives o where o.id = objective_id));
create policy "résultats clés: ajout" on public.key_results for insert
  with check (server_id = public.my_approved_server() and exists (
    select 1 from public.objectives o where o.id = objective_id and o.server_id = server_id
      and (o.owner_id = auth.uid() or o.created_by = auth.uid() or public.my_role() = 'admin')));
create policy "résultats clés: modification" on public.key_results for update
  using (server_id = public.my_approved_server() and exists (
    select 1 from public.objectives o where o.id = objective_id and (o.owner_id = auth.uid() or o.created_by = auth.uid() or public.my_role() = 'admin')))
  with check (server_id = public.my_approved_server());
create policy "résultats clés: suppression" on public.key_results for delete
  using (server_id = public.my_approved_server() and exists (
    select 1 from public.objectives o where o.id = objective_id and (o.owner_id = auth.uid() or o.created_by = auth.uid() or public.my_role() = 'admin')));

create or replace function public.objectives_lock_columns()
returns trigger language plpgsql as $$
begin
  if new.server_id <> old.server_id or new.created_by <> old.created_by then raise exception 'Modification interdite.'; end if;
  return new;
end $$;
drop trigger if exists trg_objectives_lock on public.objectives;
create trigger trg_objectives_lock before update on public.objectives for each row execute function public.objectives_lock_columns();

create or replace function public.key_results_lock_columns()
returns trigger language plpgsql as $$
begin
  if new.server_id <> old.server_id or new.objective_id <> old.objective_id then raise exception 'Modification interdite.'; end if;
  return new;
end $$;
drop trigger if exists trg_key_results_lock on public.key_results;
create trigger trg_key_results_lock before update on public.key_results for each row execute function public.key_results_lock_columns();

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'objectives') then
    alter publication supabase_realtime add table public.objectives;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'key_results') then
    alter publication supabase_realtime add table public.key_results;
  end if;
end $$;
