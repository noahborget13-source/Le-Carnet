// Liaison de l'agenda Google par autorisation (OAuth 2). Le préfixe _ empêche Vercel d'en faire une fonction.
// On ne demande qu'UNE permission : « calendar.freebusy » = savoir quand la personne est occupée.
// Aucun titre, lieu ou participant n'est jamais lu, et rien n'est écrit dans l'agenda.
import crypto from 'node:crypto';

export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/calendar.freebusy';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const FREEBUSY_URL = 'https://www.googleapis.com/calendar/v3/freeBusy';

export const googleConfigured = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const secret = () => String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');

/** « state » signé : lie le retour de Google à la personne connectée, valable 10 minutes. */
export function makeState(userId, now = Date.now()) {
  const body = `${userId}.${now}`;
  return `${body}.${crypto.createHmac('sha256', secret()).update('gcal:' + body).digest('hex').slice(0, 40)}`;
}
export function checkState(state, now = Date.now()) {
  const parts = String(state || '').split('.');
  if (parts.length !== 3) return null;
  const [userId, ts, sig] = parts;
  const good = crypto.createHmac('sha256', secret()).update(`gcal:${userId}.${ts}`).digest('hex').slice(0, 40);
  const a = Buffer.from(sig), b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const age = now - Number(ts);
  if (!(age >= 0 && age <= 10 * 60000)) return null;
  return userId;
}

export function authUrl(redirectUri, state) {
  const q = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri, response_type: 'code', scope: GOOGLE_SCOPE, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false', state });
  return `${AUTH_URL}?${q}`;
}

async function tokenCall(params, fetchImpl) {
  const res = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, ...params }), signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, json };
}
export async function exchangeCode(code, redirectUri, fetchImpl = fetch) {
  const { ok, json } = await tokenCall({ code, redirect_uri: redirectUri, grant_type: 'authorization_code' }, fetchImpl);
  if (!ok || !json.refresh_token) throw new Error("Google n'a pas donné l'autorisation durable. Réessayez en acceptant l'accès à la disponibilité de l'agenda.");
  if (!String(json.scope || '').includes('calendar.freebusy')) throw new Error("L'autorisation d'accès à la disponibilité de l'agenda n'a pas été cochée.");
  return json.refresh_token;
}
export async function accessToken(refreshToken, fetchImpl = fetch) {
  const { ok, json } = await tokenCall({ refresh_token: refreshToken, grant_type: 'refresh_token' }, fetchImpl);
  if (!ok || !json.access_token) {
    if (json.error === 'invalid_grant') throw new Error("L'autorisation Google a expiré ou a été retirée : reconnectez votre agenda.");
    throw new Error('Connexion à Google impossible pour le moment.');
  }
  return json.access_token;
}
export async function revokeToken(refreshToken, fetchImpl = fetch) {
  try { await fetchImpl(REVOKE_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: refreshToken }), signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined }); } catch (_) { /* meilleur effort */ }
}

/** Créneaux occupés de l'agenda principal : [["début ISO","fin ISO"], …], fusionnés, sur la même fenêtre que le lien iCal. */
export async function fetchGoogleBusy(refreshToken, now = Date.now(), fetchImpl = fetch, pastDays = 1, aheadDays = 45) {
  const token = await accessToken(refreshToken, fetchImpl);
  const res = await fetchImpl(FREEBUSY_URL, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeMin: new Date(now - pastDays * 86400000).toISOString(), timeMax: new Date(now + aheadDays * 86400000).toISOString(), items: [{ id: 'primary' }] }), signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined });
  if (res.status === 401 || res.status === 403) throw new Error("L'autorisation Google ne permet plus de lire l'agenda : reconnectez-le.");
  if (!res.ok) throw new Error('Lecture de l\'agenda Google impossible (erreur ' + res.status + ').');
  const json = await res.json().catch(() => ({}));
  const cal = (json.calendars && json.calendars.primary) || {};
  if (cal.errors && cal.errors.length) throw new Error('Google a refusé la lecture de cet agenda.');
  const list = (cal.busy || []).map(b => [Date.parse(b.start), Date.parse(b.end)]).filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of list) { const last = merged[merged.length - 1]; if (last && s <= last[1]) last[1] = Math.max(last[1], e); else merged.push([s, e]); }
  return merged.map(([s, e]) => [new Date(s).toISOString(), new Date(e).toISOString()]);
}
