// Planificateur de rappels : décide QUI doit recevoir QUEL email maintenant.
// Fonction pure (aucun accès réseau ni base) pour pouvoir la tester facilement.
//
// Types d'emails :
//  • soon    : une tâche avec une heure limite arrive à échéance bientôt (délai choisi par chacun, 2 h par défaut)
//  • overdue : l'échéance est dépassée et la tâche n'est pas terminée (une seule fois par échéance)
//  • digest  : le matin, récapitulatif des tâches pour aujourd'hui et demain
import { parisInstant, parisToday, parisHour, addDays, dueStamp, wants } from './_time.js';

const MIN = 60000;
const OVERDUE_WINDOW_DAYS = 3;   // on ne signale pas les retards plus anciens que ça
export const DIGEST_FROM_HOUR = 7;   // heure de Paris à partir de laquelle part le récapitulatif
export const DIGEST_UNTIL_HOUR = 20;
export const OVERDUE_ALLDAY_HOUR = 9; // une tâche « toute la journée » est signalée en retard le lendemain à partir de 9 h

export const assigneesOf = (t) => (t.assignees && t.assignees.length ? t.assignees : (t.assignee ? [t.assignee] : []));

export function minutesLabel(min) {
  if (min < 1) return "moins d'une minute";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`;
}

/**
 * @param tasks     tâches ouvertes (done=false, non supprimées) avec due / due_time / assignees / created_at
 * @param profiles  Map id -> profil (status, notify_*, remind_lead_minutes)
 * @param sent      Map "taskId|userId|kind" -> stamp déjà envoyé
 * @param now       instant courant (ms)
 * @returns { soon, overdue, digest } : trois Map userId -> [{ task, ... }]
 */
export function planReminders({ tasks, profiles, sent, now }) {
  const out = { soon: new Map(), overdue: new Map(), digest: new Map() };
  const add = (kind, uid, item) => { if (!out[kind].has(uid)) out[kind].set(uid, []); out[kind].get(uid).push(item); };
  const today = parisToday(now), tomorrow = addDays(today, 1), hour = parisHour(now);
  const digestOpen = hour >= DIGEST_FROM_HOUR && hour < DIGEST_UNTIL_HOUR;

  for (const t of tasks) {
    if (!t.due || t.done || t.deleted_at) continue;
    const stamp = dueStamp(t);
    const timed = Boolean(t.due_time);
    const deadline = parisInstant(t.due, t.due_time || '23:59:59');
    const createdAt = t.created_at ? Date.parse(t.created_at) : 0;
    const already = (uid, kind) => sent.get(`${t.id}|${uid}|${kind}`);

    for (const uid of assigneesOf(t)) {
      const p = profiles.get(uid);
      if (!p || p.status !== 'approved') continue;

      // 1) Il reste peu de temps (uniquement pour les tâches avec une heure)
      if (timed && wants(p, 'notify_soon')) {
        const lead = (p.remind_lead_minutes || 120) * MIN;
        if (now >= deadline - lead && now < deadline && already(uid, 'soon') !== stamp) {
          add('soon', uid, { task: t, minutesLeft: Math.max(0, Math.ceil((deadline - now) / MIN)), stamp });
        }
      }

      // 2) Échéance dépassée
      if (wants(p, 'notify_overdue') && createdAt <= deadline) {
        let isLate = false;
        if (timed) isLate = now >= deadline && now - deadline < OVERDUE_WINDOW_DAYS * 86400000;
        else isLate = t.due < today && t.due >= addDays(today, -OVERDUE_WINDOW_DAYS) && hour >= OVERDUE_ALLDAY_HOUR;
        if (isLate && already(uid, 'overdue') !== stamp) add('overdue', uid, { task: t, stamp });
      }

      // 3) Récapitulatif du matin : tâches pour aujourd'hui et demain (une mention par jour au plus)
      if (digestOpen && wants(p, 'notify_digest') && (t.due === today || t.due === tomorrow)) {
        if (timed && t.due === today && now >= deadline) continue; // déjà passée : traitée par « en retard »
        const when = t.due === today ? 'today' : 'tomorrow';
        const dstamp = `${stamp}|${when}`;
        if (already(uid, 'digest') !== dstamp) add('digest', uid, { task: t, when, stamp: dstamp });
      }
    }
  }
  return out;
}
