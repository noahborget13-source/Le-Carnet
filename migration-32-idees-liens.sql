-- ============================================================
-- Le Carnet · migration 32 : boîte à idées et bibliothèque de liens
--   • ideas / idea_votes : propositions de l'équipe, un vote par personne,
--     statut (nouvelle, retenue, faite, écartée) réservé aux administrateurs.
--   • links : liens utiles partagés (titre, adresse, description, étiquettes, épingle).
--   Tout est limité au serveur de la personne ; les invités (rôle « guest ») lisent sans écrire.
--   Sans danger si relancée.
-- ============================================================

create table if not exists public.ideas (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  details text not null default '' check (char_length(details) <= 1500),
  status text not null default 'new' check (status in ('new','kept','done','dropped')),
  created_by uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists ideas_server_idx on public.ideas (server_id, status, created_at desc);
create table if not exists public.idea_votes (
  idea_id uuid not null references public.ideas(id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  server_id uuid not null references public.servers(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (idea_id, user_id)
);
create table if not exists public.links (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 100),
  url text not null check (char_length(url) between 8 and 500 and url ~* '^https?://[^\s]+$'),
  description text not null default '' check (char_length(description) <= 300),
  tags text[] not null default '{}' check (cardinality(tags) <= 6),
  pinned boolean not null default false,
  created_by uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists links_server_idx on public.links (server_id, pinned desc, created_at desc);

alter table public.ideas enable row level security;
alter table public.idea_votes enable row level security;
alter table public.links enable row level security;

drop policy if exists "idees: lecture" on public.ideas;
drop policy if exists "idees: ajout" on public.ideas;
drop policy if exists "idees: modification" on public.ideas;
drop policy if exists "idees: suppression" on public.ideas;
create policy "idees: lecture" on public.ideas for select using (server_id = public.my_approved_server());
create policy "idees: ajout" on public.ideas for insert with check (server_id = public.my_approved_server() and created_by = auth.uid() and public.my_role() <> 'guest');
create policy "idees: modification" on public.ideas for update using (server_id = public.my_approved_server() and (created_by = auth.uid() or public.my_role() = 'admin')) with check (server_id = public.my_approved_server());
create policy "idees: suppression" on public.ideas for delete using (server_id = public.my_approved_server() and (created_by = auth.uid() or public.my_role() = 'admin'));

drop policy if exists "votes: lecture" on public.idea_votes;
drop policy if exists "votes: ajout" on public.idea_votes;
drop policy if exists "votes: suppression" on public.idea_votes;
create policy "votes: lecture" on public.idea_votes for select using (server_id = public.my_approved_server());
create policy "votes: ajout" on public.idea_votes for insert with check (server_id = public.my_approved_server() and user_id = auth.uid() and public.my_role() <> 'guest');
create policy "votes: suppression" on public.idea_votes for delete using (server_id = public.my_approved_server() and user_id = auth.uid());

drop policy if exists "liens: lecture" on public.links;
drop policy if exists "liens: ajout" on public.links;
drop policy if exists "liens: modification" on public.links;
drop policy if exists "liens: suppression" on public.links;
create policy "liens: lecture" on public.links for select using (server_id = public.my_approved_server());
create policy "liens: ajout" on public.links for insert with check (server_id = public.my_approved_server() and created_by = auth.uid() and public.my_role() <> 'guest');
create policy "liens: modification" on public.links for update using (server_id = public.my_approved_server() and (created_by = auth.uid() or public.my_role() = 'admin')) with check (server_id = public.my_approved_server());
create policy "liens: suppression" on public.links for delete using (server_id = public.my_approved_server() and (created_by = auth.uid() or public.my_role() = 'admin'));

-- ---------- Garde-fous ----------
create or replace function public.ideas_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.status := 'new';
    if (select count(*) from public.ideas where server_id = new.server_id) >= 500 then
      raise exception 'Ce serveur a atteint la limite de 500 idées : supprimez-en avant d''en proposer une nouvelle.';
    end if;
  else
    if new.server_id <> old.server_id or new.created_by <> old.created_by then
      raise exception 'Cette modification n''est pas autorisée.';
    end if;
    if new.status <> old.status and public.my_role() <> 'admin' and auth.uid() is not null then
      raise exception 'Seul un administrateur peut changer le statut d''une idée.';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_ideas_guard on public.ideas;
create trigger trg_ideas_guard before insert or update on public.ideas for each row execute function public.ideas_guard();

create or replace function public.idea_votes_guard()
returns trigger language plpgsql as $$
begin
  if not exists (select 1 from public.ideas i where i.id = new.idea_id and i.server_id = new.server_id) then
    raise exception 'Cette idée n''existe pas dans votre serveur.';
  end if;
  return new;
end $$;
drop trigger if exists trg_idea_votes_guard on public.idea_votes;
create trigger trg_idea_votes_guard before insert on public.idea_votes for each row execute function public.idea_votes_guard();

create or replace function public.links_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' and (select count(*) from public.links where server_id = new.server_id) >= 500 then
    raise exception 'Ce serveur a atteint la limite de 500 liens.';
  end if;
  if tg_op = 'UPDATE' and new.server_id <> old.server_id then raise exception 'Cette modification n''est pas autorisée.'; end if;
  return new;
end $$;
drop trigger if exists trg_links_guard on public.links;
create trigger trg_links_guard before insert or update on public.links for each row execute function public.links_guard();

-- ---------- Temps réel ----------
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'ideas') then alter publication supabase_realtime add table public.ideas; end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'idea_votes') then alter publication supabase_realtime add table public.idea_votes; end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'links') then alter publication supabase_realtime add table public.links; end if;
end $$;
