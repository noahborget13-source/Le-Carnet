// Fonction serveur Vercel — emails des congés.
//   { action: 'request', id }   → prévient l'administrateur d'une nouvelle demande (appelé par la personne qui demande)
//   { action: 'decision', id }  → prévient la personne que son congé est accepté / refusé (ou posé par l'administrateur)
import { createClient } from '@supabase/supabase-js';
import { esc, siteUrl, layout, button, sendMail, mailConfigured, addDays } from './_mail.js';

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const fmt = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const period = (l) => (l.start_date === l.end_date ? `le ${fmt(l.start_date)}` : `du ${fmt(l.start_date)} au ${fmt(l.end_date)}`);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Non authentifié' });
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) return res.status(401).json({ error: 'Session invalide' });
    const { data: caller } = await supabaseAdmin.from('profiles').select('id, server_id, status, role, display_name').eq('id', userData.user.id).single();
    if (!caller || caller.status !== 'approved') return res.status(403).json({ error: 'Accès refusé.' });

    const { action, id } = req.body || {};
    const { data: leave } = await supabaseAdmin.from('leave_requests').select('*').eq('id', id).single();
    if (!leave || leave.server_id !== caller.server_id) return res.status(404).json({ error: 'Demande introuvable.' });
    if (!mailConfigured()) return res.status(200).json({ ok: true, sent: 0 });
    const site = siteUrl(req);

    if (action === 'request') {
      if (leave.user_id !== caller.id || leave.status !== 'pending') return res.status(403).json({ error: 'Accès refusé.' });
      const { data: admins } = await supabaseAdmin.from('profiles').select('email, display_name').eq('server_id', caller.server_id).eq('role', 'admin').eq('status', 'approved');
      let sent = 0;
      for (const a of admins || []) {
        if (!a.email) continue;
        try {
          await sendMail({
            to: a.email, subject: `Demande de congé : ${caller.display_name}`,
            text: `${caller.display_name} demande un congé ${period(leave)}.${leave.reason ? ' Motif : ' + leave.reason : ''}\n${site}/app/`,
            html: layout(`<p><strong>${esc(caller.display_name)}</strong> demande un congé :</p>
              <div style="border-left:4px solid #E8A33D;background:#fff9ee;padding:12px 14px;border-radius:6px"><div style="font-size:16px;font-weight:bold">${esc(period(leave))}</div>${leave.reason ? `<div style="font-size:13px;margin-top:6px">${esc(leave.reason)}</div>` : ''}</div>
              <p style="font-size:13px;color:#556">Tu peux accepter ou refuser dans Le Carnet → Admin → Congés.</p>${button(`${site}/app/`, 'Ouvrir Le Carnet')}`),
          });
          sent++;
        } catch (_) { /* on continue */ }
      }
      return res.status(200).json({ ok: true, sent });
    }

    if (action === 'decision') {
      if (caller.role !== 'admin' || leave.status === 'pending') return res.status(403).json({ error: "Réservé à l'administrateur, après décision." });
      if (leave.user_id === caller.id) return res.status(200).json({ ok: true, sent: 0 });
      const { data: person } = await supabaseAdmin.from('profiles').select('email, display_name').eq('id', leave.user_id).single();
      if (!person || !person.email) return res.status(200).json({ ok: true, sent: 0 });
      const approved = leave.status === 'approved';
      const direct = approved && !leave.decided_by;       // posé directement par l'administrateur
      const color = approved ? '#2F9E6B' : '#D6453A';
      const title = direct ? 'Un congé a été posé pour toi' : approved ? 'Ton congé est accepté' : 'Ta demande de congé est refusée';
      await sendMail({
        to: person.email, subject: `${approved ? '✅' : '❌'} ${title}`,
        text: `${title} : ${period(leave)}.${leave.admin_note ? ' Message : ' + leave.admin_note : ''}`,
        html: layout(`<p>Bonjour ${esc(person.display_name)},</p><p>${esc(title)} :</p>
          <div style="border-left:4px solid ${color};padding:12px 14px;border-radius:6px;background:#f6f8fa"><div style="font-size:16px;font-weight:bold">${esc(period(leave))}</div>${leave.admin_note ? `<div style="font-size:13px;margin-top:6px">${esc(leave.admin_note)}</div>` : ''}</div>
          ${approved ? '<p style="font-size:13px;color:#556">Pendant ce congé, tu ne recevras pas de rappels par email et les autres verront que tu es absent(e).</p>' : ''}${button(`${site}/app/`, 'Ouvrir Le Carnet')}`),
      });
      return res.status(200).json({ ok: true, sent: 1 });
    }
    return res.status(400).json({ error: 'Action inconnue' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
}
