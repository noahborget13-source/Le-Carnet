// Fonction serveur Vercel — prévient par email la personne à qui une tâche vient d'être assignée.
import { createClient } from '@supabase/supabase-js';
import { esc, siteUrl, layout, button, sendMail, mailConfigured, dueText, wants, addDays, via } from './_mail.js';
import { parisInstant, dueStamp } from './_time.js';
import { loadBusy, loadTimedTasks, conflictReasons, reasonText, reasonsStamp } from './_availability.js';
import { warnBox } from './_meeting.js';

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
      .select('id, server_id, status, display_name, email, notify_conflicts').eq('id', userData.user.id).single();
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
      .select('id, email, display_name, status, server_id, notify_assigned, notify_conflicts, work_hours').in('id', ids);
    const members = (people || []).filter(p => p.status === 'approved' && p.server_id === caller.server_id);

    // Conflits d'horaire : congé, hors horaires, réunion déjà prévue, agenda externe occupé, autre tâche à la même heure.
    const conflicts = new Map();   // userId -> raisons
    if (task.due && members.length) {
      const allDay = !task.due_time;
      const fromMs = parisInstant(task.due, allDay ? '00:00:00' : task.due_time);
      const toMs = allDay ? parisInstant(addDays(task.due, 1), '00:00:00') : fromMs + 60000;
      const mids = members.map(p => p.id);
      const busy = await loadBusy(supabaseAdmin, mids, fromMs, toMs);
      const timed = allDay ? new Map() : await loadTimedTasks(supabaseAdmin, mids, task.due, task.due);
      for (const p of members) {
        const reasons = conflictReasons({ startMs: fromMs, endMs: allDay ? toMs : fromMs, user: p, busy: busy.get(p.id) || [], tasks: timed.get(p.id) || [], allDay, ignoreTaskId: task.id });
        if (reasons.length) conflicts.set(p.id, reasons);
      }
    }

    const link = `${siteUrl(req)}/app/`;
    const due = dueText(task);
    // On mémorise les conflits signalés : le passage automatique ne les répétera pas.
    if (conflicts.size && task.due_time) {
      const marks = [...conflicts].map(([uid, reasons]) => ({ kind: 'conflict_task', item_id: task.id, user_id: uid, stamp: `${dueStamp(task)}|${reasonsStamp(reasons)}`, sent_at: new Date().toISOString() }));
      try { await supabaseAdmin.from('event_notifications').upsert(marks, { onConflict: 'kind,item_id,user_id' }); } catch (_) {}
    }

    // L'auteur de l'assignation est prévenu si quelqu'un n'est pas disponible.
    let warned = 0;
    if (conflicts.size && caller.email && wants(caller, 'notify_conflicts')) {
      const lines = members.filter(p => conflicts.has(p.id)).map(p => conflicts.get(p.id).map(r => reasonText(r, p.display_name, 'name').replace(/^./, c => c.toUpperCase())).join(' ; '));
      try {
        await sendMail({
          to: caller.email, subject: `Conflit d'horaire : ${task.title}`,
          text: `La tâche « ${task.title} » (${due}) tombe à un moment où certains ne sont pas disponibles :\n- ${lines.join('\n- ')}`,
          html: layout(`<p>La tâche <strong>${esc(task.title)}</strong> (${esc(due)}) tombe à un moment où certaines personnes ne sont pas disponibles.</p>${warnBox(lines)}<p style="font-size:13px;color:#556">Les personnes concernées ont été prévenues. Tu peux changer l'échéance ou l'assigné depuis Le Carnet.</p>${button(link, 'Ouvrir Le Carnet')}`),
        });
        warned = 1;
      } catch (_) { /* on continue */ }
    }

    // On respecte le choix de chacun (Profil → Notifications).
    const targets = members.filter(p => wants(p, 'notify_assigned'));
    if (!targets.length) return res.status(200).json({ ok: true, sent: 0, conflicts: conflicts.size, warned });

    let sent = 0;
    for (const t of targets) {
      const mine = conflicts.get(t.id);
      const warn = mine && wants(t, 'notify_conflicts') ? warnBox(mine.map(r => reasonText(r, t.display_name, 'you').replace(/^./, c => c.toUpperCase()))) : '';
      const html = layout(`
        <p><strong>${esc(caller.display_name)}</strong> t'a assigné une tâche :</p>
        <div style="border-left:4px solid #5B9EF5;background:#f4f7fd;padding:12px 14px;border-radius:6px">
          <div style="font-size:16px;font-weight:bold">${esc(task.title)}</div>
          <div style="font-size:13px;color:#556;margin-top:4px">Priorité : ${esc(PRIO[task.priority] || 'Normale')}${due ? ` · Échéance : ${esc(due)}` : ''}</div>
          ${task.notes ? `<div style="font-size:13px;margin-top:8px">${esc(task.notes)}</div>` : ''}
        </div>${warn}${button(link, 'Ouvrir Le Carnet')}`);
      try {
        await sendMail({
          to: t.email, fromName: via(caller.display_name), ...(caller.email ? { replyTo: caller.email } : {}),
          subject: `Nouvelle tâche : ${task.title}`,
          text: `${caller.display_name} t'a assigné la tâche « ${task.title} ».${due ? ` Échéance : ${due}.` : ''}${mine ? ` Attention : ${mine.map(r => reasonText(r, t.display_name, 'you')).join(' ; ')}.` : ''}\n${link}`,
          html,
        });
        sent++;
      } catch (_) { /* on continue */ }
    }
    return res.status(200).json({ ok: true, sent, conflicts: conflicts.size, warned });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
}
