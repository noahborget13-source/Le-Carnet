// Fonction serveur Vercel — prévient par email la personne à qui une tâche vient d'être assignée.
import { createClient } from '@supabase/supabase-js';
import { esc, siteUrl, layout, button, sendMail, mailConfigured } from './_mail.js';

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

    // Rien à envoyer : pas d'assigné, tâche à soi-même ou déjà terminée.
    if (!task.assignee || task.assignee === caller.id || task.done) return res.status(200).json({ ok: true, sent: false });
    if (!mailConfigured()) return res.status(200).json({ ok: true, sent: false, reason: 'mail_not_configured' });

    const { data: target } = await supabaseAdmin.from('profiles')
      .select('email, display_name, status, server_id').eq('id', task.assignee).single();
    if (!target || target.status !== 'approved' || target.server_id !== caller.server_id) return res.status(200).json({ ok: true, sent: false });

    const link = `${siteUrl(req)}/app/`;
    const due = task.due ? new Date(task.due + 'T00:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }) : null;
    const html = layout(`
      <p><strong>${esc(caller.display_name)}</strong> t'a assigné une tâche :</p>
      <div style="border-left:4px solid #5B9EF5;background:#f4f7fd;padding:12px 14px;border-radius:6px">
        <div style="font-size:16px;font-weight:bold">${esc(task.title)}</div>
        <div style="font-size:13px;color:#556;margin-top:4px">Priorité : ${esc(PRIO[task.priority] || 'Normale')}${due ? ` · Échéance : ${esc(due)}` : ''}</div>
        ${task.notes ? `<div style="font-size:13px;margin-top:8px">${esc(task.notes)}</div>` : ''}
      </div>${button(link, 'Ouvrir Le Carnet')}`);
    await sendMail({
      to: target.email,
      subject: `Nouvelle tâche : ${task.title}`,
      text: `${caller.display_name} t'a assigné la tâche « ${task.title} ».${due ? ` Échéance : ${due}.` : ''}\n${link}`,
      html,
    });
    return res.status(200).json({ ok: true, sent: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
}
