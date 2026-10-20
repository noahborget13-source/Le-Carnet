// Fonction serveur Vercel — rappels par email. À appeler régulièrement (toutes les 10 minutes) :
//   GET /api/cron-reminders?mode=tick   → rappels « il reste peu de temps » et « en retard », + récap du matin à 7 h
//   GET /api/cron-reminders             → idem + nettoyage quotidien (corbeille > 30 j, journal > 90 j)
// Vercel (offre gratuite) ne sait lancer qu'une tâche par jour : l'appel toutes les 10 minutes est fait par Supabase
// (voir planifier-rappels.sql). Le passage quotidien de Vercel reste utile comme filet de sécurité.
import { createClient } from '@supabase/supabase-js';
import { esc, siteUrl, layout, button, sendMail, mailConfigured, dueText, hhmm, parisToday, addDays } from './_mail.js';
import { planReminders, minutesLabel, assigneesOf } from './_reminders.js';

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const MAX_EMAILS_PER_RUN = 40; // reste sous les limites de Gmail ; le reste part au passage suivant

async function cleanup() {
  const trashCutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  const { data: old } = await supabaseAdmin.from('tasks').select('id').lt('deleted_at', trashCutoff).limit(200);
  if (old && old.length) {
    const ids = old.map(t => t.id);
    const { data: atts } = await supabaseAdmin.from('task_attachments').select('path').in('task_id', ids);
    if (atts && atts.length) await supabaseAdmin.storage.from('task-files').remove(atts.map(a => a.path));
    await supabaseAdmin.from('tasks').delete().in('id', ids);
  }
  const logCutoff = new Date(Date.now() - 90 * 86400000).toISOString();
  await supabaseAdmin.from('activity').delete().lt('created_at', logCutoff);
  await supabaseAdmin.from('cron_runs').delete().lt('ran_at', new Date(Date.now() - 30 * 86400000).toISOString());
  return old ? old.length : 0;
}

const row = (t, extra, color) =>
  `<li style="margin:7px 0"><strong>${esc(t.title)}</strong><br><span style="font-size:12.5px;color:${color}">${esc(extra)}</span></li>`;
const footnote = '<p style="font-size:12px;color:#889;margin-top:18px">Tu choisis les emails que tu reçois dans Le Carnet → Profil → Notifications.</p>';

function buildMail(kind, person, items, link) {
  const hello = `<p>Bonjour ${esc(person.display_name)},</p>`;
  if (kind === 'soon') {
    const sorted = [...items].sort((a, b) => a.minutesLeft - b.minutesLeft);
    const lines = sorted.map(i => row(i.task, `${dueText(i.task)} · dans ${minutesLabel(i.minutesLeft)}`, '#c76d00')).join('');
    return {
      subject: sorted.length === 1 ? `⏰ Plus que ${minutesLabel(sorted[0].minutesLeft)} : ${sorted[0].task.title}` : `⏰ ${sorted.length} tâches arrivent à échéance`,
      text: sorted.map(i => `- ${i.task.title} — ${dueText(i.task)} (dans ${minutesLabel(i.minutesLeft)})`).join('\n') + `\n${link}`,
      html: layout(`${hello}<p>${sorted.length === 1 ? 'Il te reste peu de temps pour cette tâche :' : 'Il te reste peu de temps pour ces tâches :'}</p><ul style="padding-left:18px">${lines}</ul>${button(link, 'Ouvrir Le Carnet')}${footnote}`),
    };
  }
  if (kind === 'overdue') {
    const lines = items.map(i => row(i.task, `Échéance dépassée : ${dueText(i.task)}`, '#d6453a')).join('');
    return {
      subject: items.length === 1 ? `⚠️ En retard : ${items[0].task.title}` : `⚠️ ${items.length} tâches en retard`,
      text: items.map(i => `- ${i.task.title} — ${dueText(i.task)}`).join('\n') + `\n${link}`,
      html: layout(`${hello}<p>${items.length === 1 ? 'Cette tâche a dépassé son échéance :' : 'Ces tâches ont dépassé leur échéance :'}</p><ul style="padding-left:18px">${lines}</ul>${button(link, 'Ouvrir Le Carnet')}${footnote}`),
    };
  }
  // digest
  const byWhen = (w) => items.filter(i => i.when === w).sort((a, b) => (a.task.due_time || '99').localeCompare(b.task.due_time || '99'));
  const today = byWhen('today'), tomorrow = byWhen('tomorrow');
  const sec = (title, list, color) => list.length ? `<p style="margin:16px 0 4px;font-weight:bold">${title}</p><ul style="padding-left:18px;margin:0">${list.map(i => row(i.task, i.task.due_time ? `à ${hhmm(i.task.due_time)}` : 'toute la journée', color)).join('')}</ul>` : '';
  const txt = (title, list) => list.length ? `${title}\n${list.map(i => `- ${i.task.title}${i.task.due_time ? ' (' + hhmm(i.task.due_time) + ')' : ''}`).join('\n')}\n` : '';
  return {
    subject: today.length ? `Aujourd'hui : ${today.length} tâche${today.length > 1 ? 's' : ''} à faire` : `Demain : ${tomorrow.length} tâche${tomorrow.length > 1 ? 's' : ''} à prévoir`,
    text: txt("Aujourd'hui", today) + txt('Demain', tomorrow) + link,
    html: layout(`${hello}<p>Voici ce qui t'attend :</p>${sec("Aujourd'hui", today, '#c76d00')}${sec('Demain', tomorrow, '#3d7bd9')}${button(link, 'Ouvrir Le Carnet')}${footnote}`),
  };
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(500).json({ error: 'CRON_SECRET manquant sur Vercel.' });
  if ((req.headers.authorization || '') !== `Bearer ${secret}`) return res.status(401).json({ error: 'Non autorisé' });

  const mode = (req.query && req.query.mode) === 'tick' ? 'tick' : 'full';
  let sent = 0, purged = 0;
  const finish = async (extra = {}) => {
    try { await supabaseAdmin.from('cron_runs').insert({ mode, sent }); } catch (_) { /* le journal ne doit jamais bloquer */ }
    return res.status(200).json({ ok: true, mode, sent, purged, ...extra });
  };

  try {
    if (mode === 'full') { try { purged = await cleanup(); } catch (_) { /* ne bloque pas les rappels */ } }
    if (!mailConfigured()) return await finish({ reason: 'mail_not_configured' });

    const today = parisToday();
    const { data: tasks, error } = await supabaseAdmin.from('tasks')
      .select('id, title, due, due_time, priority, assignee, assignees, created_at, done, deleted_at')
      .eq('done', false).is('deleted_at', null).not('due', 'is', null)
      .gte('due', addDays(today, -4)).lte('due', addDays(today, 1));
    if (error) throw error;
    const open = (tasks || []).filter(t => assigneesOf(t).length);
    if (!open.length) return await finish();

    const userIds = [...new Set(open.flatMap(assigneesOf))];
    const { data: people } = await supabaseAdmin.from('profiles')
      .select('id, email, display_name, status, notify_assigned, notify_soon, notify_overdue, notify_digest, remind_lead_minutes').in('id', userIds);
    const profiles = new Map((people || []).map(p => [p.id, p]));
    const { data: notifs } = await supabaseAdmin.from('task_notifications').select('task_id, user_id, kind, stamp').in('task_id', open.map(t => t.id));
    const sentMap = new Map((notifs || []).map(n => [`${n.task_id}|${n.user_id}|${n.kind}`, n.stamp]));

    const plan = planReminders({ tasks: open, profiles, sent: sentMap, now: Date.now() });
    const link = `${siteUrl(req)}/app/`;
    const marks = [];
    outer:
    for (const kind of ['soon', 'overdue', 'digest']) {
      for (const [uid, items] of plan[kind]) {
        if (sent >= MAX_EMAILS_PER_RUN) break outer;
        const person = profiles.get(uid);
        if (!person || !person.email) continue;
        try {
          await sendMail({ to: person.email, ...buildMail(kind, person, items, link) });
          sent++;
          for (const i of items) marks.push({ task_id: i.task.id, user_id: uid, kind, stamp: i.stamp, sent_at: new Date().toISOString() });
        } catch (_) { /* non marqué : on réessaiera au prochain passage */ }
      }
    }
    if (marks.length) await supabaseAdmin.from('task_notifications').upsert(marks, { onConflict: 'task_id,user_id,kind' });
    return await finish();
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
}
