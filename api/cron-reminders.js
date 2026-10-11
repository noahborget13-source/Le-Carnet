// Fonction serveur Vercel appelée chaque matin par une tâche planifiée (cron).
// Envoie à chaque personne un récapitulatif de ses tâches en retard / pour aujourd'hui / demain.
import { createClient } from '@supabase/supabase-js';
import { esc, siteUrl, layout, button, sendMail, mailConfigured } from './_mail.js';

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const MAX_EMAILS_PER_RUN = 80; // reste sous les limites d'envoi de Gmail

const isoParis = (d) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(500).json({ error: 'CRON_SECRET manquant sur Vercel.' });
  if ((req.headers.authorization || '') !== `Bearer ${secret}`) return res.status(401).json({ error: 'Non autorisé' });
  if (!mailConfigured()) return res.status(200).json({ ok: true, sent: 0, reason: 'mail_not_configured' });

  try {
    const today = isoParis(new Date());
    const tomorrow = addDays(today, 1);
    const { data: tasks, error } = await supabaseAdmin.from('tasks').select('id, title, due, priority, assignee, reminded_for')
      .eq('done', false).not('assignee', 'is', null).gte('due', addDays(today, -7)).lte('due', tomorrow);
    if (error) throw error;

    const pending = (tasks || []).filter(t => t.reminded_for !== t.due);
    const byUser = new Map();
    for (const t of pending) { if (!byUser.has(t.assignee)) byUser.set(t.assignee, []); byUser.get(t.assignee).push(t); }

    const ids = [...byUser.keys()];
    if (!ids.length) return res.status(200).json({ ok: true, sent: 0 });
    const { data: people } = await supabaseAdmin.from('profiles').select('id, email, display_name, status').in('id', ids);

    const link = `${siteUrl(req)}/app/`;
    let sent = 0;
    for (const p of people || []) {
      if (sent >= MAX_EMAILS_PER_RUN) break;
      if (p.status !== 'approved') continue;
      const list = byUser.get(p.id).sort((a, b) => a.due.localeCompare(b.due) || b.priority - a.priority);
      const when = (due) => due < today ? 'En retard' : due === today ? "Aujourd'hui" : 'Demain';
      const color = (due) => due < today ? '#d6453a' : due === today ? '#d98a1c' : '#3d7bd9';
      const rows = list.map(t => `<li style="margin:6px 0"><strong>${esc(t.title)}</strong> <span style="color:${color(t.due)};font-size:12px;font-weight:bold">· ${when(t.due)}</span></li>`).join('');
      try {
        await sendMail({
          to: p.email,
          subject: list.length === 1 ? `Rappel : ${list[0].title}` : `Rappel : ${list.length} tâches à surveiller`,
          text: list.map(t => `- ${t.title} (${when(t.due)})`).join('\n') + `\n${link}`,
          html: layout(`<p>Bonjour ${esc(p.display_name)}, voici tes tâches proches de l'échéance :</p><ul style="padding-left:18px">${rows}</ul>${button(link, 'Ouvrir Le Carnet')}`),
        });
        sent++;
        for (const t of list) await supabaseAdmin.from('tasks').update({ reminded_for: t.due }).eq('id', t.id);
      } catch (_) { /* on passera à la personne suivante ; elle sera relancée demain */ }
    }
    return res.status(200).json({ ok: true, sent });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
}
