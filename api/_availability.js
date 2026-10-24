// Disponibilités et conflits d'horaire. Fonctions pures (testables) + un chargeur de données pour les fonctions serveur.
//  • horaires de travail d'une personne : {"1":[["09:00","12:00"],["14:00","18:00"]], …}  (1 = lundi … 7 = dimanche) ; null = aucune limite
//  • un conflit = congé, hors horaires, réunion déjà prévue, agenda externe occupé, autre tâche à la même heure
import { parisInstant, parisToday, addDays, hhmm } from './_time.js';

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
export const isoWeekday = (dateStr) => { const d = new Date(dateStr + 'T12:00:00Z').getUTCDay(); return d === 0 ? 7 : d; };
const WD_SHORT = { 1: 'lun.', 2: 'mar.', 3: 'mer.', 4: 'jeu.', 5: 'ven.', 6: 'sam.', 7: 'dim.' };

/** Vérifie et normalise des horaires. Renvoie { value } (null = aucune limite) ou { error }. */
export function validateWorkHours(wh) {
  if (wh === null || wh === undefined) return { value: null };
  if (typeof wh !== 'object' || Array.isArray(wh)) return { error: 'Horaires invalides.' };
  const out = {};
  for (const [k, ranges] of Object.entries(wh)) {
    if (!/^[1-7]$/.test(k) || !Array.isArray(ranges) || ranges.length < 1 || ranges.length > 2) return { error: 'Horaires invalides.' };
    let prevEnd = -1;
    const clean = [];
    for (const r of ranges) {
      if (!Array.isArray(r) || r.length !== 2 || !HM.test(r[0]) || !HM.test(r[1])) return { error: 'Horaires invalides (format HH:MM).' };
      const a = toMin(r[0]), b = toMin(r[1]);
      if (b <= a) return { error: "L'heure de fin doit être après l'heure de début." };
      if (a < prevEnd) return { error: 'Les plages horaires ne doivent pas se chevaucher.' };
      prevEnd = b; clean.push([r[0], r[1]]);
    }
    out[k] = clean;
  }
  return { value: out };
}

const parisDay = (ms) => parisToday(ms);
/** L'intervalle [startMs, endMs] sort-il des horaires de travail ? (endMs === startMs : un instant) */
export function outsideHours(wh, startMs, endMs) {
  if (!wh) return false;
  const point = endMs <= startMs;
  let cursor = startMs;
  let guard = 0;
  while ((cursor < endMs || (point && guard === 0)) && guard++ < 14) {
    const day = parisDay(cursor);
    const nextMidnight = parisInstant(addDays(day, 1), '00:00:00');
    const segEnd = point ? cursor : Math.min(endMs, nextMidnight);
    const ranges = wh[String(isoWeekday(day))] || [];
    const inside = ranges.some(([a, b]) => parisInstant(day, a + ':00') <= cursor && segEnd <= parisInstant(day, b + ':00'));
    if (!inside) return true;
    cursor = nextMidnight;
  }
  return false;
}

export function describeWorkHours(wh) {
  if (!wh) return 'toujours disponible';
  const days = Object.keys(wh).sort().map(k => `${WD_SHORT[k]} ${wh[k].map(([a, b]) => `${hhmm(a)}–${hhmm(b)}`).join(' et ')}`);
  return days.join(', ') || 'jamais disponible';
}

const ms = (v) => (typeof v === 'number' ? v : Date.parse(v));
const overlaps = (s, e, bs, be, point) => (point ? bs <= s && s < be : s < be && e > bs);

/**
 * Raisons pour lesquelles `user` n'est pas disponible sur [startMs, endMs].
 * @param user   { display_name, work_hours }
 * @param busy   créneaux de CETTE personne : [{ kind: 'leave'|'meeting'|'google', starts_at, ends_at }]
 * @param tasks  tâches datées de cette personne (pour « deux tâches à la même heure ») : [{ id, title, due, due_time }]
 * @param opts   { allDay: true } pour une tâche « toute la journée » (seul un congé compte), { ignoreTaskId }
 * @returns [{ kind, label? }]
 */
export function conflictReasons({ startMs, endMs, user, busy = [], tasks = [], allDay = false, ignoreTaskId = null }) {
  const out = [];
  const point = endMs <= startMs;
  if (allDay) {
    // journée entière : seul un congé accepté pose problème
    const day = parisDay(startMs);
    const d0 = parisInstant(day, '00:00:00'), d1 = parisInstant(addDays(day, 1), '00:00:00');
    if (busy.some(b => b.kind === 'leave' && overlaps(d0, d1, ms(b.starts_at), ms(b.ends_at), false))) out.push({ kind: 'leave' });
    return out;
  }
  const on = (kind) => busy.some(b => b.kind === kind && overlaps(startMs, endMs, ms(b.starts_at), ms(b.ends_at), point));
  if (on('leave')) out.push({ kind: 'leave' });
  else if (outsideHours(user && user.work_hours, startMs, endMs)) out.push({ kind: 'hours' });
  if (on('meeting')) out.push({ kind: 'meeting' });
  if (on('google')) out.push({ kind: 'google' });
  if (point) {
    const same = tasks.find(t => t.id !== ignoreTaskId && t.due && t.due_time && Math.abs(parisInstant(t.due, String(t.due_time).slice(0, 8).length === 5 ? t.due_time + ':00' : t.due_time) - startMs) < 60000);
    if (same) out.push({ kind: 'task', label: same.title });
  }
  return out;
}

/** Phrase lisible. voice: 'you' (pour la personne concernée) ou 'name' (pour l'organisateur). */
export function reasonText(r, name, voice = 'you') {
  const you = voice === 'you';
  switch (r.kind) {
    case 'leave': return you ? 'tu es en congé à cette date' : `${name} est en congé à cette date`;
    case 'hours': return you ? "c'est en dehors de tes horaires de disponibilité" : `c'est en dehors des horaires de disponibilité de ${name}`;
    case 'meeting': return you ? 'tu as déjà une réunion à ce moment-là' : `${name} a déjà une réunion à ce moment-là`;
    case 'google': return you ? 'ton agenda externe (Google…) est occupé à ce moment-là' : `l'agenda externe de ${name} est occupé à ce moment-là`;
    case 'task': return you ? `tu as déjà une autre tâche à la même heure (« ${r.label} »)` : `${name} a déjà une tâche à la même heure (« ${r.label} »)`;
    default: return '';
  }
}
export const reasonsStamp = (reasons) => reasons.map(r => r.kind + (r.label || '')).sort().join('|');

/**
 * Charge (accès administrateur) les créneaux occupés de plusieurs personnes sur une période.
 * Renvoie Map userId -> [{ kind, starts_at, ends_at }]
 */
export async function loadBusy(sb, userIds, fromMs, toMs, ignoreMeetingId = null) {
  const out = new Map(userIds.map(id => [id, []]));
  if (!userIds.length) return out;
  const fromDate = parisToday(fromMs), toDate = parisToday(toMs);
  const { data: leaves } = await sb.from('leave_requests').select('user_id, start_date, end_date')
    .in('user_id', userIds).eq('status', 'approved').lte('start_date', toDate).gte('end_date', fromDate);
  for (const l of leaves || []) {
    out.get(l.user_id).push({ kind: 'leave', starts_at: new Date(parisInstant(l.start_date, '00:00:00')).toISOString(), ends_at: new Date(parisInstant(addDays(l.end_date, 1), '00:00:00')).toISOString() });
  }
  const { data: atts } = await sb.from('meeting_attendees').select('meeting_id, user_id, response').in('user_id', userIds).neq('response', 'declined');
  const meetingIds = [...new Set((atts || []).map(a => a.meeting_id))].filter(id => id !== ignoreMeetingId);
  if (meetingIds.length) {
    const { data: ms_ } = await sb.from('meetings').select('id, starts_at, ends_at').in('id', meetingIds)
      .lt('starts_at', new Date(toMs).toISOString()).gt('ends_at', new Date(fromMs).toISOString());
    const byId = new Map((ms_ || []).map(m => [m.id, m]));
    for (const a of atts || []) { const m = byId.get(a.meeting_id); if (m && a.meeting_id !== ignoreMeetingId) out.get(a.user_id).push({ kind: 'meeting', starts_at: m.starts_at, ends_at: m.ends_at }); }
  }
  const { data: feeds } = await sb.from('calendar_feeds').select('user_id, busy').in('user_id', userIds);
  for (const f of feeds || []) for (const [s, e] of f.busy || []) if (Date.parse(s) < toMs && Date.parse(e) > fromMs) out.get(f.user_id).push({ kind: 'google', starts_at: s, ends_at: e });
  return out;
}

/** Tâches datées (avec heure), non terminées, d'un ensemble de personnes, entre deux dates (jours de Paris). */
export async function loadTimedTasks(sb, userIds, fromDate, toDate) {
  const { data } = await sb.from('tasks').select('id, title, due, due_time, assignee, assignees, done, deleted_at')
    .eq('done', false).is('deleted_at', null).not('due_time', 'is', null).gte('due', fromDate).lte('due', toDate);
  const byUser = new Map(userIds.map(id => [id, []]));
  for (const t of data || []) {
    const who = (t.assignees && t.assignees.length ? t.assignees : (t.assignee ? [t.assignee] : []));
    for (const id of who) if (byUser.has(id)) byUser.get(id).push(t);
  }
  return byUser;
}
