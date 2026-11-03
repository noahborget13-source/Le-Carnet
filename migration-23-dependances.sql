-- ============================================================
-- Le Carnet · migration 23 : dépendances entre tâches
--   Une tâche peut être « bloquée par » d'autres tâches (10 au maximum).
--   Les droits ne changent pas : qui peut modifier la tâche peut modifier ses dépendances.
--   Sans danger si relancée.
-- ============================================================
alter table public.tasks add column if not exists blocked_by uuid[] not null default '{}';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_blocked_by_limit') then
    alter table public.tasks add constraint tasks_blocked_by_limit check (cardinality(blocked_by) <= 10 and not (id = any(blocked_by)));
  end if;
end $$;
