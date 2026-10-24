// Réunions : lien d'appel, fichier d'agenda (.ics) joint aux invitations, textes lisibles.
import { esc } from './_mail.js';
import { TZ } from './_time.js';

export const CALL_BASE = 'https://meet.jit.si';
export const callUrl = (room) => `${CALL_BASE}/LeCarnet-${room}`;

const pad = (n) => String(n).padStart(2, '0');
const icsDate = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`; };
const icsText = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
function fold(line) {
  const out = []; let cur = '';
  for (const ch of line) { if (Buffer.byteLength(cur + ch) > 73) { out.push(cur); cur = ' ' + ch; } else cur += ch; }
  out.push(cur); return out.join('\r\n');
}

/** Fichier .ics : method = 'REQUEST' (invitation / mise à jour) ou 'CANCEL' (annulation). */
export function buildIcs({ meeting, organizer, attendees, method = 'REQUEST', link, sequence = 0 }) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Le Carnet//FR', 'CALSCALE:GREGORIAN', `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${meeting.id}@le-carnet`,
    `DTSTAMP:${icsDate(Date.now())}`,
    `SEQUENCE:${sequence}`,
    `DTSTART:${icsDate(Date.parse(meeting.starts_at))}`,
    `DTEND:${icsDate(Date.parse(meeting.ends_at))}`,
    `SUMMARY:${icsText(meeting.title)}`,
    `DESCRIPTION:${icsText((meeting.notes ? meeting.notes + '\n\n' : '') + 'Appel vidéo : ' + link)}`,
    `LOCATION:${icsText(link)}`,
    `URL:${link}`,
    `STATUS:${method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`,
    `ORGANIZER;CN=${icsText(organizer.display_name)}:mailto:${organizer.email}`,
    ...attendees.map(a => `ATTENDEE;CN=${icsText(a.display_name)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a.email}`),
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

export function whenText(meeting) {
  const s = new Date(meeting.starts_at), e = new Date(meeting.ends_at);
  const day = s.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ });
  const t = (d) => d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: TZ }).replace(':', 'h');
  const sameDay = s.toLocaleDateString('fr-FR', { timeZone: TZ }) === e.toLocaleDateString('fr-FR', { timeZone: TZ });
  return sameDay ? `${day}, de ${t(s)} à ${t(e)}` : `${day} à ${t(s)} → ${e.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ })} à ${t(e)}`;
}
export const warnBox = (htmlLines) => `<div style="border-left:4px solid #E8A33D;background:#fff6e5;padding:10px 14px;border-radius:6px;margin:14px 0;font-size:14px"><strong>⚠️ Conflit d'horaire</strong><ul style="margin:6px 0 0;padding-left:18px">${htmlLines.map(l => `<li>${esc(l)}</li>`).join('')}</ul></div>`;
