// Fonction serveur Vercel — agenda externe (lien secret iCal de Google Agenda, Outlook ou Apple).
//   { action: 'connect', url }   → vérifie le lien, lit l'agenda, l'enregistre
//   { action: 'sync' }           → relit l'agenda tout de suite
//   { action: 'disconnect' }     → supprime le lien et les créneaux enregistrés
// Le lien secret n'est jamais renvoyé au navigateur ; les autres membres ne voient que « occupé / libre », jamais les titres.
import { createClient } from '@supabase/supabase-js';
import { normalizeIcsUrl, fetchIcs, busyForStorage } from './_ics.js';

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Non authentifié' });
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) return res.status(401).json({ error: 'Session invalide' });
    const { data: me } = await supabaseAdmin.from('profiles').select('id, status').eq('id', userData.user.id).single();
    if (!me || me.status !== 'approved') return res.status(403).json({ error: 'Accès refusé.' });

    const { action, url } = req.body || {};
    if (action === 'disconnect') {
      await supabaseAdmin.from('calendar_feeds').delete().eq('user_id', me.id);
      return res.status(200).json({ ok: true });
    }
    let icsUrl;
    if (action === 'connect') {
      const n = normalizeIcsUrl(url);
      if (n.error) return res.status(400).json({ error: n.error });
      icsUrl = n.url;
    } else if (action === 'sync') {
      const { data: feed } = await supabaseAdmin.from('calendar_feeds').select('ics_url').eq('user_id', me.id).single();
      if (!feed) return res.status(404).json({ error: "Aucun agenda n'est connecté." });
      icsUrl = feed.ics_url;
    } else return res.status(400).json({ error: 'Action inconnue' });

    let busy;
    try { busy = busyForStorage(await fetchIcs(icsUrl)); }
    catch (e) {
      if (action === 'sync') await supabaseAdmin.from('calendar_feeds').update({ last_error: e.message }).eq('user_id', me.id);
      return res.status(400).json({ error: e.message || 'Lecture impossible.' });
    }
    const row = { user_id: me.id, ics_url: icsUrl, busy, last_sync: new Date().toISOString(), last_error: null };
    const { error } = await supabaseAdmin.from('calendar_feeds').upsert(row, { onConflict: 'user_id' });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, slots: busy.length });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
}
