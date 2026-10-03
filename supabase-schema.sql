-- ============================================================
-- LE CARNET — schéma Supabase
-- À exécuter dans : Supabase Dashboard > SQL Editor > New query
-- ============================================================

-- Extension nécessaire pour les uuid
create extension if not exists "pgcrypto";

-- ------------------------------------------------------------
-- Table des profils (un par compte, lié à auth.users)
-- ------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  email text not null,
  display_name text not null,
  color text default '#5B9EF5',
  role text not null default 'member' check (role in ('admin','moderator','member','guest')),
  permissions jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Table des tâches
-- ------------------------------------------------------------
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  notes text default '',
  label text not null default 'azur',
  priority int not null default 2,
  due date,
  done boolean not null default false,
  assignee uuid references public.profiles(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Table des messages (conversations privées 1-à-1)
-- ------------------------------------------------------------
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  from_id uuid not null references public.profiles(id) on delete cascade,
  to_id uuid not null references public.profiles(id) on delete cascade,
  text text not null,
  ts timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Activation de la sécurité au niveau des lignes (RLS)
-- ------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.tasks    enable row level security;
alter table public.messages enable row level security;

-- Fonction utilitaire : récupère le profil de l'utilisateur connecté
create or replace function public.current_profile()
returns public.profiles
language sql stable security definer
as $$
  select * from public.profiles where id = auth.uid();
$$;

-- ------------------------------------------------------------
-- PROFILES : tout le monde connecté peut lire (pour voir qui existe),
-- mais PERSONNE ne peut écrire depuis le client — la création,
-- modification et suppression de comptes passe uniquement par les
-- fonctions serveur (api/create-account, api/delete-account) qui
-- utilisent la clé "service role", laquelle contourne RLS.
-- ------------------------------------------------------------
create policy "profiles: lecture pour tous les connectés"
  on public.profiles for select
  using (auth.uid() is not null);

-- (aucune policy insert/update/delete => bloqué par défaut pour le client)

-- ------------------------------------------------------------
-- TASKS
-- ------------------------------------------------------------
create policy "tasks: lecture pour tous les connectés"
  on public.tasks for select
  using (auth.uid() is not null);

create policy "tasks: création selon droits"
  on public.tasks for insert
  with check (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and (p.role in ('admin','moderator') or (p.permissions->>'createTasks')::boolean is true)
    )
  );

create policy "tasks: modification selon droits"
  on public.tasks for update
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and (
          p.role in ('admin','moderator')
          or (p.permissions->>'editAnyTask')::boolean is true
          or (created_by = auth.uid() and (p.permissions->>'editOwnTask')::boolean is true)
        )
    )
  );

create policy "tasks: suppression selon droits"
  on public.tasks for delete
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and (
          p.role in ('admin','moderator')
          or (p.permissions->>'deleteAnyTask')::boolean is true
          or (created_by = auth.uid() and (p.permissions->>'deleteOwnTask')::boolean is true)
        )
    )
  );

-- ------------------------------------------------------------
-- MESSAGES — ici, contrairement à la version Claude, la
-- confidentialité est réelle : seuls les deux participants
-- peuvent lire une conversation.
-- ------------------------------------------------------------
create policy "messages: lecture par les participants uniquement"
  on public.messages for select
  using (auth.uid() = from_id or auth.uid() = to_id);

create policy "messages: envoi selon droits"
  on public.messages for insert
  with check (
    auth.uid() = from_id
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and (p.role in ('admin','moderator') or (p.permissions->>'sendMessages')::boolean is true)
    )
  );

-- ------------------------------------------------------------
-- Active le temps réel (pour que la messagerie/tâches se
-- synchronisent instantanément entre les personnes connectées)
-- ------------------------------------------------------------
alter publication supabase_realtime add table public.profiles;
alter publication supabase_realtime add table public.tasks;
alter publication supabase_realtime add table public.messages;
