// Utilitaires de dates en heure de Paris (aucune dépendance).

export const TZ = 'Europe/Paris';

// Décalage (en ms) entre l'heure de Paris et UTC à un instant donné.
function tzOffsetMs(ts) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ts / 1000) * 1000;
}
// "2026-10-20" + "14:30" (heure de Paris) → instant réel (ms). Sans heure : fin de journée (23:59:59).
export function parisInstant(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm, ss] = (timeStr || '23:59:59').split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm, ss || 0);
  let t = guess - tzOffsetMs(guess);
  t = guess - tzOffsetMs(t); // 2e passage : correct autour des changements d'heure
  return t;
}
export const parisToday = (now = Date.now()) => new Date(now).toLocaleDateString('sv-SE', { timeZone: TZ });
export const parisHour = (now = Date.now()) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date(now)));
export function addDays(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
export const hhmm = (t) => (t ? String(t).slice(0, 5).replace(':', 'h') : '');

// Échéance lisible : « mardi 20 octobre à 14h30 » ou « mardi 20 octobre (toute la journée) »
export function dueText(task) {
  if (!task.due) return null;
  const day = new Date(task.due + 'T12:00:00Z').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  return task.due_time ? `${day} à ${hhmm(task.due_time)}` : `${day} (toute la journée)`;
}
// Version de l'échéance, pour ne prévenir qu'une fois par échéance.
export const dueStamp = (task) => `${task.due || ''} ${task.due_time ? String(task.due_time).slice(0, 5) : ''}`.trim();

// Préférences : valeur par défaut = activé.
export const wants = (profile, key) => profile[key] !== false;
