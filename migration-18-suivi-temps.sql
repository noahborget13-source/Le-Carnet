-- ============================================================
-- Le Carnet · migration 18 : suivi du temps sur les tâches
--   Chrono (une seule minuterie en cours par personne) et saisie manuelle.
--   Chacun voit le temps des tâches qu'il peut voir ; chacun gère le sien.
--   Sans danger si relancée.
-- ============================================================
create table if not exists public.time_entries (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz,
  note text not null default '' check (char_length(note) <= 200),
  created_at timestamptz not null default now(),
  check (ended_at is null or ended_at > started_at),
  check (ended_at is null or ended_at - started_at <= interval '24 hours')
);
create index if not exists time_entries_task_idx on public.time_entries (task_id);
create index if not exists time_entries_user_idx on public.time_entries (user_id, started_at desc);
create unique index if not exists time_entries_one_running on public.time_entries (user_id) where ended_at is null;

alter table public.time_entries enable row level security;
drop policy if exists "temps: lecture" on public.time_entries;
drop policy if exists "temps: ajout" on public.time_entries;
drop policy if exists "temps: modification" on public.time_entries;
drop policy if exists "temps: suppression" on public.time_entries;
-- les tâches ont leurs propres règles de visibilité : on les hérite
create policy "temps: lecture" on public.time_entries for select
  using (server_id = public.my_approved_server() and exists (select 1 from public.tasks t where t.id = task_id));
create policy "temps: ajout" on public.time_entries for insert
  with check (user_id = auth.uid() and server_id = public.my_approved_server() and public.my_role() <> 'guest'
              and exists (select 1 from public.tasks t where t.id = task_id and t.server_id = server_id));
create policy "temps: modification" on public.time_entries for update
  using (user_id = auth.uid() and server_id = public.my_approved_server())
  with check (user_id = auth.uid() and server_id = public.my_approved_server());
create policy "temps: suppression" on public.time_entries for delete
  using (server_id = public.my_approved_server() and (user_id = auth.uid() or public.my_role() = 'admin'));

create or replace function public.time_entries_lock_columns()
returns trigger language plpgsql as $$
begin
  if new.task_id <> old.task_id or new.user_id <> old.user_id or new.server_id <> old.server_id then
    raise exception 'Modification interdite.';
  end if;
  return new;
end $$;
drop trigger if exists trg_time_entries_lock on public.time_entries;
create trigger trg_time_entries_lock before update on public.time_entries
  for each row execute function public.time_entries_lock_columns();

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'time_entries') then
    alter publication supabase_realtime add table public.time_entries;
  end if;
end $$;
