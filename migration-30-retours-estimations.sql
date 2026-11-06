-- ============================================================
-- Le Carnet · migration 30 : retours des utilisateurs et temps estimé des tâches
--   • tasks.estimate_min : durée estimée d'une tâche, en minutes (5 min à 24 h), facultative.
--   • feedback : idées, problèmes, questions et compliments envoyés depuis l'application.
--     Les clients ne peuvent que relire leurs propres envois : l'écriture passe par le serveur
--     (/api/manage-account), qui limite le nombre d'envois et prévient le propriétaire.
--   Sans danger si relancée.
-- ============================================================
alter table public.tasks add column if not exists estimate_min int;
alter table public.tasks drop constraint if exists tasks_estimate_range;
alter table public.tasks add constraint tasks_estimate_range check (estimate_min is null or estimate_min between 5 and 1440);

create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  server_id uuid references public.servers(id) on delete set null,
  kind text not null check (kind in ('idee', 'bug', 'question', 'compliment')),
  message text not null check (char_length(message) between 3 and 2000),
  page text not null default '' check (char_length(page) <= 60),
  status text not null default 'new' check (status in ('new', 'read', 'done')),
  created_at timestamptz not null default now()
);
create index if not exists feedback_created_idx on public.feedback (created_at desc);
create index if not exists feedback_user_idx on public.feedback (user_id, created_at desc);
alter table public.feedback enable row level security;
drop policy if exists "retours: lecture des siens" on public.feedback;
create policy "retours: lecture des siens" on public.feedback for select using (user_id = auth.uid());
-- (aucune règle d'écriture : seul le serveur, avec la clé de service, enregistre et classe les retours)

insert into public.platform_settings (key, value) values ('notify_feedback', 'true') on conflict (key) do nothing;
