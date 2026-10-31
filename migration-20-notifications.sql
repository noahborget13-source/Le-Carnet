-- ============================================================
-- Le Carnet · migration 20 : centre de notifications (la cloche)
--   Chaque personne reçoit, dans l'application, ses propres notifications :
--   tâche assignée, commentaire, mention (@nom), message privé, invitation à une réunion,
--   demande et décision de congé, annonce de l'administrateur.
--   Elles sont créées par des déclencheurs : les clients ne peuvent ni en créer ni lire celles des autres.
--   Sans danger si relancée.
-- ============================================================
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('assigned', 'comment', 'mention', 'dm', 'meeting', 'leave_request', 'leave_decision', 'announcement')),
  title text not null check (char_length(title) between 1 and 200),
  body text not null default '' check (char_length(body) <= 300),
  task_id uuid references public.tasks(id) on delete cascade,
  ref_id uuid,
  actor_id uuid references public.profiles(id) on delete set null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);
create index if not exists notifications_unread_idx on public.notifications (user_id) where read_at is null;
alter table public.notifications enable row level security;
drop policy if exists "notifications: lecture" on public.notifications;
drop policy if exists "notifications: marquer lu" on public.notifications;
drop policy if exists "notifications: suppression" on public.notifications;
create policy "notifications: lecture" on public.notifications for select using (user_id = auth.uid());
create policy "notifications: marquer lu" on public.notifications for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "notifications: suppression" on public.notifications for delete using (user_id = auth.uid());
-- (aucune règle d'insertion : seuls les déclencheurs ci-dessous créent des notifications)

-- Seule la date de lecture peut changer
create or replace function public.notifications_lock_columns()
returns trigger language plpgsql as $$
begin
  if new.user_id <> old.user_id or new.server_id <> old.server_id or new.kind <> old.kind or new.title <> old.title
     or new.body <> old.body or new.task_id is distinct from old.task_id or new.ref_id is distinct from old.ref_id then
    raise exception 'Modification interdite.';
  end if;
  return new;
end $$;
drop trigger if exists trg_notifications_lock on public.notifications;
create trigger trg_notifications_lock before update on public.notifications
  for each row execute function public.notifications_lock_columns();

-- Création d'une notification (jamais pour soi-même)
create or replace function public.push_notification(p_server uuid, p_user uuid, p_kind text, p_title text, p_body text, p_task uuid, p_ref uuid, p_actor uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_user is null or p_user is not distinct from p_actor then return; end if;
  if not exists (select 1 from public.profiles where id = p_user and server_id = p_server and status = 'approved') then return; end if;
  delete from public.notifications where user_id = p_user and read_at is not null and read_at < now() - interval '30 days';
  insert into public.notifications (server_id, user_id, kind, title, body, task_id, ref_id, actor_id)
  values (p_server, p_user, p_kind, left(p_title, 200), left(coalesce(p_body, ''), 300), p_task, p_ref, p_actor);
end $$;
revoke all on function public.push_notification(uuid, uuid, text, text, text, uuid, uuid, uuid) from public, anon, authenticated;

create or replace function public.actor_name(p_actor uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select display_name from public.profiles where id = p_actor), 'Quelqu''un');
$$;
revoke all on function public.actor_name(uuid) from public, anon, authenticated;

-- 1. Tâche assignée
create or replace function public.trg_notify_task_assigned()
returns trigger language plpgsql security definer set search_path = public as $$
declare u uuid; actor uuid := auth.uid();
begin
  foreach u in array coalesce(new.assignees, '{}') loop
    if tg_op = 'INSERT' or not (u = any (coalesce(old.assignees, '{}'))) then
      perform public.push_notification(new.server_id, u, 'assigned', public.actor_name(actor) || ' vous a assigné « ' || new.title || ' »', '', new.id, null, actor);
    end if;
  end loop;
  return new;
end $$;
drop trigger if exists trg_notify_task_assigned on public.tasks;
create trigger trg_notify_task_assigned after insert or update of assignees on public.tasks
  for each row execute function public.trg_notify_task_assigned();

-- 2. Commentaire sur une tâche (+ mentions)
create or replace function public.trg_notify_comment()
returns trigger language plpgsql security definer set search_path = public as $$
declare t record; u uuid; mentioned uuid[] := '{}'; p record;
begin
  select id, server_id, title, created_by, assignees into t from public.tasks where id = new.task_id;
  if not found then return new; end if;
  for p in select id, username from public.profiles where server_id = t.server_id and status = 'approved' loop
    if new.text ~* ('(^|[^a-z0-9._-])@' || regexp_replace(p.username, '([.\-])', '\\\1', 'g') || '([^a-z0-9._-]|$)') then
      mentioned := mentioned || p.id;
      perform public.push_notification(t.server_id, p.id, 'mention', public.actor_name(new.author_id) || ' vous a mentionné dans « ' || t.title || ' »', new.text, t.id, new.id, new.author_id);
    end if;
  end loop;
  foreach u in array (coalesce(t.assignees, '{}') || coalesce(t.created_by, '00000000-0000-0000-0000-000000000000'::uuid)) loop
    if not (u = any (mentioned)) then
      perform public.push_notification(t.server_id, u, 'comment', public.actor_name(new.author_id) || ' a commenté « ' || t.title || ' »', new.text, t.id, new.id, new.author_id);
    end if;
  end loop;
  return new;
end $$;
drop trigger if exists trg_notify_comment on public.task_comments;
create trigger trg_notify_comment after insert on public.task_comments
  for each row execute function public.trg_notify_comment();

-- 3. Mention dans le salon
create or replace function public.trg_notify_channel_mention()
returns trigger language plpgsql security definer set search_path = public as $$
declare p record;
begin
  for p in select id, username from public.profiles where server_id = new.server_id and status = 'approved' loop
    if new.text ~* ('(^|[^a-z0-9._-])@' || regexp_replace(p.username, '([.\-])', '\\\1', 'g') || '([^a-z0-9._-]|$)') then
      perform public.push_notification(new.server_id, p.id, 'mention', public.actor_name(new.from_id) || ' vous a mentionné dans le salon', new.text, null, new.id, new.from_id);
    end if;
  end loop;
  return new;
end $$;
drop trigger if exists trg_notify_channel_mention on public.channel_messages;
create trigger trg_notify_channel_mention after insert on public.channel_messages
  for each row execute function public.trg_notify_channel_mention();

-- 4. Message privé
create or replace function public.trg_notify_dm()
returns trigger language plpgsql security definer set search_path = public as $$
declare srv uuid;
begin
  select server_id into srv from public.profiles where id = new.to_id;
  perform public.push_notification(srv, new.to_id, 'dm', 'Message de ' || public.actor_name(new.from_id), new.text, null, new.id, new.from_id);
  return new;
end $$;
drop trigger if exists trg_notify_dm on public.messages;
create trigger trg_notify_dm after insert on public.messages
  for each row execute function public.trg_notify_dm();

-- 5. Invitation à une réunion (une seule notification pour toute une série)
create or replace function public.trg_notify_meeting()
returns trigger language plpgsql security definer set search_path = public as $$
declare m record; ref uuid;
begin
  select id, server_id, title, starts_at, created_by, series_id into m from public.meetings where id = new.meeting_id;
  if not found or new.user_id = m.created_by then return new; end if;
  ref := coalesce(m.series_id, m.id);
  if exists (select 1 from public.notifications where user_id = new.user_id and kind = 'meeting' and ref_id = ref and read_at is null) then return new; end if;
  perform public.push_notification(m.server_id, new.user_id, 'meeting',
    public.actor_name(m.created_by) || ' vous invite : ' || m.title,
    case when m.series_id is null then to_char(m.starts_at at time zone 'Europe/Paris', 'DD/MM "à" HH24"h"MI') else 'Réunion récurrente, à partir du ' || to_char(m.starts_at at time zone 'Europe/Paris', 'DD/MM "à" HH24"h"MI') end,
    null, ref, m.created_by);
  return new;
end $$;
drop trigger if exists trg_notify_meeting on public.meeting_attendees;
create trigger trg_notify_meeting after insert on public.meeting_attendees
  for each row execute function public.trg_notify_meeting();

-- 6. Congés : demande (aux administrateurs) et décision (à la personne)
create or replace function public.trg_notify_leave()
returns trigger language plpgsql security definer set search_path = public as $$
declare a record; actor uuid := auth.uid();
begin
  if tg_op = 'INSERT' and new.status = 'pending' then
    for a in select id from public.profiles where server_id = new.server_id and role = 'admin' and status = 'approved' loop
      perform public.push_notification(new.server_id, a.id, 'leave_request', public.actor_name(new.user_id) || ' demande un congé', to_char(new.start_date, 'DD/MM') || ' → ' || to_char(new.end_date, 'DD/MM'), null, new.id, new.user_id);
    end loop;
  elsif tg_op = 'UPDATE' and old.status = 'pending' and new.status in ('approved', 'refused') then
    perform public.push_notification(new.server_id, new.user_id, 'leave_decision',
      case when new.status = 'approved' then 'Votre congé est accepté' else 'Votre congé est refusé' end,
      to_char(new.start_date, 'DD/MM') || ' → ' || to_char(new.end_date, 'DD/MM') || case when coalesce(new.admin_note, '') <> '' then ' · ' || new.admin_note else '' end,
      null, new.id, actor);
  end if;
  return new;
end $$;
drop trigger if exists trg_notify_leave on public.leave_requests;
create trigger trg_notify_leave after insert or update of status on public.leave_requests
  for each row execute function public.trg_notify_leave();

-- 7. Annonce de l'administrateur (si la migration 17 est faite)
do $$ begin
  if to_regclass('public.announcements') is not null then
    create or replace function public.trg_notify_announcement()
    returns trigger language plpgsql security definer set search_path = public as $f$
    declare p record;
    begin
      if not new.active then return new; end if;
      for p in select id from public.profiles where server_id = new.server_id and status = 'approved' loop
        perform public.push_notification(new.server_id, p.id, 'announcement', new.title, new.body, null, new.id, new.created_by);
      end loop;
      return new;
    end $f$;
    drop trigger if exists trg_notify_announcement on public.announcements;
    create trigger trg_notify_announcement after insert on public.announcements
      for each row execute function public.trg_notify_announcement();
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'notifications') then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;
