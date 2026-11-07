-- ============================================================
-- Le Carnet · migration 31 : listes partagées et partage de dépenses
--   • lists / list_items : listes de courses, de bagages, d'idées… cochées à plusieurs, en direct.
--   • expenses / settlements : dépenses communes (qui a payé, pour qui) et remboursements ;
--     les soldes sont calculés dans l'application.
--   Tout est limité au serveur de la personne ; les invités (rôle « guest ») peuvent lire sans écrire.
--   Sans danger si relancée.
-- ============================================================

-- ---------- Listes ----------
create table if not exists public.lists (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  emoji text not null default '' check (char_length(emoji) <= 8),
  archived boolean not null default false,
  created_by uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists lists_server_idx on public.lists (server_id, archived, created_at);
create table if not exists public.list_items (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references public.lists(id) on delete cascade,
  server_id uuid not null references public.servers(id) on delete cascade,
  text text not null check (char_length(text) between 1 and 200),
  done boolean not null default false,
  done_by uuid references public.profiles(id) on delete set null,
  done_at timestamptz,
  created_by uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists list_items_idx on public.list_items (list_id, created_at);

-- ---------- Dépenses ----------
create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 80),
  amount_cents int not null check (amount_cents between 1 and 100000000),
  paid_by uuid not null references public.profiles(id) on delete cascade,
  split_among uuid[] not null check (cardinality(split_among) between 1 and 50),
  spent_on date not null default current_date,
  created_by uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists expenses_server_idx on public.expenses (server_id, spent_on desc);
create table if not exists public.settlements (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers(id) on delete cascade,
  from_user uuid not null references public.profiles(id) on delete cascade,
  to_user uuid not null references public.profiles(id) on delete cascade,
  amount_cents int not null check (amount_cents between 1 and 100000000),
  created_by uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  check (from_user <> to_user)
);
create index if not exists settlements_server_idx on public.settlements (server_id, created_at desc);

alter table public.lists enable row level security;
alter table public.list_items enable row level security;
alter table public.expenses enable row level security;
alter table public.settlements enable row level security;

-- ---------- Règles d'accès ----------
drop policy if exists "listes: lecture" on public.lists;
drop policy if exists "listes: ajout" on public.lists;
drop policy if exists "listes: modification" on public.lists;
drop policy if exists "listes: suppression" on public.lists;
create policy "listes: lecture" on public.lists for select using (server_id = public.my_approved_server());
create policy "listes: ajout" on public.lists for insert with check (server_id = public.my_approved_server() and created_by = auth.uid() and public.my_role() <> 'guest');
create policy "listes: modification" on public.lists for update using (server_id = public.my_approved_server() and (created_by = auth.uid() or public.my_role() = 'admin')) with check (server_id = public.my_approved_server());
create policy "listes: suppression" on public.lists for delete using (server_id = public.my_approved_server() and (created_by = auth.uid() or public.my_role() = 'admin'));

drop policy if exists "elements: lecture" on public.list_items;
drop policy if exists "elements: ajout" on public.list_items;
drop policy if exists "elements: modification" on public.list_items;
drop policy if exists "elements: suppression" on public.list_items;
create policy "elements: lecture" on public.list_items for select using (server_id = public.my_approved_server());
create policy "elements: ajout" on public.list_items for insert with check (server_id = public.my_approved_server() and created_by = auth.uid() and public.my_role() <> 'guest');
create policy "elements: modification" on public.list_items for update using (server_id = public.my_approved_server() and public.my_role() <> 'guest') with check (server_id = public.my_approved_server());
create policy "elements: suppression" on public.list_items for delete using (server_id = public.my_approved_server() and public.my_role() <> 'guest');

drop policy if exists "depenses: lecture" on public.expenses;
drop policy if exists "depenses: ajout" on public.expenses;
drop policy if exists "depenses: modification" on public.expenses;
drop policy if exists "depenses: suppression" on public.expenses;
create policy "depenses: lecture" on public.expenses for select using (server_id = public.my_approved_server());
create policy "depenses: ajout" on public.expenses for insert with check (server_id = public.my_approved_server() and created_by = auth.uid() and public.my_role() <> 'guest');
create policy "depenses: modification" on public.expenses for update using (server_id = public.my_approved_server() and (created_by = auth.uid() or public.my_role() = 'admin')) with check (server_id = public.my_approved_server());
create policy "depenses: suppression" on public.expenses for delete using (server_id = public.my_approved_server() and (created_by = auth.uid() or public.my_role() = 'admin'));

drop policy if exists "remboursements: lecture" on public.settlements;
drop policy if exists "remboursements: ajout" on public.settlements;
drop policy if exists "remboursements: suppression" on public.settlements;
create policy "remboursements: lecture" on public.settlements for select using (server_id = public.my_approved_server());
create policy "remboursements: ajout" on public.settlements for insert with check (server_id = public.my_approved_server() and created_by = auth.uid() and public.my_role() <> 'guest' and (from_user = auth.uid() or to_user = auth.uid() or public.my_role() = 'admin'));
create policy "remboursements: suppression" on public.settlements for delete using (server_id = public.my_approved_server() and (created_by = auth.uid() or public.my_role() = 'admin'));

-- ---------- Garde-fous ----------
create or replace function public.lists_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' and (select count(*) from public.lists where server_id = new.server_id and not archived) >= 40 then
    raise exception 'Ce serveur compte déjà 40 listes actives : archivez ou supprimez-en avant d''en créer une nouvelle.';
  end if;
  return new;
end $$;
drop trigger if exists trg_lists_guard on public.lists;
create trigger trg_lists_guard before insert on public.lists for each row execute function public.lists_guard();

create or replace function public.list_items_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if not exists (select 1 from public.lists l where l.id = new.list_id and l.server_id = new.server_id) then
      raise exception 'Cette liste n''existe pas dans votre serveur.';
    end if;
    if (select count(*) from public.list_items where list_id = new.list_id) >= 300 then
      raise exception 'Une liste peut contenir 300 éléments au maximum.';
    end if;
  end if;
  if tg_op = 'UPDATE' then
    if new.list_id <> old.list_id or new.server_id <> old.server_id then
      raise exception 'Un élément ne peut pas changer de liste.';
    end if;
    if new.done and not old.done then new.done_by := auth.uid(); new.done_at := now();
    elsif not new.done and old.done then new.done_by := null; new.done_at := null; end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_list_items_guard on public.list_items;
create trigger trg_list_items_guard before insert or update on public.list_items for each row execute function public.list_items_guard();

create or replace function public.expenses_guard()
returns trigger language plpgsql as $$
declare bad int;
begin
  select count(*) into bad from (select unnest(new.split_among || new.paid_by) as u) x
    where not exists (select 1 from public.profiles p where p.id = x.u and p.server_id = new.server_id);
  if bad > 0 then raise exception 'Toutes les personnes concernées doivent appartenir à ce serveur.'; end if;
  if (select count(distinct u) from unnest(new.split_among) u) <> cardinality(new.split_among) then
    raise exception 'Une personne ne peut apparaître qu''une seule fois dans le partage.';
  end if;
  if tg_op = 'INSERT' and (select count(*) from public.expenses where server_id = new.server_id) >= 2000 then
    raise exception 'Ce serveur a atteint la limite de 2000 dépenses.';
  end if;
  return new;
end $$;
drop trigger if exists trg_expenses_guard on public.expenses;
create trigger trg_expenses_guard before insert or update on public.expenses for each row execute function public.expenses_guard();

create or replace function public.settlements_guard()
returns trigger language plpgsql as $$
begin
  if (select count(*) from public.profiles p where p.id in (new.from_user, new.to_user) and p.server_id = new.server_id) <> 2 then
    raise exception 'Les deux personnes doivent appartenir à ce serveur.';
  end if;
  return new;
end $$;
drop trigger if exists trg_settlements_guard on public.settlements;
create trigger trg_settlements_guard before insert on public.settlements for each row execute function public.settlements_guard();

-- ---------- Temps réel ----------
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'lists') then alter publication supabase_realtime add table public.lists; end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'list_items') then alter publication supabase_realtime add table public.list_items; end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'expenses') then alter publication supabase_realtime add table public.expenses; end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'settlements') then alter publication supabase_realtime add table public.settlements; end if;
end $$;
