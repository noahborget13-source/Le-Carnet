// Fonction serveur Vercel — prévient par email les personnes @mentionnées
// dans un commentaire de tâche ou dans le salon du serveur.
import { createClient } from '@supabase/supabase-js';
import { esc, siteUrl, layout, button, sendMail, mailConfigured, extractMentions, via } from './_mail.js';

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const MAX_PEOPLE = 8;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Non authentifié' });
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) return res.status(401).json({ error: 'Session invalide' });
    const { data: caller } = await supabaseAdmin.from('profiles')
      .select('id, server_id, status, display_name, email').eq('id', userData.user.id).single();
    if (!caller || caller.status !== 'approved') return res.status(403).json({ error: 'Accès refusé.' });

    const { kind, id } = req.body || {};
    if (kind !== 'comment' && kind !== 'channel') return res.status(400).json({ error: 'Type inconnu.' });
    const table = kind === 'comment' ? 'task_comments' : 'channel_messages';
    const authorCol = kind === 'comment' ? 'author_id' : 'from_id';

    const { data: row } = await supabaseAdmin.from(table).select('*').eq('id', id).single();
    if (!row || row[authorCol] !== caller.id || row.server_id !== caller.server_id) return res.status(404).json({ error: 'Message introuvable.' });
    if (row.notified_at) return res.status(200).json({ ok: true, sent: 0 });

    const names = extractMentions(row.text);
    if (!names.length || !mailConfigured()) return res.status(200).json({ ok: true, sent: 0 });

    // On « réserve » l'envoi pour éviter les doublons si l'appel est répété.
    const { data: claimed } = await supabaseAdmin.from(table).update({ notified_at: new Date().toISOString() })
      .eq('id', id).is('notified_at', null).select('id');
    if (!claimed || !claimed.length) return res.status(200).json({ ok: true, sent: 0 });

    const { data: people } = await supabaseAdmin.from('profiles')
      .select('id, email, username, display_name').eq('server_id', caller.server_id).eq('status', 'approved');
    const targets = (people || []).filter(p => p.id !== caller.id && names.includes(p.username.toLowerCase())).slice(0, MAX_PEOPLE);

    let where = 'dans le salon du serveur';
    if (kind === 'comment') {
      const { data: task } = await supabaseAdmin.from('tasks').select('title').eq('id', row.task_id).single();
      where = `dans un commentaire sur « ${task?.title || 'une tâche'} »`;
    }
    const excerpt = row.text.length > 300 ? row.text.slice(0, 300) + '…' : row.text;
    const link = `${siteUrl(req)}/app/`;

    let sent = 0;
    for (const t of targets) {
      try {
        await sendMail({
          to: t.email, fromName: via(caller.display_name), ...(caller.email ? { replyTo: caller.email } : {}),
          subject: `${caller.display_name} t'a mentionné(e)`,
          text: `${caller.display_name} t'a mentionné(e) ${where} :\n${excerpt}\n${link}`,
          html: layout(`<p><strong>${esc(caller.display_name)}</strong> t'a mentionné(e) ${esc(where)} :</p>
            <div style="border-left:4px solid #5B9EF5;background:#f4f7fd;padding:10px 14px;border-radius:6px;white-space:pre-wrap">${esc(excerpt)}</div>${button(link, 'Ouvrir Le Carnet')}`),
        });
        sent++;
      } catch (_) { /* on continue avec les autres */ }
    }
    return res.status(200).json({ ok: true, sent });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
}
