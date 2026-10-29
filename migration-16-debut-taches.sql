-- ============================================================
-- Le Carnet · migration 16 : date de début des tâches (vue Chronologie)
--   Une tâche peut avoir un début facultatif ; la vue « Chronologie » dessine
--   une barre du début à l'échéance. Sans danger si relancée.
-- ============================================================
alter table public.tasks add column if not exists start_date date;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_start_before_due_check') then
    alter table public.tasks add constraint tasks_start_before_due_check
      check (start_date is null or due is null or start_date <= due);
  end if;
end $$;
