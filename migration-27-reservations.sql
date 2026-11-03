-- ============================================================
-- Le Carnet · migration 27 : réservation de ressources
--   Salles, véhicules, matériel : l'administrateur ou un modérateur déclare les ressources,
--   chaque membre (hors invités) les réserve sur un créneau. Deux réservations ne peuvent pas se chevaucher.
--   Sans danger si relancée.
-- ============================================================
create table if not exists public.resources (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  kind text not null default '' check (char_length(kind) <= 30),
  emoji text not null default '' check (char_length(emoji) <= 8),
  active boolean not null default true,
  created_by uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null references public.resources(id) on delete cascade,
  server_id uuid not null references public.servers(id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  title text not null default '' check (char_length(title) <= 80),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at and ends_at <= starts_at + interval '24 hours')
);
create index if not exists bookings_idx on public.bookings (resource_id, starts_at);
alter table public.resources enable row level security;
alter table public.bookings enable row level security;
drop policy if exists "ressources: lecture" on public.resources;
drop policy if exists "ressources: ajout" on public.resources;
drop policy if exists "ressources: modification" on public.resources;
drop policy if exists "ressources: suppression" on public.resources;
create policy "ressources: lecture" on public.resources for select using (server_id = public.my_approved_server());
create policy "ressources: ajout" on public.resources for insert with check (server_id = public.my_approved_server() and public.my_role() in ('admin', 'moderator'));
create policy "ressources: modification" on public.resources for update using (server_id = public.my_approved_server() and public.my_role() in ('admin', 'moderator')) with check (server_id = public.my_approved_server());
create policy "ressources: suppression" on public.resources for delete using (server_id = public.my_approved_server() and public.my_role() in ('admin', 'moderator'));
drop policy if exists "réservations: lecture" on public.bookings;
drop policy if exists "réservations: ajout" on public.bookings;
drop policy if exists "réservations: modification" on public.bookings;
drop policy if exists "réservations: suppression" on public.bookings;
create policy "réservations: lecture" on public.bookings for select using (server_id = public.my_approved_server());
create policy "réservations: ajout" on public.bookings for insert with check (
  user_id = auth.uid() and server_id = public.my_approved_server() and public.my_role() <> 'guest'
  and exists (select 1 from public.resources r where r.id = resource_id and r.server_id = server_id and r.active));
create policy "réservations: modification" on public.bookings for update using (server_id = public.my_approved_server() and (user_id = auth.uid() or public.my_role() = 'admin')) with check (server_id = public.my_approved_server());
create policy "réservations: suppression" on public.bookings for delete using (server_id = public.my_approved_server() and (user_id = auth.uid() or public.my_role() = 'admin'));

create or replace function public.bookings_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and (new.resource_id <> old.resource_id or new.user_id <> old.user_id or new.server_id <> old.server_id) then raise exception 'Modification interdite.'; end if;
  perform pg_advisory_xact_lock(hashtext(new.resource_id::text));
  if exists (select 1 from public.bookings b where b.resource_id = new.resource_id and b.id <> new.id and b.starts_at < new.ends_at and b.ends_at > new.starts_at) then
    raise exception 'Cette ressource est déjà réservée sur ce créneau.';
  end if;
  return new;
end $$;
drop trigger if exists trg_bookings_guard on public.bookings;
create trigger trg_bookings_guard before insert or update on public.bookings for each row execute function public.bookings_guard();

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'resources') then alter publication supabase_realtime add table public.resources; end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'bookings') then alter publication supabase_realtime add table public.bookings; end if;
end $$;
