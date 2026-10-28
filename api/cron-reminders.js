// Fonction serveur Vercel — rappels par email. À appeler régulièrement (toutes les 10 minutes) :
//   GET /api/cron-reminders?mode=tick   → rappels « il reste peu de temps » et « en retard », + récap du matin à 7 h
//   GET /api/cron-reminders             → idem + nettoyage quotidien (corbeille > 30 j, journal > 90 j)
// Vercel (offre gratuite) ne sait lancer qu'une tâche par jour : l'appel toutes les 10 minutes est fait par Supabase
// (voir planifier-rappels.sql). Le passage quotidien de Vercel reste utile comme filet de sécurité.
import { createClient } from '@supabase/supabase-js';
import { esc, siteUrl, layout, button, sendMail, mailConfigured, dueText, hhmm, parisToday, addDays, wants, dueStamp } from './_mail.js';
import { parisHour } from './_time.js';
import { fetchIcs, busyForStorage } from './_ics.js';
import { loadBusy, loadTimedTasks, conflictReasons, reasonText, reasonsStamp, nameMap } from './_availability.js';
import { meetingLink, whenText, warnBox } from './_meeting.js';
import { planReminders, minutesLabel, assigneesOf, DIGEST_FROM_HOUR, DIGEST_UNTIL_HOUR } from './_reminders.js';
import { buildWeeklyMail, mondayOf, isoWeekday } from './_weekly.js';
import { parisInstant as parisInstantSafe } from './_time.js';

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
const footnote = '<p style="font-size:12px;color:#889;margin-top:18px">Vous choisissez les emails que vous recevez dans Le Carnet → Profil → Notifications.</p>';

function buildMail(kind, person, items, link) {
  const hello = `<p>Bonjour ${esc(person.display_name)},</p>`;
  if (kind === 'soon') {
    const sorted = [...items].sort((a, b) => a.minutesLeft - b.minutesLeft);
    const lines = sorted.map(i => row(i.task, `${dueText(i.task)} · dans ${minutesLabel(i.minutesLeft)}`, '#c76d00')).join('');
    return {
      subject: sorted.length === 1 ? `⏰ Plus que ${minutesLabel(sorted[0].minutesLeft)} : ${sorted[0].task.title}` : `⏰ ${sorted.length} tâches arrivent à échéance`,
      text: sorted.map(i => `- ${i.task.title} — ${dueText(i.task)} (dans ${minutesLabel(i.minutesLeft)})`).join('\n') + `\n${link}`,
      html: layout(`${hello}<p>${sorted.length === 1 ? 'Il vous reste peu de temps pour cette tâche :' : 'Il vous reste peu de temps pour ces tâches :'}</p><ul style="padding-left:18px">${lines}</ul>${button(link, 'Ouvrir Le Carnet')}${footnote}`),
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
    html: layout(`${hello}<p>Voici ce qui vous attend :</p>${sec("Aujourd'hui", today, '#c76d00')}${sec('Demain', tomorrow, '#3d7bd9')}${button(link, 'Ouvrir Le Carnet')}${footnote}`),
  };
}


// ------------------------------------------------------------------
// Rappels de tâches : échéance proche, retard, récapitulatif du matin (suspendus pendant un congé accepté)
// ------------------------------------------------------------------
async function taskReminders(link, room, skipDigest = new Set()) {
  const today = parisToday();
  const { data: tasks, error } = await supabaseAdmin.from('tasks')
    .select('id, title, due, due_time, priority, assignee, assignees, created_at, done, deleted_at')
    .eq('done', false).is('deleted_at', null).not('due', 'is', null)
    .gte('due', addDays(today, -4)).lte('due', addDays(today, 1));
  if (error) throw error;
  const open = (tasks || []).filter(t => assigneesOf(t).length);
  if (!open.length) return 0;

  const userIds = [...new Set(open.flatMap(assigneesOf))];
  const { data: people } = await supabaseAdmin.from('profiles')
    .select('id, email, display_name, status, notify_assigned, notify_soon, notify_overdue, notify_digest, remind_lead_minutes').in('id', userIds);
  const profiles = new Map((people || []).map(p => [p.id, p]));
  // Congé accepté aujourd'hui : aucun rappel (ni échéance proche, ni retard, ni récapitulatif)
  const { data: leaves } = await supabaseAdmin.from('leave_requests').select('user_id').in('user_id', userIds).eq('status', 'approved').lte('start_date', today).gte('end_date', today);
  for (const l of leaves || []) { const p = profiles.get(l.user_id); if (p) p.onLeave = true; }
  const { data: notifs } = await supabaseAdmin.from('task_notifications').select('task_id, user_id, kind, stamp').in('task_id', open.map(t => t.id));
  const sentMap = new Map((notifs || []).map(n => [`${n.task_id}|${n.user_id}|${n.kind}`, n.stamp]));

  const plan = planReminders({ tasks: open, profiles, sent: sentMap, now: Date.now() });
  for (const uid of skipDigest) plan.digest.delete(uid);   // le lundi, le résumé de la semaine remplace le récap du jour
  const marks = [];
  let sent = 0;
  outer:
  for (const kind of ['soon', 'overdue', 'digest']) {
    for (const [uid, items] of plan[kind]) {
      if (sent >= room) break outer;
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
  return sent;
}

// ------------------------------------------------------------------
// Agendas externes : relecture au plus toutes les ~25 minutes (15 agendas par passage au maximum)
// ------------------------------------------------------------------
async function syncFeeds() {
  const stale = Date.now() - 25 * 60000;
  const { data: feeds } = await supabaseAdmin.from('calendar_feeds').select('user_id, ics_url, last_sync').limit(300);
  const due = (feeds || []).filter(f => !f.last_sync || Date.parse(f.last_sync) < stale)
    .sort((a, b) => (Date.parse(a.last_sync || 0) || 0) - (Date.parse(b.last_sync || 0) || 0)).slice(0, 15);
  let ok = 0;
  for (let i = 0; i < due.length; i += 5) {
    await Promise.all(due.slice(i, i + 5).map(async (f) => {
      try {
        const busy = busyForStorage(await fetchIcs(f.ics_url));
        await supabaseAdmin.from('calendar_feeds').update({ busy, last_sync: new Date().toISOString(), last_error: null }).eq('user_id', f.user_id);
        ok++;
      } catch (e) {
        await supabaseAdmin.from('calendar_feeds').update({ last_sync: new Date().toISOString(), last_error: String(e.message || e).slice(0, 200) }).eq('user_id', f.user_id);
      }
    }));
  }
  return ok;
}

const notifKey = (kind, item, user) => `${kind}|${item}|${user}`;
async function loadNotifs(kinds, itemIds) {
  if (!itemIds.length) return new Map();
  const { data } = await supabaseAdmin.from('event_notifications').select('kind, item_id, user_id, stamp').in('item_id', itemIds);
  return new Map((data || []).filter(n => kinds.includes(n.kind)).map(n => [notifKey(n.kind, n.item_id, n.user_id), n.stamp]));
}

// ------------------------------------------------------------------
// Rappel de réunion : 15 minutes avant (une seule fois par horaire)
// ------------------------------------------------------------------
async function meetingReminders(room, link) {
  const now = Date.now();
  const { data: meetings } = await supabaseAdmin.from('meetings').select('*')
    .gte('starts_at', new Date(now).toISOString()).lte('starts_at', new Date(now + 15 * 60000).toISOString());
  if (!meetings || !meetings.length) return 0;
  const { data: atts } = await supabaseAdmin.from('meeting_attendees').select('meeting_id, user_id, response').in('meeting_id', meetings.map(m => m.id));
  const uids = [...new Set((atts || []).map(a => a.user_id))];
  const { data: people } = await supabaseAdmin.from('profiles').select('id, email, display_name, status, notify_meetings').in('id', uids);
  const profiles = new Map((people || []).map(p => [p.id, p]));
  const sentMap = await loadNotifs(['meeting_remind'], meetings.map(m => m.id));
  let sent = 0; const marks = [];
  for (const m of meetings) {
    for (const a of (atts || []).filter(x => x.meeting_id === m.id && x.response !== 'declined')) {
      if (sent >= room) break;
      const p = profiles.get(a.user_id);
      if (!p || p.status !== 'approved' || !p.email || !wants(p, 'notify_meetings')) continue;
      if (sentMap.get(notifKey('meeting_remind', m.id, p.id)) === m.starts_at) continue;
      const min = Math.max(1, Math.round((Date.parse(m.starts_at) - now) / 60000));
      try {
        await sendMail({
          to: p.email, subject: `⏰ Réunion dans ${min} min : ${m.title}`,
          text: `« ${m.title} » commence dans ${min} minutes (${whenText(m)}).\nAppel vidéo : ${meetingLink(m)}`,
          html: layout(`<p>Bonjour ${esc(p.display_name)},</p><p>La réunion <strong>${esc(m.title)}</strong> commence dans <strong>${min} min</strong> (${esc(whenText(m))}).</p>${button(meetingLink(m), "Rejoindre l'appel vidéo")}<p style="font-size:12px;color:#889">Vous choisissez les emails que vous recevez dans Le Carnet → Profil → Notifications.</p>`),
        });
        sent++; marks.push({ kind: 'meeting_remind', item_id: m.id, user_id: p.id, stamp: m.starts_at, sent_at: new Date().toISOString() });
      } catch (_) { /* on réessaiera au prochain passage */ }
    }
  }
  if (marks.length) await supabaseAdmin.from('event_notifications').upsert(marks, { onConflict: 'kind,item_id,user_id' });
  return sent;
}

// ------------------------------------------------------------------
// Résumé du lundi : tâches, réunions, absences, événements et anniversaires de la semaine (un seul email par personne et par semaine)
// ------------------------------------------------------------------
async function weeklySummary(room, link) {
  const now = Date.now(), today = parisToday(now), hour = parisHour(now);
  const covered = new Set();
  if (isoWeekday(today) !== 1 || hour < DIGEST_FROM_HOUR || hour >= DIGEST_UNTIL_HOUR) return { sent: 0, covered };
  const monday = mondayOf(today), sunday = addDays(monday, 6);
  const { data: all } = await supabaseAdmin.from('profiles').select('id, email, display_name, status, server_id, birthday, notify_weekly').eq('status', 'approved');
  const members = all || [];
  const targets = members.filter(p => p.email && wants(p, 'notify_weekly'));
  if (!targets.length) return { sent: 0, covered };
  const ids = targets.map(p => p.id);
  const { data: done } = await supabaseAdmin.from('event_notifications').select('user_id, stamp').eq('kind', 'weekly').in('user_id', ids);
  const already = new Set((done || []).filter(d => d.stamp === monday).map(d => d.user_id));
  for (const id of already) covered.add(id);
  const todo = targets.filter(p => !already.has(p.id));
  if (!todo.length) return { sent: 0, covered };

  const { data: tasks } = await supabaseAdmin.from('tasks').select('id, title, due, due_time, assignee, assignees, done, deleted_at')
    .eq('done', false).is('deleted_at', null).not('due', 'is', null).lte('due', sunday);
  const { data: leaves } = await supabaseAdmin.from('leave_requests').select('user_id, server_id, start_date, end_date').eq('status', 'approved').lte('start_date', sunday).gte('end_date', monday);
  const { data: events } = await supabaseAdmin.from('team_events').select('server_id, title, start_date, end_date').lte('start_date', sunday).gte('end_date', monday);
  const weekStart = new Date(parisInstantSafe(monday, '00:00:00')).toISOString(), weekEnd = new Date(parisInstantSafe(addDays(sunday, 1), '00:00:00')).toISOString();
  const { data: meetings } = await supabaseAdmin.from('meetings').select('id, server_id, title, starts_at, ends_at').lt('starts_at', weekEnd).gt('ends_at', weekStart);
  const { data: atts } = meetings && meetings.length ? await supabaseAdmin.from('meeting_attendees').select('meeting_id, user_id, response').in('meeting_id', meetings.map(m => m.id)) : { data: [] };
  const prevStart = new Date(parisInstantSafe(addDays(monday, -7), '00:00:00')).toISOString();
  const { data: doneLast } = await supabaseAdmin.from('tasks').select('assignee, assignees').eq('done', true).is('deleted_at', null).gte('done_at', prevStart).lt('done_at', weekStart);
  const nameOf = new Map(members.map(p => [p.id, p.display_name]));
  const marks = []; let sent = 0;
  for (const p of todo) {
    if (sent >= room) break;
    const mine = (tasks || []).filter(t => assigneesOf(t).includes(p.id));
    const myLeave = (leaves || []).filter(l => l.user_id === p.id);
    // en congé toute la semaine ouvrée : pas de résumé
    const out = new Set(); for (const l of myLeave) for (let i = 0; i < 5; i++) { const d = addDays(monday, i); if (l.start_date <= d && l.end_date >= d) out.add(d); }
    if (out.size >= 5) { covered.add(p.id); continue; }
    const myMeetingIds = new Set((atts || []).filter(a => a.user_id === p.id && a.response !== 'declined').map(a => a.meeting_id));
    const bdays = members.filter(m => m.server_id === p.server_id && m.birthday).map(m => { for (let i = 0; i < 7; i++) { const d = addDays(monday, i); if (d.slice(5) === m.birthday) return { name: m.id === p.id ? 'vous' : m.display_name, day: d }; } return null; }).filter(Boolean);
    const mail = buildWeeklyMail({
      person: p, monday, link, doneLastWeek: (doneLast || []).filter(t => assigneesOf(t).includes(p.id)).length,
      tasks: mine.filter(t => t.due >= monday),
      overdue: mine.filter(t => t.due < monday).length,
      meetings: (meetings || []).filter(m => m.server_id === p.server_id && myMeetingIds.has(m.id)).sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
      away: (leaves || []).filter(l => l.server_id === p.server_id && l.user_id !== p.id).map(l => ({ name: nameOf.get(l.user_id) || '?', start_date: l.start_date, end_date: l.end_date })),
      myLeave, events: (events || []).filter(e => e.server_id === p.server_id), birthdays: bdays,
    });
    if (!mail) { marks.push({ kind: 'weekly', item_id: p.id, user_id: p.id, stamp: monday, sent_at: new Date().toISOString() }); covered.add(p.id); continue; }
    try { await sendMail({ to: p.email, ...mail }); sent++; covered.add(p.id); marks.push({ kind: 'weekly', item_id: p.id, user_id: p.id, stamp: monday, sent_at: new Date().toISOString() }); } catch (_) { /* on réessaiera */ }
  }
  if (marks.length) await supabaseAdmin.from('event_notifications').upsert(marks, { onConflict: 'kind,item_id,user_id' });
  return { sent, covered };
}

// ------------------------------------------------------------------
// Conflits découverts après coup (ex. un événement ajouté dans l'agenda Google) : réunions et tâches des 48 prochaines heures
// ------------------------------------------------------------------
async function conflictScan(room, link) {
  const now = Date.now(), horizon = now + 48 * 3600000;
  let sent = 0; const marks = [], clears = [];
  const send = async (kind, item, person, reasons, title, whenLabel, stamp, notified, byName = '') => {
    const key = notifKey(kind, item, person.id);
    if (!reasons.length) { if (notified.has(key)) clears.push({ kind, item_id: item, user_id: person.id }); return; }
    if (notified.get(key) === stamp || !wants(person, 'notify_conflicts') || !person.email || sent >= room) return;
    const lines = reasons.map(r => reasonText(r, person.display_name, 'you').replace(/^./, c => c.toUpperCase()));
    try {
      await sendMail({
        to: person.email, subject: `Conflit d'horaire : ${title}`,
        text: `« ${title} » (${whenLabel})${byName ? `, ${kind === 'conflict_meeting' ? 'organisée' : 'créée'} par ${byName}` : ''} : ${lines.join(' ; ')}.\n${link}`,
        html: layout(`<p>Bonjour ${esc(person.display_name)},</p><p><strong>${esc(title)}</strong> (${esc(whenLabel)})${byName ? ` — ${kind === 'conflict_meeting' ? 'organisée' : 'créée'} par <strong>${esc(byName)}</strong> —` : ''} tombe à un moment où vous n'êtes pas disponible.</p>${warnBox(lines)}${button(link, 'Ouvrir Le Carnet')}<p style="font-size:12px;color:#889">Vous choisissez les emails que vous recevez dans Le Carnet → Profil → Notifications.</p>`),
      });
      sent++; marks.push({ kind, item_id: item, user_id: person.id, stamp, sent_at: new Date().toISOString() });
    } catch (_) { /* on réessaiera */ }
  };

  // -- réunions --
  const { data: meetings } = await supabaseAdmin.from('meetings').select('*').gte('starts_at', new Date(now).toISOString()).lte('starts_at', new Date(horizon).toISOString());
  // -- tâches avec heure --
  const { data: tasks } = await supabaseAdmin.from('tasks').select('id, title, due, due_time, assignee, assignees, done, deleted_at, created_by')
    .eq('done', false).is('deleted_at', null).not('due_time', 'is', null).gte('due', parisToday(now)).lte('due', addDays(parisToday(now), 2));
  const dueMs = (t) => Date.parse(new Date(parisInstantSafe(t.due, t.due_time)).toISOString());
  const soonTasks = (tasks || []).filter(t => { const d = dueMs(t); return d >= now && d <= horizon; });
  const mAtts = meetings && meetings.length ? (await supabaseAdmin.from('meeting_attendees').select('meeting_id, user_id, response').in('meeting_id', meetings.map(m => m.id))).data || [] : [];
  const userIds = [...new Set([...mAtts.map(a => a.user_id), ...soonTasks.flatMap(t => (t.assignees && t.assignees.length ? t.assignees : (t.assignee ? [t.assignee] : [])))])];
  if (!userIds.length) return 0;
  const { data: people } = await supabaseAdmin.from('profiles').select('id, email, display_name, status, work_hours, notify_conflicts').in('id', userIds);
  const profiles = new Map((people || []).filter(p => p.status === 'approved').map(p => [p.id, p]));
  const notified = await loadNotifs(['conflict_meeting', 'conflict_task'], [...(meetings || []).map(m => m.id), ...soonTasks.map(t => t.id)]);
  const busy = await loadBusy(supabaseAdmin, [...profiles.keys()], now, horizon + 86400000);
  const timed = await loadTimedTasks(supabaseAdmin, [...profiles.keys()], parisToday(now), addDays(parisToday(now), 2));
  const creators = await nameMap(supabaseAdmin, [...(meetings || []).map(m => m.created_by), ...soonTasks.map(t => t.created_by)]);

  for (const m of meetings || []) {
    const s = Date.parse(m.starts_at), e = Date.parse(m.ends_at);
    for (const a of mAtts.filter(x => x.meeting_id === m.id && x.response !== 'declined')) {
      const p = profiles.get(a.user_id); if (!p) continue;
      const others = (busy.get(p.id) || []).filter(b => !(b.kind === 'meeting' && b.starts_at === m.starts_at && b.ends_at === m.ends_at));   // pas soi-même
      const reasons = conflictReasons({ startMs: s, endMs: e, user: p, busy: others });
      await send('conflict_meeting', m.id, p, reasons, m.title, whenText(m), `${m.starts_at}|${m.ends_at}|${reasonsStamp(reasons)}`, notified, creators.get(m.created_by) || '');
    }
  }
  for (const t of soonTasks) {
    const T = dueMs(t);
    for (const uid of (t.assignees && t.assignees.length ? t.assignees : (t.assignee ? [t.assignee] : []))) {
      const p = profiles.get(uid); if (!p) continue;
      const reasons = conflictReasons({ startMs: T, endMs: T, user: p, busy: busy.get(p.id) || [], tasks: timed.get(p.id) || [], ignoreTaskId: t.id });
      await send('conflict_task', t.id, p, reasons, t.title, dueText(t), `${dueStamp(t)}|${reasonsStamp(reasons)}`, notified, creators.get(t.created_by) || '');
    }
  }
  if (marks.length) await supabaseAdmin.from('event_notifications').upsert(marks, { onConflict: 'kind,item_id,user_id' });
  for (const c of clears) await supabaseAdmin.from('event_notifications').delete().eq('kind', c.kind).eq('item_id', c.item_id).eq('user_id', c.user_id);
  return sent;
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
    // Les agendas externes se relisent même si les emails ne sont pas configurés.
    let synced = 0;
    try { synced = await syncFeeds(); } catch (_) {}
    if (!mailConfigured()) return await finish({ reason: 'mail_not_configured', synced });

    const link = `${siteUrl(req)}/app/`;
    // 0) résumé du lundi matin
    let weeklyCovered = new Set();
    try { const w = await weeklySummary(MAX_EMAILS_PER_RUN, link); sent += w.sent; weeklyCovered = w.covered; } catch (_) {}
    // 1) rappels de tâches (échéance proche, retard, récapitulatif du matin)
    try { sent += await taskReminders(link, MAX_EMAILS_PER_RUN - sent, weeklyCovered); } catch (_) { /* un échec ici ne bloque pas le reste */ }
    // 2) rappels de réunion, conflits découverts après coup
    try { if (sent < MAX_EMAILS_PER_RUN) sent += await meetingReminders(MAX_EMAILS_PER_RUN - sent, link); } catch (_) {}
    try { if (sent < MAX_EMAILS_PER_RUN) sent += await conflictScan(MAX_EMAILS_PER_RUN - sent, link); } catch (_) {}
    if (mode === 'full') {
      try { await supabaseAdmin.from('event_notifications').delete().lt('sent_at', new Date(Date.now() - 14 * 86400000).toISOString()); } catch (_) {}
      try { await supabaseAdmin.from('mail_log').delete().lt('at', new Date(Date.now() - 30 * 86400000).toISOString()); } catch (_) {}
      try { await supabaseAdmin.from('task_history').delete().lt('at', new Date(Date.now() - 180 * 86400000).toISOString()); } catch (_) {}
    }
    return await finish({ synced });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
}
