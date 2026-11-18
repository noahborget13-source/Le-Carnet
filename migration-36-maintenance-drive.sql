-- Migration 36 : la maintenance peut aussi s'appliquer au Drive (le-carnet-drive.vercel.app)
-- Le propriétaire choisit, maintenance par maintenance, si le Drive est concerné (désactivé par défaut :
-- les maintenances existantes et celles créées sans cocher la case ne touchent pas le Drive).

alter table public.system_alerts
  add column if not exists applies_to_drive boolean not null default false;

-- Maintenance active concernant le Drive (même logique que maintenance_active, heure de Supabase)
create or replace view public.drive_maintenance_active
with (security_invoker = true) as
  select id, message, maint_end
  from public.system_alerts
  where is_maintenance
    and applies_to_drive
    and (maint_start is null or maint_start <= now())
    and (maint_end is null or maint_end > now());
