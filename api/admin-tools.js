// Fonction serveur Vercel — outils de l'administrateur : état des emails / rappels et email de test.
//   { action: 'status' }     → configuration des emails, dernier passage du planificateur, emails envoyés
//   { action: 'test-mail' }  → envoie un email de test à l'adresse de l'administrateur
import { createClient } from '@supabase/supabase-js';
import { esc, siteUrl, layout, sendMail, mailConfigured } from './_mail.js';

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Non authentifié' });
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) return res.status(401).json({ error: 'Session invalide' });
    const { data: me } = await supabaseAdmin.from('profiles')
      .select('id, role, status, server_id, email, display_name').eq('id', userData.user.id).single();
    if (!me || me.status !== 'approved' || me.role !== 'admin') return res.status(403).json({ error: "Réservé à l'administrateur." });

    const { action } = req.body || {};

    if (action === 'status') {
      const since = new Date(Date.now() - 7 * 86400000).toISOString();
      const { data: lastRun } = await supabaseAdmin.from('cron_runs').select('ran_at, mode, sent').order('ran_at', { ascending: false }).limit(1);
      const { count: runs24h } = await supabaseAdmin.from('cron_runs').select('id', { count: 'exact', head: true })
        .gte('ran_at', new Date(Date.now() - 86400000).toISOString());
      const { count: mails7d } = await supabaseAdmin.from('task_notifications')
        .select('task_id, tasks!inner(server_id)', { count: 'exact', head: true })
        .eq('tasks.server_id', me.server_id).gte('sent_at', since);
      return res.status(200).json({
        ok: true,
        mailConfigured: mailConfigured(),
        sender: process.env.GMAIL_USER ? process.env.GMAIL_USER.replace(/^(.).*(@.*)$/, '$1•••$2') : null,
        cronSecretSet: Boolean(process.env.CRON_SECRET),
        lastRun: lastRun && lastRun[0] ? lastRun[0] : null,
        runs24h: runs24h || 0,
        mails7d: mails7d || 0,
      });
    }

    if (action === 'test-mail') {
      if (!mailConfigured()) return res.status(400).json({ error: "Les emails ne sont pas configurés : GMAIL_USER et GMAIL_APP_PASSWORD manquent sur Vercel." });
      try {
        await sendMail({
          to: me.email,
          subject: 'Test Le Carnet : les emails fonctionnent ✓',
          text: `Bonjour ${me.display_name}, cet email de test confirme que Le Carnet peut envoyer des emails.\n${siteUrl(req)}/app/`,
          html: layout(`<p>Bonjour ${esc(me.display_name)},</p><p>Cet email de test confirme que <strong>Le Carnet peut envoyer des emails</strong> : invitations, assignations, rappels d'échéance et mentions arriveront bien.</p>`),
        });
      } catch (e) {
        return res.status(502).json({ error: "L'envoi a échoué : " + (e.message || 'erreur inconnue') });
      }
      return res.status(200).json({ ok: true, to: me.email });
    }

    return res.status(400).json({ error: 'Action inconnue' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
}
