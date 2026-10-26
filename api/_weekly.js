// Résumé du lundi : construit l'email « ta semaine » (fonction pure, testable).
import { esc, layout, button } from './_mail.js';
import { addDays, hhmm, TZ } from './_time.js';

const dayLabel = (iso, opts = { weekday: 'long', day: 'numeric', month: 'long' }) => new Date(iso + 'T12:00:00Z').toLocaleDateString('fr-FR', { ...opts, timeZone: 'UTC' });
const dayOf = (ms) => new Date(ms).toLocaleDateString('sv-SE', { timeZone: TZ });
const timeOf = (ms) => new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: TZ }).replace(':', 'h');
export const isoWeekday = (iso) => { const d = new Date(iso + 'T12:00:00Z').getUTCDay(); return d === 0 ? 7 : d; };
export const mondayOf = (iso) => addDays(iso, -(isoWeekday(iso) - 1));

/**
 * @param monday    'AAAA-MM-JJ' du lundi de la semaine
 * @param tasks     tâches ouvertes de la personne, dues du lundi au dimanche : [{ title, due, due_time }]
 * @param overdue   nombre de tâches en retard
 * @param meetings  [{ title, starts_at, ends_at }]
 * @param away      [{ name, start_date, end_date }]  absences des autres (congés acceptés qui touchent la semaine)
 * @param myLeave   [{ start_date, end_date }]
 * @param events    [{ title, start_date, end_date }]
 * @param birthdays [{ name, day }]
 * @returns { subject, text, html } ou null s'il n'y a rien à dire
 */
export function buildWeeklyMail({ person, monday, tasks = [], overdue = 0, meetings = [], away = [], myLeave = [], events = [], birthdays = [], link, doneLastWeek = 0 }) {
  const sunday = addDays(monday, 6);
  if (!tasks.length && !overdue && !meetings.length && !away.length && !myLeave.length && !events.length && !birthdays.length) return null;
  const span = (a, b) => (a === b ? dayLabel(a, { weekday: 'long', day: 'numeric' }) : `${dayLabel(a < monday ? monday : a, { weekday: 'short', day: 'numeric' })} → ${dayLabel(b > sunday ? sunday : b, { weekday: 'short', day: 'numeric' })}`);
  const days = [];
  for (let i = 0; i < 7; i++) days.push(addDays(monday, i));
  const perDay = days.map(d => ({
    d,
    items: [
      ...meetings.filter(m => dayOf(Date.parse(m.starts_at)) === d).map(m => ({ at: timeOf(Date.parse(m.starts_at)), sort: timeOf(Date.parse(m.starts_at)), label: `📹 ${m.title}`, hm: `${timeOf(Date.parse(m.starts_at))}–${timeOf(Date.parse(m.ends_at))}` })),
      ...tasks.filter(t => t.due === d).map(t => ({ sort: t.due_time ? hhmm(t.due_time) : '99h99', label: `☑ ${t.title}`, hm: t.due_time ? hhmm(t.due_time) : 'journée' })),
    ].sort((a, b) => a.sort.localeCompare(b.sort)),
  })).filter(x => x.items.length);

  const hello = `<p>Bonjour ${esc(person.display_name)}, voici ta semaine du ${esc(dayLabel(monday, { day: 'numeric', month: 'long' }))} au ${esc(dayLabel(sunday, { day: 'numeric', month: 'long' }))}.</p>`;
  const box = (title, color, inner) => `<p style="margin:18px 0 6px;font-weight:bold;color:${color}">${title}</p>${inner}`;
  let html = hello, text = `Ta semaine du ${dayLabel(monday, { day: 'numeric', month: 'long' })} au ${dayLabel(sunday, { day: 'numeric', month: 'long' })}\n`;
  if (doneLastWeek > 0) { html += `<p style="background:#e8f5ee;border-left:4px solid #2F9E6B;padding:8px 12px;border-radius:6px">✅ La semaine dernière, tu as terminé <strong>${doneLastWeek}</strong> tâche${doneLastWeek > 1 ? 's' : ''}. Bravo !</p>`; text += `\nLa semaine dernière : ${doneLastWeek} tâche${doneLastWeek > 1 ? 's' : ''} terminée${doneLastWeek > 1 ? 's' : ''}.\n`; }
  if (overdue) { html += `<p style="background:#fdecea;border-left:4px solid #D6453A;padding:8px 12px;border-radius:6px">⏰ Tu as <strong>${overdue}</strong> tâche${overdue > 1 ? 's' : ''} en retard.</p>`; text += `\n⏰ ${overdue} tâche(s) en retard\n`; }
  if (myLeave.length) { html += `<p style="background:#e8f5ee;border-left:4px solid #2F9E6B;padding:8px 12px;border-radius:6px">🌴 Tu es en congé : ${myLeave.map(l => esc(span(l.start_date, l.end_date))).join(' ; ')}.</p>`; text += `\n🌴 Tu es en congé : ${myLeave.map(l => span(l.start_date, l.end_date)).join(' ; ')}\n`; }
  if (perDay.length) {
    html += box('Au programme', '#3d7bd9', perDay.map(x => `<div style="margin:8px 0 2px;font-weight:bold;text-transform:capitalize">${esc(dayLabel(x.d))}</div><ul style="margin:0;padding-left:18px">${x.items.map(i => `<li><span style="color:#667">${esc(i.hm)}</span> ${esc(i.label)}</li>`).join('')}</ul>`).join(''));
    text += '\nAu programme\n' + perDay.map(x => `${dayLabel(x.d)}\n${x.items.map(i => `  ${i.hm} ${i.label}`).join('\n')}`).join('\n') + '\n';
  }
  if (events.length) { html += box('Dans l\'équipe', '#c76d00', `<ul style="margin:0;padding-left:18px">${events.map(e => `<li>🎉 ${esc(e.title)} <span style="color:#667">(${esc(span(e.start_date, e.end_date))})</span></li>`).join('')}</ul>`); text += '\nDans l\'équipe\n' + events.map(e => `  🎉 ${e.title} (${span(e.start_date, e.end_date)})`).join('\n') + '\n'; }
  if (birthdays.length) { html += box('Anniversaires', '#c2488a', `<ul style="margin:0;padding-left:18px">${birthdays.map(b => `<li>🎂 ${esc(b.name)} <span style="color:#667">(${esc(dayLabel(b.day, { weekday: 'long', day: 'numeric' }))})</span></li>`).join('')}</ul>`); text += '\nAnniversaires\n' + birthdays.map(b => `  🎂 ${b.name} (${dayLabel(b.day, { weekday: 'long', day: 'numeric' })})`).join('\n') + '\n'; }
  if (away.length) { html += box('Absents cette semaine', '#2F7F5A', `<ul style="margin:0;padding-left:18px">${away.map(a => `<li>🌴 ${esc(a.name)} <span style="color:#667">(${esc(span(a.start_date, a.end_date))})</span></li>`).join('')}</ul>`); text += '\nAbsents cette semaine\n' + away.map(a => `  🌴 ${a.name} (${span(a.start_date, a.end_date)})`).join('\n') + '\n'; }
  html += button(link, 'Ouvrir Le Carnet') + `<p style="font-size:12px;color:#889">Tu peux désactiver ce résumé dans Le Carnet → Profil → Notifications.</p>`;
  const n = tasks.length + meetings.length;
  return { subject: `Ta semaine : ${n ? `${n} élément${n > 1 ? 's' : ''} au programme` : 'les nouvelles de l\'équipe'}`, text: text + link, html: layout(html) };
}
