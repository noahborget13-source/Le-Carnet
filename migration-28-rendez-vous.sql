-- ============================================================
-- Le Carnet · migration 28 : prise de rendez-vous (présentiel ou appel)
--   Chaque membre (hors invités) peut publier ses disponibilités hebdomadaires ; les autres membres
--   réservent un créneau libre, en présentiel ou en appel. Un créneau ne peut être pris qu'une fois,
--   uniquement dans les disponibilités publiées. Les rendez-vous ne sont visibles que de l'hôte,
--   de l'invité et de l'administrateur ; les autres voient seulement que le créneau est occupé.
--   Sans danger si relancée.
-- ============================================================
create table if not exists public.availabilities (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers(id) on delete cascade,
  host_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  weekday smallint not null check (weekday between 1 and 7),
  start_min int not null check (start_min between 0 and 1439),
  end_min int not null check (end_min between 1 and 1440),
  slot_min int not null default 30 check (slot_min in (15, 20, 30, 45, 60, 90)),
  modes text[] not null default '{presentiel,appel}' check (cardinality(modes) between 1 and 2 and modes <@ array['presentiel', 'appel']),
  location text not null default '' check (char_length(location) <= 120),
  created_at timestamptz not null default now(),
  check (end_min >= start_min + slot_min)
);
create index if not exists availabilities_idx on public.availabilities (host_id, weekday);
create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers(id) on delete cascade,
  host_id uuid not null references public.profiles(id) on delete cascade,
  guest_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  mode text not null check (mode in ('presentiel', 'appel')),
  note text not null default '' check (char_length(note) <= 300),
  created_at timestamptz not null default now(),
  check (ends_at > starts_at and ends_at <= starts_at + interval '3 hours' and host_id <> guest_id)
);
create index if not exists appointments_host_idx on public.appointments (host_id, starts_at);
create index if not exists appointments_guest_idx on public.appointments (guest_id, starts_at);
alter table public.availabilities enable row level security;
alter table public.appointments enable row level security;

drop policy if exists "disponibilités: lecture" on public.availabilities;
drop policy if exists "disponibilités: ajout" on public.availabilities;
drop policy if exists "disponibilités: modification" on public.availabilities;
drop policy if exists "disponibilités: suppression" on public.availabilities;
create policy "disponibilités: lecture" on public.availabilities for select using (server_id = public.my_approved_server());
create policy "disponibilités: ajout" on public.availabilities for insert with check (host_id = auth.uid() and server_id = public.my_approved_server() and public.my_role() <> 'guest');
create policy "disponibilités: modification" on public.availabilities for update using (host_id = auth.uid()) with check (host_id = auth.uid() and server_id = public.my_approved_server());
create policy "disponibilités: suppression" on public.availabilities for delete using (host_id = auth.uid() or (server_id = public.my_approved_server() and public.my_role() = 'admin'));

drop policy if exists "rendez-vous: lecture" on public.appointments;
drop policy if exists "rendez-vous: ajout" on public.appointments;
drop policy if exists "rendez-vous: suppression" on public.appointments;
create policy "rendez-vous: lecture" on public.appointments for select using (server_id = public.my_approved_server() and (host_id = auth.uid() or guest_id = auth.uid() or public.my_role() = 'admin'));
create policy "rendez-vous: ajout" on public.appointments for insert with check (guest_id = auth.uid() and server_id = public.my_approved_server() and public.my_role() <> 'guest');
create policy "rendez-vous: suppression" on public.appointments for delete using (server_id = public.my_approved_server() and (host_id = auth.uid() or guest_id = auth.uid() or public.my_role() = 'admin'));
-- (pas de règle de modification : pour changer de créneau, on annule puis on reprend rendez-vous)

-- Créneaux déjà pris chez un hôte, sans révéler qui ni pourquoi
create or replace function public.busy_slots(p_host uuid, p_from timestamptz, p_to timestamptz)
returns table (starts_at timestamptz, ends_at timestamptz)
language sql stable security definer set search_path = public as $$
  select a.starts_at, a.ends_at from public.appointments a
  where a.host_id = p_host and a.server_id = public.my_approved_server() and a.starts_at < p_to and a.ends_at > p_from
$$;
revoke all on function public.busy_slots(uuid, timestamptz, timestamptz) from public;
grant execute on function public.busy_slots(uuid, timestamptz, timestamptz) to authenticated;

-- Garde-fou : le créneau doit exister dans les disponibilités de l'hôte, être libre et à venir
create or replace function public.appointments_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  l_start timestamp; l_end timestamp; m_start int; m_end int;
begin
  if tg_op = 'UPDATE' then raise exception 'Modification interdite.'; end if;
  if not exists (select 1 from public.profiles p where p.id = new.host_id and p.server_id = new.server_id and p.role <> 'guest') then
    raise exception 'Cette personne ne peut pas recevoir de rendez-vous.';
  end if;
  if new.starts_at < now() then raise exception 'Ce créneau est déjà passé.'; end if;
  l_start := new.starts_at at time zone 'Europe/Paris';
  l_end := new.ends_at at time zone 'Europe/Paris';
  if l_start::date <> l_end::date then raise exception 'Ce créneau n''est pas disponible.'; end if;
  m_start := extract(hour from l_start)::int * 60 + extract(minute from l_start)::int;
  m_end := extract(hour from l_end)::int * 60 + extract(minute from l_end)::int;
  if not exists (
    select 1 from public.availabilities v
    where v.host_id = new.host_id and v.weekday = extract(isodow from l_start)::int
      and m_start >= v.start_min and m_end <= v.end_min
      and m_end - m_start = v.slot_min and (m_start - v.start_min) % v.slot_min = 0
      and new.mode = any (v.modes)
  ) then raise exception 'Ce créneau n''est pas disponible.'; end if;
  perform pg_advisory_xact_lock(hashtext(new.host_id::text));
  if exists (select 1 from public.appointments a where a.host_id = new.host_id and a.starts_at < new.ends_at and a.ends_at > new.starts_at) then
    raise exception 'Ce créneau vient d''être pris.';
  end if;
  if exists (select 1 from public.appointments a where a.guest_id = new.guest_id and a.starts_at < new.ends_at and a.ends_at > new.starts_at) then
    raise exception 'Vous avez déjà un rendez-vous sur ce créneau.';
  end if;
  return new;
end $$;
drop trigger if exists trg_appointments_guard on public.appointments;
create trigger trg_appointments_guard before insert or update on public.appointments for each row execute function public.appointments_guard();

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'availabilities') then alter publication supabase_realtime add table public.availabilities; end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'appointments') then alter publication supabase_realtime add table public.appointments; end if;
end $$;
