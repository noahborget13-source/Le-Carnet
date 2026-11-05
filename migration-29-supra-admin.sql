-- ============================================================
-- Le Carnet · migration 29 : Supra Admin (réservé au propriétaire de la plateforme)
--   • Bannissement de comptes : colonnes banned_at / ban_reason / banned_by sur profiles.
--     Un compte banni n'a plus accès à aucune donnée (my_approved_server et my_role ne le reconnaissent plus).
--     Seul le serveur (clé de service, via /api/admin-tools) peut bannir ou débannir.
--   • platform_settings : réglages de la plateforme (notifications par email au propriétaire).
--   • platform_log : journal des actions du Supra Admin.
--   Sans danger si relancée.
-- ============================================================
alter table public.profiles add column if not exists banned_at timestamptz;
alter table public.profiles add column if not exists ban_reason text not null default '' check (char_length(ban_reason) <= 300);
alter table public.profiles add column if not exists banned_by uuid references auth.users(id) on delete set null;

create or replace function public.my_approved_server()
returns uuid language sql stable security definer as $$
  select server_id from public.profiles where id = auth.uid() and status = 'approved' and banned_at is null;
$$;
create or replace function public.my_role()
returns text language sql stable security definer as $$
  select role from public.profiles where id = auth.uid() and status = 'approved' and banned_at is null;
$$;

-- Personne ne peut se (dé)bannir depuis l'application : seules les connexions sans utilisateur (clé de service) le peuvent.
create or replace function public.profiles_protect_ban()
returns trigger language plpgsql as $$
begin
  if auth.uid() is not null then
    if tg_op = 'INSERT' and (new.banned_at is not null or new.banned_by is not null or coalesce(new.ban_reason, '') <> '') then
      raise exception 'Modification interdite.';
    end if;
    if tg_op = 'UPDATE' and (new.banned_at is distinct from old.banned_at or new.banned_by is distinct from old.banned_by or new.ban_reason is distinct from old.ban_reason) then
      raise exception 'Modification interdite.';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_profiles_protect_ban on public.profiles;
create trigger trg_profiles_protect_ban before insert or update on public.profiles for each row execute function public.profiles_protect_ban();

create table if not exists public.platform_settings (
  key text primary key check (char_length(key) between 1 and 60),
  value jsonb not null default 'null'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.platform_settings enable row level security;
drop policy if exists "réglages plateforme: lecture" on public.platform_settings;
drop policy if exists "réglages plateforme: ajout" on public.platform_settings;
drop policy if exists "réglages plateforme: modification" on public.platform_settings;
create policy "réglages plateforme: lecture" on public.platform_settings for select using (public.is_platform_admin());
create policy "réglages plateforme: ajout" on public.platform_settings for insert with check (public.is_platform_admin());
create policy "réglages plateforme: modification" on public.platform_settings for update using (public.is_platform_admin()) with check (public.is_platform_admin());
insert into public.platform_settings (key, value) values
  ('notify_signup', 'true'), ('notify_server', 'true'), ('notify_ban', 'true')
on conflict (key) do nothing;

create table if not exists public.platform_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users(id) on delete set null,
  action text not null check (char_length(action) <= 40),
  target_id uuid,
  target_label text not null default '' check (char_length(target_label) <= 200),
  detail text not null default '' check (char_length(detail) <= 400),
  created_at timestamptz not null default now()
);
create index if not exists platform_log_idx on public.platform_log (created_at desc);
alter table public.platform_log enable row level security;
drop policy if exists "journal plateforme: lecture" on public.platform_log;
create policy "journal plateforme: lecture" on public.platform_log for select using (public.is_platform_admin());
-- (aucune règle d'écriture : seul le serveur écrit dans le journal)
