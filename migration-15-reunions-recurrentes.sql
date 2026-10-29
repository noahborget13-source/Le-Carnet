-- ============================================================
-- Le Carnet · migration 15 : réunions récurrentes
--   Chaque occurrence reste une vraie réunion (rappels, invités, compte-rendu,
--   pièces jointes, disponibilités… fonctionnent donc sans changement).
--   Les occurrences d'une même série partagent un series_id.
-- À exécuter une fois dans le SQL Editor de Supabase. Sans risque si relancée.
-- ============================================================
alter table public.meetings add column if not exists series_id uuid;
alter table public.meetings add column if not exists recurrence text;
alter table public.meetings add column if not exists recurrence_until date;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'meetings_recurrence_check') then
    alter table public.meetings add constraint meetings_recurrence_check
      check (recurrence is null or recurrence in ('daily', 'weekly', 'biweekly', 'monthly'));
  end if;
  -- Une série a un identifiant, une règle et une date de fin ; une réunion isolée n'a aucun des trois
  if not exists (select 1 from pg_constraint where conname = 'meetings_series_check') then
    alter table public.meetings add constraint meetings_series_check
      check ((series_id is null and recurrence is null and recurrence_until is null)
          or (series_id is not null and recurrence is not null and recurrence_until is not null));
  end if;
end $$;

create index if not exists meetings_series_idx on public.meetings (series_id, starts_at) where series_id is not null;

-- La série, le salon, le serveur et le créateur ne changent jamais
create or replace function public.meetings_lock_columns()
returns trigger language plpgsql as $$
begin
  if new.server_id <> old.server_id or new.room <> old.room or new.created_by <> old.created_by
     or new.series_id is distinct from old.series_id or new.recurrence is distinct from old.recurrence then
    raise exception 'Modification interdite.';
  end if;
  return new;
end $$;
