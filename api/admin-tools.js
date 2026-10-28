// Fonction serveur Vercel — outils de l'administrateur : état des emails / rappels et email de test.
//   { action: 'status' }     → configuration des emails, dernier passage du planificateur, emails envoyés
//   { action: 'test-mail' }  → envoie un email de test à l'adresse de l'administrateur
//   { action: 'send-mail', subject, message, all | userIds[], copyToMe } → écrit aux membres du serveur de l'administrateur
import { createClient } from '@supabase/supabase-js';
import { esc, siteUrl, layout, sendMail, mailConfigured, via } from './_mail.js';

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

    if (action === 'diagnostics') {
      const now = Date.now();
      const h24 = new Date(now - 86400000).toISOString(), d7 = new Date(now - 7 * 86400000).toISOString();
      const { data: pa } = await supabaseAdmin.from('platform_admins').select('user_id').eq('user_id', me.id).maybeSingle();
      const platform = Boolean(pa);
      const cnt = async (ok, since) => (await supabaseAdmin.from('mail_log').select('id', { count: 'exact', head: true }).eq('ok', ok).gte('at', since)).count || 0;
      const logOk = !(await supabaseAdmin.from('mail_log').select('id').limit(1)).error;   // false si la migration 10 n'a pas été lancée
      const { data: errs } = logOk ? await supabaseAdmin.from('mail_log').select('at, subject, error').eq('ok', false).order('at', { ascending: false }).limit(5) : { data: [] };
      const { data: lastMailOk } = logOk ? await supabaseAdmin.from('mail_log').select('at').eq('ok', true).order('at', { ascending: false }).limit(1) : { data: [] };
      const { data: runs } = await supabaseAdmin.from('cron_runs').select('ran_at, mode, sent').order('ran_at', { ascending: false }).limit(1);
      const { count: runs24h } = await supabaseAdmin.from('cron_runs').select('id', { count: 'exact', head: true }).gte('ran_at', h24);
      const { data: people } = await supabaseAdmin.from('profiles').select('id, display_name').eq('server_id', me.server_id).eq('status', 'approved');
      const { data: feeds } = await supabaseAdmin.from('calendar_feeds').select('user_id, last_sync, last_error, busy').in('user_id', (people || []).map(p => p.id));
      const nameOf = new Map((people || []).map(p => [p.id, p.display_name]));
      const { count: pendingLeaves } = await supabaseAdmin.from('leave_requests').select('id', { count: 'exact', head: true }).eq('server_id', me.server_id).eq('status', 'pending');
      const { count: pendingMembers } = await supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }).eq('server_id', me.server_id).eq('status', 'pending');
      return res.status(200).json({
        ok: true, platform,
        mail: {
          configured: mailConfigured(), sender: process.env.GMAIL_USER ? process.env.GMAIL_USER.replace(/^(.).*(@.*)$/, '$1•••$2') : null, logAvailable: logOk,
          sent24h: logOk ? await cnt(true, h24) : null, failed24h: logOk ? await cnt(false, h24) : null, sent7d: logOk ? await cnt(true, d7) : null, failed7d: logOk ? await cnt(false, d7) : null,
          lastOk: lastMailOk && lastMailOk[0] ? lastMailOk[0].at : null,
          errors: (errs || []).map(e => ({ at: e.at, error: e.error, ...(platform ? { subject: e.subject } : {}) })),
        },
        cron: { secretSet: Boolean(process.env.CRON_SECRET), lastRun: runs && runs[0] ? runs[0] : null, runs24h: runs24h || 0 },
        feeds: (feeds || []).map(f => ({ name: nameOf.get(f.user_id) || '?', last_sync: f.last_sync, last_error: f.last_error, slots: (f.busy || []).length })),
        pending: { leaves: pendingLeaves || 0, members: pendingMembers || 0 },
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

    if (action === 'send-mail') {
      if (!mailConfigured()) return res.status(400).json({ error: "Les emails ne sont pas configurés : GMAIL_USER et GMAIL_APP_PASSWORD manquent sur Vercel." });
      const subject = String((req.body || {}).subject || '').replace(/[\r\n]+/g, ' ').trim();
      const message = String((req.body || {}).message || '').replace(/\r\n/g, '\n').trim();
      if (!subject || subject.length > 120) return res.status(400).json({ error: "L'objet est obligatoire (120 caractères maximum)." });
      if (!message || message.length > 5000) return res.status(400).json({ error: 'Le message est obligatoire (5 000 caractères maximum).' });

      // Garde-fou : pas plus de 10 envois par heure (Gmail limite le nombre d'emails par jour).
      const hourAgo = new Date(Date.now() - 3600000).toISOString();
      const { count: recent } = await supabaseAdmin.from('activity').select('id', { count: 'exact', head: true })
        .eq('server_id', me.server_id).eq('action', 'mail.sent').gte('created_at', hourAgo);
      if ((recent || 0) >= 10) return res.status(429).json({ error: "Trop d'envois en peu de temps : réessaie dans une heure." });

      // Destinataires : uniquement des membres approuvés de VOTRE serveur (jamais d'adresse libre).
      const { data: members } = await supabaseAdmin.from('profiles')
        .select('id, email, display_name').eq('server_id', me.server_id).eq('status', 'approved');
      const wanted = (req.body || {}).all === true ? null : new Set(Array.isArray((req.body || {}).userIds) ? req.body.userIds : []);
      let targets = (members || []).filter(m => m.email && (wanted === null || wanted.has(m.id)));
      if (!(req.body || {}).copyToMe) targets = targets.filter(m => m.id !== me.id);
      else if (!targets.some(m => m.id === me.id)) targets.push({ id: me.id, email: me.email, display_name: me.display_name });
      if (!targets.length) return res.status(400).json({ error: 'Aucun destinataire sélectionné.' });
      if (targets.length > 40) return res.status(400).json({ error: 'Maximum 40 destinataires par envoi.' });

      const link = `${siteUrl(req)}/app/`;
      const body = esc(message).split(/\n{2,}/).map(par => `<p style="margin:0 0 14px;line-height:1.55">${par.replace(/\n/g, '<br>')}</p>`).join('');
      let sent = 0, failed = 0;
      for (let i = 0; i < targets.length; i += 5) {
        const results = await Promise.allSettled(targets.slice(i, i + 5).map(t => sendMail({
          to: t.email,
          replyTo: me.email, fromName: via(me.display_name),
          subject,
          text: `${message}\n\n— ${me.display_name} (administrateur de Le Carnet)\n${link}`,
          html: layout(`${body}<p style="margin:18px 0 0;font-size:13px;color:#556">— ${esc(me.display_name)}, administrateur de Le Carnet<br>Vous pouvez répondre directement à cet email.</p>`),
        })));
        results.forEach(r => (r.status === 'fulfilled' ? sent++ : failed++));
      }
      if (sent) {
        try { await supabaseAdmin.from('activity').insert({ server_id: me.server_id, actor_id: me.id, action: 'mail.sent', label: `${subject} (${sent} destinataire${sent > 1 ? 's' : ''})`.slice(0, 200) }); } catch (_) { /* le journal ne bloque pas */ }
      }
      if (!sent) return res.status(502).json({ error: "Aucun email n'a pu partir. Vérifiez la configuration Gmail." });
      return res.status(200).json({ ok: true, sent, failed });
    }

    return res.status(400).json({ error: 'Action inconnue' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
}
