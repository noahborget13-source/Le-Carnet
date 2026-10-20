// Fonction serveur Vercel — prévient par email la personne à qui une tâche vient d'être assignée.
import { createClient } from '@supabase/supabase-js';
import { esc, siteUrl, layout, button, sendMail, mailConfigured, dueText, wants } from './_mail.js';

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const PRIO = { 3: 'Urgente', 2: 'Normale', 1: 'Basse' };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Non authentifié' });
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) return res.status(401).json({ error: 'Session invalide' });

    const { data: caller } = await supabaseAdmin.from('profiles')
      .select('id, server_id, status, display_name').eq('id', userData.user.id).single();
    if (!caller || caller.status !== 'approved') return res.status(403).json({ error: 'Accès refusé.' });

    const { taskId } = req.body || {};
    const { data: task } = await supabaseAdmin.from('tasks').select('*').eq('id', taskId).single();
    if (!task || task.server_id !== caller.server_id) return res.status(404).json({ error: 'Tâche introuvable.' });

    if (task.done || !mailConfigured()) return res.status(200).json({ ok: true, sent: 0 });

    // Destinataires : les personnes demandées (ou tous les assignés), sauf soi-même.
    const assigned = (task.assignees && task.assignees.length ? task.assignees : (task.assignee ? [task.assignee] : []));
    const asked = Array.isArray((req.body || {}).userIds) ? req.body.userIds : assigned;
    const ids = assigned.filter(x => asked.includes(x) && x !== caller.id).slice(0, 10);
    if (!ids.length) return res.status(200).json({ ok: true, sent: 0 });

    const { data: people } = await supabaseAdmin.from('profiles')
      .select('id, email, display_name, status, server_id, notify_assigned').in('id', ids);
    // On respecte le choix de chacun (Profil → Notifications).
    const targets = (people || []).filter(p => p.status === 'approved' && p.server_id === caller.server_id && wants(p, 'notify_assigned'));
    if (!targets.length) return res.status(200).json({ ok: true, sent: 0 });

    const link = `${siteUrl(req)}/app/`;
    const due = dueText(task);
    const html = layout(`
      <p><strong>${esc(caller.display_name)}</strong> t'a assigné une tâche :</p>
      <div style="border-left:4px solid #5B9EF5;background:#f4f7fd;padding:12px 14px;border-radius:6px">
        <div style="font-size:16px;font-weight:bold">${esc(task.title)}</div>
        <div style="font-size:13px;color:#556;margin-top:4px">Priorité : ${esc(PRIO[task.priority] || 'Normale')}${due ? ` · Échéance : ${esc(due)}` : ''}</div>
        ${task.notes ? `<div style="font-size:13px;margin-top:8px">${esc(task.notes)}</div>` : ''}
      </div>${button(link, 'Ouvrir Le Carnet')}`);
    let sent = 0;
    for (const t of targets) {
      try {
        await sendMail({
          to: t.email,
          subject: `Nouvelle tâche : ${task.title}`,
          text: `${caller.display_name} t'a assigné la tâche « ${task.title} ».${due ? ` Échéance : ${due}.` : ''}\n${link}`,
          html,
        });
        sent++;
      } catch (_) { /* on continue */ }
    }
    return res.status(200).json({ ok: true, sent });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
}
