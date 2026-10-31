-- ============================================================
-- Le Carnet · migration 22 : statut de présence personnalisé
--   Chaque membre peut afficher un court message (« En déplacement », « Concentré jusqu'à 15 h »)
--   avec une icône et une fin facultative. Visible dans l'onglet Équipe.
--   La modification passe par l'API (comme le reste du profil). Sans danger si relancée.
-- ============================================================
alter table public.profiles add column if not exists status_text text;
alter table public.profiles add column if not exists status_emoji text;
alter table public.profiles add column if not exists status_until timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_status_text_len') then
    alter table public.profiles add constraint profiles_status_text_len check (status_text is null or char_length(status_text) <= 80);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_status_emoji_len') then
    alter table public.profiles add constraint profiles_status_emoji_len check (status_emoji is null or char_length(status_emoji) <= 8);
  end if;
end $$;
