// Fonction serveur Vercel — l'admin d'un serveur invite quelqu'un par email.
// Actions : { action: 'send', email, role } ou { action: 'resend', id }.
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ROLES = ['moderator', 'member', 'guest'];
const ROLE_LABELS = { moderator: 'modérateur', member: 'membre', guest: 'invité' };

function siteUrl(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `https://${host}`;
}

async function sendMail({ to, serverName, inviterName, role, link }) {
  const user = process.env.GMAIL_USER;
  const pass = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
  if (!user || !pass) {
    throw new Error("L'envoi d'emails n'est pas encore configuré (GMAIL_USER / GMAIL_APP_PASSWORD manquants sur Vercel).");
  }
  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1f2430">
    <h2 style="margin:0 0 12px">Le Carnet</h2>
    <p><strong>${esc(inviterName)}</strong> t'invite à rejoindre « <strong>${esc(serverName)}</strong> » en tant que ${esc(ROLE_LABELS[role])}.</p>
    <p style="margin:24px 0"><a href="${esc(link)}" style="background:#5B9EF5;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block">Créer mon compte</a></p>
    <p style="font-size:13px;color:#667">Ce lien est personnel et valable 7 jours. Si le bouton ne marche pas, copie cette adresse dans ton navigateur :<br>${esc(link)}</p>
  </div>`;
  await transporter.sendMail({
    from: `"Le Carnet" <${user}>`,
    to,
    subject: `${inviterName} t'invite sur Le Carnet (${serverName})`,
    text: `${inviterName} t'invite à rejoindre « ${serverName} » sur Le Carnet.\nCrée ton compte ici (valable 7 jours) : ${link}`,
    html,
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Non authentifié' });

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) return res.status(401).json({ error: 'Session invalide' });

    const { data: caller } = await supabaseAdmin
      .from('profiles')
      .select('id, role, server_id, status, display_name')
      .eq('id', userData.user.id)
      .single();
    if (!caller || caller.role !== 'admin' || caller.status !== 'approved') {
      return res.status(403).json({ error: "Seul l'administrateur de ce serveur peut inviter." });
    }

    const { data: server } = await supabaseAdmin.from('servers').select('name').eq('id', caller.server_id).single();
    const serverName = server?.name || 'Le Carnet';

    const body = req.body || {};
    const action = body.action || 'send';
    let invite;

    if (action === 'resend') {
      const { data } = await supabaseAdmin.from('invites').select('*').eq('id', body.id).eq('server_id', caller.server_id).is('used_at', null).single();
      if (!data) return res.status(404).json({ error: 'Invitation introuvable.' });
      const { data: renewed, error } = await supabaseAdmin
        .from('invites')
        .update({ expires_at: new Date(Date.now() + 7 * 86400000).toISOString() })
        .eq('id', data.id).select().single();
      if (error) return res.status(400).json({ error: error.message });
      invite = renewed;
    } else {
      const email = String(body.email || '').trim().toLowerCase();
      const role = ROLES.includes(body.role) ? body.role : 'member';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Adresse email invalide.' });

      const { data: existing } = await supabaseAdmin.from('profiles').select('id').ilike('email', email).limit(1);
      if (existing && existing.length) {
        return res.status(400).json({ error: "Cette adresse a déjà un compte sur Le Carnet. Un compte ne peut appartenir qu'à un seul serveur." });
      }

      // Une seule invitation en attente par adresse et par serveur : on remplace l'ancienne.
      await supabaseAdmin.from('invites').delete().eq('server_id', caller.server_id).ilike('email', email).is('used_at', null);

      const { data, error } = await supabaseAdmin.from('invites').insert({
        server_id: caller.server_id,
        email, role,
        token: crypto.randomBytes(24).toString('hex'),
        invited_by: caller.id,
      }).select().single();
      if (error) return res.status(400).json({ error: error.message });
      invite = data;
    }

    const link = `${siteUrl(req)}/?invite=${invite.token}`;
    try {
      await sendMail({ to: invite.email, serverName, inviterName: caller.display_name || 'Un administrateur', role: invite.role, link });
    } catch (mailErr) {
      // L'invitation existe quand même : l'admin peut copier le lien à la main.
      return res.status(200).json({ ok: true, emailSent: false, link, warning: `Invitation créée mais l'email n'a pas pu partir : ${mailErr.message}` });
    }
    return res.status(200).json({ ok: true, emailSent: true, link });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
}
