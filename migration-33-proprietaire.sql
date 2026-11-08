-- ============================================================
-- Le Carnet · migration 33 : mention publique du propriétaire
--   Rend lisible par tous (visiteurs compris) la seule ligne « ownership » de platform_settings
--   (nom et date de la remise du Carnet à Camélia Borget). Les autres réglages restent réservés au Supra Admin.
--   Les écritures passent uniquement par le serveur (clé de service). Sans danger si relancée.
-- ============================================================
drop policy if exists "réglages plateforme: propriétaire public" on public.platform_settings;
create policy "réglages plateforme: propriétaire public" on public.platform_settings for select to anon, authenticated using (key = 'ownership');
