// Lecture d'un agenda iCal (.ics) : renvoie les créneaux « occupé » d'une période.
// Sans dépendance externe. Gère : heures UTC / fuseaux (TZID) / journées entières, durée, répétitions (RRULE :
// chaque jour, semaine, mois, an, avec INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY), exceptions (EXDATE),
// occurrences modifiées (RECURRENCE-ID), événements annulés ou « libres » (TRANSP:TRANSPARENT) ignorés.
// Une règle de répétition trop exotique est traitée comme un événement unique (jamais d'erreur).

const DEFAULT_TZ = 'Europe/Paris';
const WIN_TZ = {
  'Romance Standard Time': 'Europe/Paris', 'W. Europe Standard Time': 'Europe/Berlin', 'GMT Standard Time': 'Europe/London',
  'Central Europe Standard Time': 'Europe/Budapest', 'Central European Standard Time': 'Europe/Warsaw', 'UTC': 'UTC',
  'Eastern Standard Time': 'America/New_York', 'Pacific Standard Time': 'America/Los_Angeles',
};
const DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const MAX_ITER = 4000;

const okZone = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (_) { return false; } };
const zoneOf = (tzid) => { if (!tzid) return DEFAULT_TZ; const t = WIN_TZ[tzid] || tzid; return okZone(t) ? t : DEFAULT_TZ; };

function offsetMs(tz, ts) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ts / 1000) * 1000;
}
// Heure « murale » (y, m, d, hh, mm, ss dans le fuseau tz) → instant réel (ms)
export function zonedInstant(tz, y, m, d, hh = 0, mm = 0, ss = 0) {
  const guess = Date.UTC(y, m - 1, d, hh, mm, ss);
  let t = guess - offsetMs(tz, guess);
  t = guess - offsetMs(tz, t);
  return t;
}

// ---- lecture des lignes ----
function unfold(text) { return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, ''); }
function parseLine(line) {
  const i = (() => { let q = false; for (let k = 0; k < line.length; k++) { const c = line[k]; if (c === '"') q = !q; else if (c === ':' && !q) return k; } return -1; })();
  if (i < 0) return null;
  const head = line.slice(0, i), value = line.slice(i + 1);
  const parts = head.split(';');
  const params = {};
  for (const p of parts.slice(1)) { const e = p.indexOf('='); if (e > 0) params[p.slice(0, e).toUpperCase()] = p.slice(e + 1).replace(/^"|"$/g, ''); }
  return { name: parts[0].toUpperCase(), params, value };
}
// Valeur de date → { y, m, d, hh, mm, ss, utc, dateOnly }
function parseDateValue(value, params) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(String(value).trim());
  if (!m) return null;
  const dateOnly = m[4] === undefined || (params && params.VALUE === 'DATE');
  return { y: +m[1], m: +m[2], d: +m[3], hh: +(m[4] || 0), mm: +(m[5] || 0), ss: +(m[6] || 0), utc: m[7] === 'Z', dateOnly, tz: zoneOf(params && params.TZID) };
}
const toInstant = (p) => (p.utc ? Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) : zonedInstant(p.tz, p.y, p.m, p.d, p.hh, p.mm, p.ss));
function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(v).trim());
  if (!m) return null;
  const s = ((+m[2] || 0) * 7 * 86400 + (+m[3] || 0) * 86400 + (+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) * 1000;
  return m[1] === '-' ? -s : s;
}

export function parseIcs(text) {
  const lines = unfold(text).split('\n');
  const events = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^BEGIN:VEVENT$/i.test(line)) { cur = { props: [] }; continue; }
    if (/^END:VEVENT$/i.test(line)) { if (cur) events.push(cur); cur = null; continue; }
    if (cur) { const p = parseLine(line); if (p) cur.props.push(p); }
  }
  return events.map(ev => {
    const get = (n) => ev.props.find(p => p.name === n);
    const all = (n) => ev.props.filter(p => p.name === n);
    const ds = get('DTSTART'); if (!ds) return null;
    const start = parseDateValue(ds.value, ds.params); if (!start) return null;
    const de = get('DTEND'), du = get('DURATION');
    let endP = de ? parseDateValue(de.value, de.params) : null;
    const startMs = start.dateOnly ? zonedInstant(start.tz === DEFAULT_TZ && !ds.params.TZID ? DEFAULT_TZ : start.tz, start.y, start.m, start.d) : toInstant(start);
    let endMs;
    if (endP) endMs = endP.dateOnly ? zonedInstant(endP.tz, endP.y, endP.m, endP.d) : toInstant(endP);
    else if (du && parseDuration(du.value) != null) endMs = startMs + parseDuration(du.value);
    else endMs = start.dateOnly ? zonedInstant(start.tz, start.y, start.m, start.d + 1) : startMs;
    const rr = get('RRULE');
    const rid = get('RECURRENCE-ID');
    const ridP = rid ? parseDateValue(rid.value, rid.params) : null;
    const exdates = [];
    for (const x of all('EXDATE')) for (const v of x.value.split(',')) { const p = parseDateValue(v, x.params); if (p) exdates.push(p.dateOnly ? { date: `${p.y}-${p.m}-${p.d}` } : { ms: toInstant(p) }); }
    return {
      uid: (get('UID') || {}).value || '',
      startMs, endMs, allDay: start.dateOnly, tz: start.tz, wall: start,
      rrule: rr ? Object.fromEntries(rr.value.split(';').map(kv => kv.split('=')).filter(a => a.length === 2).map(([k, v]) => [k.toUpperCase(), v])) : null,
      exdates,
      recurrenceId: ridP ? (ridP.dateOnly ? zonedInstant(ridP.tz, ridP.y, ridP.m, ridP.d) : toInstant(ridP)) : null,
      transparent: ((get('TRANSP') || {}).value || '').toUpperCase() === 'TRANSPARENT',
      cancelled: ((get('STATUS') || {}).value || '').toUpperCase() === 'CANCELLED',
    };
  }).filter(Boolean);
}

// ---- répétitions : dates « murales » successives (en UTC fictif), converties ensuite en instants ----
const dayKey = (t) => { const d = new Date(t); return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`; };
function* wallDates(ev, untilWallMs) {
  const r = ev.rrule, w = ev.wall;
  const interval = Math.max(1, parseInt(r.INTERVAL || '1', 10) || 1);
  const first = Date.UTC(w.y, w.m - 1, w.d);
  const byday = r.BYDAY ? r.BYDAY.split(',').map(s => /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(s.trim())).filter(Boolean).map(m => ({ n: m[1] ? parseInt(m[1], 10) : 0, dow: DAYS[m[2]] })) : [];
  const bymonthday = r.BYMONTHDAY ? r.BYMONTHDAY.split(',').map(Number).filter(Boolean) : [];
  const freq = (r.FREQ || '').toUpperCase();
  let iter = 0;
  if (freq === 'DAILY') {
    for (let t = first; t <= untilWallMs && iter++ < MAX_ITER; t += interval * 86400000) {
      if (byday.length && !byday.some(b => b.dow === new Date(t).getUTCDay())) continue;
      yield t;
    }
  } else if (freq === 'WEEKLY') {
    const wkst = DAYS[(r.WKST || 'MO').toUpperCase()] ?? 1;
    const dow0 = new Date(first).getUTCDay();
    const startOfWeek = first - ((dow0 - wkst + 7) % 7) * 86400000;
    const days = (byday.length ? byday.map(b => b.dow) : [dow0]);
    for (let ws = startOfWeek; ws <= untilWallMs && iter++ < MAX_ITER; ws += interval * 7 * 86400000) {
      const cand = days.map(dw => ws + ((dw - wkst + 7) % 7) * 86400000).sort((a, b) => a - b);
      for (const t of cand) if (t >= first && t <= untilWallMs) yield t;
    }
  } else if (freq === 'MONTHLY') {
    const baseMonth = w.y * 12 + (w.m - 1);
    for (let k = 0; iter++ < MAX_ITER; k += interval) {
      const idx = baseMonth + k, y = Math.floor(idx / 12), mo = idx % 12;
      if (Date.UTC(y, mo, 1) > untilWallMs) return;
      const dim = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
      let list = [];
      if (byday.length) {
        for (const b of byday) {
          const days = []; for (let d = 1; d <= dim; d++) if (new Date(Date.UTC(y, mo, d)).getUTCDay() === b.dow) days.push(d);
          if (!b.n) list.push(...days); else { const d = b.n > 0 ? days[b.n - 1] : days[days.length + b.n]; if (d) list.push(d); }
        }
      } else if (bymonthday.length) list = bymonthday.map(d => (d > 0 ? d : dim + 1 + d)).filter(d => d >= 1 && d <= dim);
      else if (w.d <= dim) list = [w.d];
      list.sort((a, b) => a - b);
      for (const d of list) { const t = Date.UTC(y, mo, d); if (t >= first && t <= untilWallMs) yield t; }
    }
  } else if (freq === 'YEARLY') {
    for (let k = 0; iter++ < MAX_ITER; k += interval) {
      const y = w.y + k; const t = Date.UTC(y, w.m - 1, w.d);
      if (t > untilWallMs) return;
      if (new Date(t).getUTCMonth() === w.m - 1) yield t;     // 29 février : ignoré les années non bissextiles
    }
  } else {
    yield first;                                             // règle non gérée : l'événement seul
  }
}

// Occurrences [début, fin] d'un événement (ms) qui rencontrent la fenêtre [from, to]
function occurrences(ev, from, to, overrideIds) {
  const dur = Math.max(0, ev.endMs - ev.startMs);
  const out = [];
  if (!ev.rrule) { if (ev.endMs > from && ev.startMs < to) out.push([ev.startMs, Math.max(ev.endMs, ev.startMs + 1)]); return out; }
  let until = Infinity;
  if (ev.rrule.UNTIL) { const p = parseDateValue(ev.rrule.UNTIL, {}); if (p) until = p.utc ? Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) : (p.dateOnly ? Date.UTC(p.y, p.m - 1, p.d, 23, 59, 59) : toInstant({ ...p, tz: ev.tz })); }
  const count = ev.rrule.COUNT ? parseInt(ev.rrule.COUNT, 10) : Infinity;
  const untilWall = Math.min(isFinite(until) ? until + 86400000 : Infinity, to + 2 * 86400000);
  let n = 0;
  for (const wt of wallDates(ev, untilWall)) {
    const d = new Date(wt);
    const s = ev.allDay ? zonedInstant(ev.tz, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
      : zonedInstant(ev.tz, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), ev.wall.hh, ev.wall.mm, ev.wall.ss);
    if (s > until) break;
    if (++n > count) break;
    if (s >= to) break;
    if (ev.exdates.some(x => (x.ms !== undefined ? x.ms === s : x.date === dayKey(wt)))) continue;
    if (overrideIds && overrideIds.has(s)) continue;
    if (s + dur > from) out.push([s, Math.max(s + dur, s + 1)]);
  }
  return out;
}

/** Créneaux occupés [[début, fin], …] (ms, fusionnés) entre `from` et `to`. */
export function busyIntervals(text, from, to) {
  const events = parseIcs(text).filter(e => !e.cancelled && !e.transparent);
  const allParsed = parseIcs(text);
  // occurrences modifiées / annulées : on retire l'occurrence d'origine de la série
  const overridden = new Map();
  for (const e of allParsed) if (e.recurrenceId != null) { if (!overridden.has(e.uid)) overridden.set(e.uid, new Set()); overridden.get(e.uid).add(e.recurrenceId); }
  const list = [];
  for (const e of events) {
    if (e.recurrenceId != null) { list.push(...occurrences({ ...e, rrule: null }, from, to)); continue; }
    list.push(...occurrences(e, from, to, overridden.get(e.uid)));
  }
  list.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of list) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e); else merged.push([s, e]);
  }
  return merged;
}

// Adresses d'agenda acceptées (protection : on ne contacte que de vrais services d'agenda, en https).
const ALLOWED_HOSTS = [/^calendar\.google\.com$/, /^outlook\.live\.com$/, /^outlook\.office365\.com$/, /^outlook\.office\.com$/, /(^|\.)icloud\.com$/];
export function normalizeIcsUrl(input) {
  let u;
  try { u = new URL(String(input).trim().replace(/^webcal:\/\//i, 'https://')); } catch (_) { return { error: "Cette adresse n'est pas valide." }; }
  if (u.protocol !== 'https:') return { error: 'L\'adresse doit commencer par https:// (ou webcal://).' };
  if (!ALLOWED_HOSTS.some(re => re.test(u.hostname))) return { error: 'Seuls les agendas Google, Outlook et Apple (iCloud) sont acceptés pour le moment.' };
  if (u.username || u.password) return { error: "Cette adresse n'est pas valide." };
  return { url: u.toString() };
}

/** Télécharge un agenda iCal (limite de taille et de durée, aucune redirection suivie) et renvoie son texte. */
export async function fetchIcs(url, fetchImpl = fetch) {
  const res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined, headers: { Accept: 'text/calendar, text/plain, */*' } });
  if (res.status >= 300 && res.status < 400) throw new Error("L'adresse redirige ailleurs : copie à nouveau le lien secret depuis les réglages de l'agenda.");
  if (res.status === 404 || res.status === 403 || res.status === 401) throw new Error("L'agenda est introuvable ou le lien secret a été réinitialisé. Copie le nouveau lien.");
  if (!res.ok) throw new Error('Lecture de l\'agenda impossible (erreur ' + res.status + ').');
  const len = Number(res.headers.get('content-length') || 0);
  if (len > 8 * 1024 * 1024) throw new Error('Agenda trop volumineux.');
  const text = await res.text();
  if (text.length > 8 * 1024 * 1024) throw new Error('Agenda trop volumineux.');
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("Ce lien ne renvoie pas un agenda (format iCal attendu).");
  return text;
}

export const SYNC_PAST_DAYS = 1;
export const SYNC_AHEAD_DAYS = 45;
/** Lit un agenda et renvoie les créneaux occupés à stocker : [["début ISO","fin ISO"], …] */
export function busyForStorage(text, now = Date.now()) {
  return busyIntervals(text, now - SYNC_PAST_DAYS * 86400000, now + SYNC_AHEAD_DAYS * 86400000).map(([s, e]) => [new Date(s).toISOString(), new Date(e).toISOString()]);
}
