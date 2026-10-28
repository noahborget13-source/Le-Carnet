// Utilitaires partagés pour l'envoi d'emails (le préfixe _ empêche Vercel d'en faire une fonction).
import nodemailer from 'nodemailer';
import { createClient } from '@supabase/supabase-js';

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function mailConfigured() {
  return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

export function siteUrl(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `https://${host}`;
}

let transporter;
function getTransporter() {
  if (!transporter) {
    const user = process.env.GMAIL_USER;
    const pass = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
    transporter = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  }
  return transporter;
}

export function layout(innerHtml) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1f2430">
    <h2 style="margin:0 0 14px">Le Carnet</h2>${innerHtml}
    <p style="font-size:12px;color:#889;margin-top:28px">Vous recevez cet email parce que vous avez un compte sur Le Carnet.</p>
  </div>`;
}

export function button(link, label) {
  return `<p style="margin:22px 0"><a href="${esc(link)}" style="background:#5B9EF5;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block">${esc(label)}</a></p>`;
}

// Expéditeur : tous les emails partent de « Le Carnet » (adresse du compte Gmail du site), jamais au nom d'un membre.
// Le nom de la personne concernée figure dans le texte du message ; « Répondre » écrit à cette personne (replyTo).
// `via()` est conservée pour les appelants existants : elle renvoie toujours « Le Carnet ».
const SENDER_NAME = () => String(process.env.MAIL_FROM_NAME || 'Le Carnet').replace(/[\r\n"<>]/g, ' ').trim().slice(0, 80) || 'Le Carnet';
export const via = () => SENDER_NAME();
const fromLabel = () => SENDER_NAME();

// Journal des envois (page « Statut » de l'administration) : résultat + sujet, jamais l'adresse du destinataire.
let logClient;
async function logMail(ok, subject, error) {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return;
    if (!logClient) logClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    await logClient.from('mail_log').insert({ ok, subject: String(subject || '').slice(0, 100), error: error ? String(error).replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '•••').slice(0, 200) : null });
  } catch (_) { /* le journal ne doit jamais empêcher un envoi */ }
}

export async function sendMail({ to, subject, text, html, replyTo, icalEvent, fromName }) {
  if (!mailConfigured()) throw new Error("L'envoi d'emails n'est pas configuré (GMAIL_USER / GMAIL_APP_PASSWORD manquants).");
  try { await sendRaw({ to, subject, text, html, replyTo, icalEvent, fromName }); }
  catch (e) { await logMail(false, subject, e && e.message); throw e; }
  await logMail(true, subject);
}
async function sendRaw({ to, subject, text, html, replyTo, icalEvent, fromName }) {
  await getTransporter().sendMail({ from: `"${fromLabel()}" <${process.env.GMAIL_USER}>`, to, subject, text, html, ...(replyTo ? { replyTo } : {}), ...(icalEvent ? { icalEvent } : {}) });
}

// Extrait les @identifiants d'un texte (sans le @, en minuscules, sans doublon).
export function extractMentions(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/(^|[^A-Za-z0-9._-])@([A-Za-z0-9._-]{3,30})/g)) {
    const name = m[2].replace(/[._-]+$/, '').toLowerCase();
    if (name.length >= 3) out.add(name);
  }
  return [...out];
}

// Dates / heures (Paris) : voir _time.js
export * from './_time.js';
