// Fonction serveur Vercel — prévient par email le destinataire d'un message privé.
// Pas plus d'un email toutes les 30 minutes par expéditeur et par destinataire (une conversation active ne spamme pas).
import { createClient } from '@supabase/supabase-js';
import { esc, siteUrl, layout, button, sendMail, mailConfigured, via, wants } from './_mail.js';

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const QUIET_MS = 30 * 60000;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Non authentifié' });
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) return res.status(401).json({ error: 'Session invalide' });
    const { data: caller } = await supabaseAdmin.from('profiles').select('id, server_id, status, display_name, email').eq('id', userData.user.id).single();
    if (!caller || caller.status !== 'approved') return res.status(403).json({ error: 'Accès refusé.' });

    const { messageId } = req.body || {};
    const { data: msg } = await supabaseAdmin.from('messages').select('id, from_id, to_id, text, ts').eq('id', messageId).single();
    if (!msg || msg.from_id !== caller.id) return res.status(404).json({ error: 'Message introuvable.' });
    if (!mailConfigured()) return res.status(200).json({ ok: true, sent: 0 });

    const { data: to } = await supabaseAdmin.from('profiles').select('id, email, display_name, status, server_id, notify_dm').eq('id', msg.to_id).single();
    if (!to || to.status !== 'approved' || to.server_id !== caller.server_id || !to.email || !wants(to, 'notify_dm')) return res.status(200).json({ ok: true, sent: 0 });

    const { data: last } = await supabaseAdmin.from('event_notifications').select('sent_at').eq('kind', 'dm').eq('item_id', caller.id).eq('user_id', to.id).maybeSingle();
    if (last && Date.now() - Date.parse(last.sent_at) < QUIET_MS) return res.status(200).json({ ok: true, sent: 0, throttled: true });

    const link = `${siteUrl(req)}/app/`;
    const excerpt = msg.text.length > 300 ? msg.text.slice(0, 300) + '…' : msg.text;
    try {
      await sendMail({
        to: to.email, fromName: via(caller.display_name), ...(caller.email ? { replyTo: caller.email } : {}),
        subject: `Message de ${caller.display_name}`,
        text: `${caller.display_name} t'a écrit dans Le Carnet :\n${excerpt}\n${link}`,
        html: layout(`<p><strong>${esc(caller.display_name)}</strong> t'a écrit :</p><div style="border-left:4px solid #5B9EF5;background:#f4f7fd;padding:12px 14px;border-radius:6px;white-space:pre-wrap">${esc(excerpt)}</div>${button(link, 'Répondre dans Le Carnet')}<p style="font-size:12px;color:#889">Tu ne recevras pas d'autre email de ${esc(caller.display_name)} avant 30 minutes. Tu peux désactiver ces emails dans Profil → Notifications.</p>`),
      });
    } catch (_) { return res.status(200).json({ ok: true, sent: 0 }); }
    await supabaseAdmin.from('event_notifications').upsert({ kind: 'dm', item_id: caller.id, user_id: to.id, stamp: msg.id, sent_at: new Date().toISOString() }, { onConflict: 'kind,item_id,user_id' });
    return res.status(200).json({ ok: true, sent: 1 });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
}
