-- ============================================================
-- Le Carnet · migration 34 : carnet d'adresses partagé et mur de remerciements
--   • contacts : fiches partagées par tout le serveur (nom, téléphone, e-mail, organisation,
--     adresse, notes, étiquettes, favori). Les invités lisent sans écrire.
--   • kudos : un remerciement public d'une personne à une autre (emoji + message court),
--     avec une notification pour la personne remerciée. Un remerciement ne se modifie pas ;
--     il peut être supprimé par son auteur ou par un administrateur. 20 par personne et par jour.
--   • notifications : ajout du type « kudos ».
--   Sans danger si relancée.
-- ============================================================

create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  phone text not null default '' check (char_length(phone) <= 30),
  email text not null default '' check (char_length(email) <= 120 and (email = '' or email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$')),
  org text not null default '' check (char_length(org) <= 100),
  address text not null default '' check (char_length(address) <= 200),
  notes text not null default '' check (char_length(notes) <= 500),
  tags text[] not null default '{}' check (cardinality(tags) <= 6),
  favorite boolean not null default false,
  created_by uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists contacts_server_idx on public.contacts (server_id, name);

create table if not exists public.kudos (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers(id) on delete cascade,
  from_user uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  to_user uuid not null references public.profiles(id) on delete cascade,
  emoji text not null default '👏' check (char_length(emoji) between 1 and 8),
  message text not null check (char_length(message) between 1 and 280),
  created_at timestamptz not null default now(),
  check (from_user <> to_user)
);
create index if not exists kudos_server_idx on public.kudos (server_id, created_at desc);
create index if not exists kudos_to_idx on public.kudos (to_user, created_at desc);

alter table public.contacts enable row level security;
alter table public.kudos enable row level security;

drop policy if exists "contacts: lecture" on public.contacts;
drop policy if exists "contacts: ajout" on public.contacts;
drop policy if exists "contacts: modification" on public.contacts;
drop policy if exists "contacts: suppression" on public.contacts;
create policy "contacts: lecture" on public.contacts for select using (server_id = public.my_approved_server());
create policy "contacts: ajout" on public.contacts for insert with check (server_id = public.my_approved_server() and created_by = auth.uid() and public.my_role() <> 'guest');
create policy "contacts: modification" on public.contacts for update using (server_id = public.my_approved_server() and (created_by = auth.uid() or public.my_role() = 'admin')) with check (server_id = public.my_approved_server());
create policy "contacts: suppression" on public.contacts for delete using (server_id = public.my_approved_server() and (created_by = auth.uid() or public.my_role() = 'admin'));

drop policy if exists "kudos: lecture" on public.kudos;
drop policy if exists "kudos: ajout" on public.kudos;
drop policy if exists "kudos: suppression" on public.kudos;
create policy "kudos: lecture" on public.kudos for select using (server_id = public.my_approved_server());
create policy "kudos: ajout" on public.kudos for insert with check (server_id = public.my_approved_server() and from_user = auth.uid() and public.my_role() <> 'guest');
create policy "kudos: suppression" on public.kudos for delete using (server_id = public.my_approved_server() and (from_user = auth.uid() or public.my_role() = 'admin'));
-- (aucune règle de modification : un remerciement ne se réécrit pas)

-- ---------- Garde-fous ----------
create or replace function public.contacts_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' and (select count(*) from public.contacts where server_id = new.server_id) >= 1000 then
    raise exception 'Ce serveur a atteint la limite de 1000 contacts.';
  end if;
  if tg_op = 'UPDATE' and (new.server_id <> old.server_id or new.created_by <> old.created_by) then raise exception 'Cette modification n''est pas autorisée.'; end if;
  return new;
end $$;
drop trigger if exists trg_contacts_guard on public.contacts;
create trigger trg_contacts_guard before insert or update on public.contacts for each row execute function public.contacts_guard();

create or replace function public.kudos_guard()
returns trigger language plpgsql as $$
begin
  if not exists (select 1 from public.profiles where id = new.to_user and server_id = new.server_id and status = 'approved') then
    raise exception 'Cette personne ne fait pas partie de votre serveur.';
  end if;
  if (select count(*) from public.kudos where from_user = new.from_user and created_at > now() - interval '24 hours') >= 20 then
    raise exception 'Vous avez déjà envoyé 20 remerciements aujourd''hui : revenez demain !';
  end if;
  return new;
end $$;
drop trigger if exists trg_kudos_guard on public.kudos;
create trigger trg_kudos_guard before insert on public.kudos for each row execute function public.kudos_guard();

-- ---------- Notification de la personne remerciée ----------
alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('assigned', 'comment', 'mention', 'dm', 'meeting', 'leave_request', 'leave_decision', 'announcement', 'kudos'));

create or replace function public.trg_notify_kudos()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.push_notification(new.server_id, new.to_user, 'kudos', public.actor_name(new.from_user) || ' vous remercie ' || new.emoji, new.message, null, new.id, new.from_user);
  return new;
end $$;
drop trigger if exists trg_notify_kudos on public.kudos;
create trigger trg_notify_kudos after insert on public.kudos for each row execute function public.trg_notify_kudos();

-- ---------- Temps réel ----------
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'contacts') then alter publication supabase_realtime add table public.contacts; end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'kudos') then alter publication supabase_realtime add table public.kudos; end if;
end $$;
