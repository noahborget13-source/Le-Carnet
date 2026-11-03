-- ============================================================
-- Le Carnet · migration 26 : suivi d'habitudes
--   Des routines personnelles (« Lire 20 minutes », « Marcher ») cochées jour après jour, avec séries.
--   Strictement privées : seule la personne concernée les voit. 20 habitudes actives au maximum.
--   Sans danger si relancée.
-- ============================================================
create table if not exists public.habits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  server_id uuid not null references public.servers(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  emoji text not null default '' check (char_length(emoji) <= 8),
  weekdays int[] not null default '{1,2,3,4,5,6,7}' check (cardinality(weekdays) between 1 and 7 and weekdays <@ array[1,2,3,4,5,6,7]),
  archived boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists habits_idx on public.habits (user_id, archived, created_at);
create table if not exists public.habit_logs (
  habit_id uuid not null references public.habits(id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  day date not null,
  created_at timestamptz not null default now(),
  primary key (habit_id, day)
);
create index if not exists habit_logs_idx on public.habit_logs (user_id, day desc);
alter table public.habits enable row level security;
alter table public.habit_logs enable row level security;
drop policy if exists "habitudes: lecture" on public.habits;
drop policy if exists "habitudes: ajout" on public.habits;
drop policy if exists "habitudes: modification" on public.habits;
drop policy if exists "habitudes: suppression" on public.habits;
create policy "habitudes: lecture" on public.habits for select using (user_id = auth.uid());
create policy "habitudes: ajout" on public.habits for insert with check (user_id = auth.uid() and server_id = public.my_approved_server());
create policy "habitudes: modification" on public.habits for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "habitudes: suppression" on public.habits for delete using (user_id = auth.uid());
drop policy if exists "coches: lecture" on public.habit_logs;
drop policy if exists "coches: ajout" on public.habit_logs;
drop policy if exists "coches: suppression" on public.habit_logs;
create policy "coches: lecture" on public.habit_logs for select using (user_id = auth.uid());
create policy "coches: ajout" on public.habit_logs for insert with check (user_id = auth.uid() and exists (select 1 from public.habits h where h.id = habit_id and h.user_id = auth.uid()) and day <= current_date + 1);
create policy "coches: suppression" on public.habit_logs for delete using (user_id = auth.uid());

create or replace function public.habits_limit()
returns trigger language plpgsql as $$
begin
  if not new.archived and (select count(*) from public.habits where user_id = new.user_id and not archived and id <> new.id) >= 20 then
    raise exception 'Vous pouvez suivre 20 habitudes actives au maximum.';
  end if;
  return new;
end $$;
drop trigger if exists trg_habits_limit on public.habits;
create trigger trg_habits_limit before insert or update of archived on public.habits for each row execute function public.habits_limit();

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'habits') then alter publication supabase_realtime add table public.habits; end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'habit_logs') then alter publication supabase_realtime add table public.habit_logs; end if;
end $$;
