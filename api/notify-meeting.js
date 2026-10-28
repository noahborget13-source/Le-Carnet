// Fonction serveur Vercel — emails d'une réunion : invitation, modification, annulation.
//   { action: 'invite' | 'update', meetingId }  → email + fichier d'agenda (.ics) à chaque invité, avec le lien d'appel.
//                                                   Si un invité est indisponible : avertissement dans son email + résumé à l'organisateur.
//   { action: 'cancel', meetingId }              → prévient les invités puis supprime la réunion.
import { createClient } from '@supabase/supabase-js';
import { esc, siteUrl, layout, button, sendMail, mailConfigured, wants, via } from './_mail.js';
import { loadBusy, conflictReasons, reasonText, reasonsStamp } from './_availability.js';
import { meetingLink, buildIcs, whenText, warnBox } from './_meeting.js';

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Non authentifié' });
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) return res.status(401).json({ error: 'Session invalide' });
    const { data: caller } = await supabaseAdmin.from('profiles').select('id, server_id, status, role, display_name, email').eq('id', userData.user.id).single();
    if (!caller || caller.status !== 'approved') return res.status(403).json({ error: 'Accès refusé.' });

    const { action, meetingId } = req.body || {};
    if (!['invite', 'update', 'cancel'].includes(action)) return res.status(400).json({ error: 'Action inconnue' });
    const { data: meeting } = await supabaseAdmin.from('meetings').select('*').eq('id', meetingId).single();
    if (!meeting || meeting.server_id !== caller.server_id) return res.status(404).json({ error: 'Réunion introuvable.' });
    if (meeting.created_by !== caller.id && caller.role !== 'admin') return res.status(403).json({ error: "Seul l'organisateur ou l'administrateur peut faire ça." });

    const { data: atts } = await supabaseAdmin.from('meeting_attendees').select('user_id, response').eq('meeting_id', meeting.id);
    const ids = [...new Set((atts || []).map(a => a.user_id))];
    const { data: people } = await supabaseAdmin.from('profiles').select('id, email, display_name, status, server_id, work_hours, notify_meetings, notify_conflicts').in('id', ids.concat(meeting.created_by));
    const byId = new Map((people || []).map(p => [p.id, p]));
    const organizer = byId.get(meeting.created_by) || caller;
    const attendees = ids.map(id => byId.get(id)).filter(p => p && p.status === 'approved' && p.server_id === caller.server_id && p.email);
    const link = meetingLink(meeting);
    const site = siteUrl(req);
    const when = whenText(meeting);
    const sequence = Math.floor(Date.parse(meeting.created_at || meeting.starts_at) / 1000) % 1000000 + Math.floor((Date.now() - 1.7e12) / 60000);

    if (action === 'cancel') {
      let sent = 0;
      if (mailConfigured()) {
        const ics = buildIcs({ meeting, organizer, attendees, method: 'CANCEL', link, sequence });
        for (const p of attendees) {
          if (p.id === caller.id || !wants(p, 'notify_meetings')) continue;
          try {
            await sendMail({
              to: p.email, replyTo: organizer.email, fromName: via(caller.display_name), subject: `Réunion annulée : ${meeting.title}`,
              text: `${caller.display_name} a annulé la réunion « ${meeting.title} » (${when}).`,
              html: layout(`<p><strong>${esc(caller.display_name)}</strong> a annulé la réunion :</p><div style="border-left:4px solid #D6453A;background:#fdf3f2;padding:12px 14px;border-radius:6px"><div style="font-size:16px;font-weight:bold;text-decoration:line-through">${esc(meeting.title)}</div><div style="font-size:13px;color:#556;margin-top:4px">${esc(when)}</div></div>`),
              icalEvent: { method: 'CANCEL', content: ics },
            });
            sent++;
          } catch (_) { /* on continue */ }
        }
      }
      // Les fichiers joints sont effacés du stockage avec la réunion
      try {
        const { data: files } = await supabaseAdmin.from('meeting_attachments').select('path').eq('meeting_id', meeting.id);
        if (files && files.length) await supabaseAdmin.storage.from('task-files').remove(files.map(f => f.path));
      } catch (_) { /* sans gravité */ }
      await supabaseAdmin.from('meetings').delete().eq('id', meeting.id);
      return res.status(200).json({ ok: true, sent });
    }

    if (!mailConfigured()) return res.status(200).json({ ok: true, sent: 0, conflicts: 0 });

    // ---- conflits d'horaire de chaque invité ----
    const startMs = Date.parse(meeting.starts_at), endMs = Date.parse(meeting.ends_at);
    const busy = await loadBusy(supabaseAdmin, ids, startMs, endMs, meeting.id);
    const conflicts = new Map();   // userId -> reasons
    for (const p of attendees) {
      const reasons = conflictReasons({ startMs, endMs, user: p, busy: busy.get(p.id) || [] });
      if (reasons.length) conflicts.set(p.id, reasons);
    }

    // ---- invitation ou modification, avec fichier d'agenda ----
    const ics = buildIcs({ meeting, organizer, attendees, method: 'REQUEST', link, sequence });
    const names = attendees.map(a => a.display_name).join(', ');
    const updated = action === 'update';
    let sent = 0;
    for (const p of attendees) {
      if (p.id === caller.id || !wants(p, 'notify_meetings')) continue;
      const mine = conflicts.get(p.id);
      const warn = mine && wants(p, 'notify_conflicts') ? warnBox(mine.map(r => reasonText(r, p.display_name, 'you').replace(/^./, c => c.toUpperCase()))) : '';
      try {
        await sendMail({
          to: p.email, replyTo: organizer.email, fromName: via(caller.display_name),
          subject: `${updated ? 'Réunion modifiée' : 'Invitation'} : ${meeting.title}`,
          text: `${caller.display_name} ${updated ? 'a modifié' : "vous invite à"} la réunion « ${meeting.title} » : ${when}.\nAppel vidéo : ${link}\n${site}/app/`,
          html: layout(`<p><strong>${esc(caller.display_name)}</strong> ${updated ? 'a modifié la réunion' : "vous invite à une réunion"} :</p>
            <div style="border-left:4px solid #5B9EF5;background:#f4f7fd;padding:12px 14px;border-radius:6px">
              <div style="font-size:16px;font-weight:bold">${esc(meeting.title)}</div>
              <div style="font-size:13px;color:#556;margin-top:4px">${esc(when)}</div>
              ${names ? `<div style="font-size:13px;margin-top:6px">Participants : ${esc(names)}</div>` : ''}
              ${meeting.notes ? `<div style="font-size:13px;margin-top:8px">${esc(meeting.notes).replace(/\n/g, '<br>')}</div>` : ''}
            </div>${warn}${button(link, "Rejoindre l'appel vidéo")}
            <p style="font-size:13px;color:#556">Un fichier d'agenda est joint : ouvrez-le pour l'ajouter à Google Agenda. Vous pouvez aussi répondre dans <a href="${esc(site)}/app/">Le Carnet</a> (onglet Réunions).</p>`),
          icalEvent: { method: 'REQUEST', content: ics },
        });
        sent++;
      } catch (_) { /* on continue */ }
    }

    // ---- résumé des conflits pour l'organisateur ----
    let warned = 0;
    if (conflicts.size && wants(organizer, 'notify_conflicts') && organizer.email) {
      const lines = [];
      for (const [id, reasons] of conflicts) { const p = byId.get(id); lines.push(reasons.map(r => reasonText(r, p.display_name, 'name').replace(/^./, c => c.toUpperCase())).join(' ; ')); }
      try {
        await sendMail({
          to: organizer.email, subject: `Conflit d'horaire : ${meeting.title}`,
          text: `Certains participants ne sont pas disponibles pour « ${meeting.title} » (${when}) :\n- ${lines.join('\n- ')}`,
          html: layout(`<p>La réunion <strong>${esc(meeting.title)}</strong> (${esc(when)}) tombe à un moment où certains participants ne sont pas disponibles.</p>${warnBox(lines)}<p style="font-size:13px;color:#556">Les personnes concernées ont été prévenues. Vous pouvez déplacer la réunion depuis l'onglet Réunions.</p>${button(`${site}/app/`, 'Ouvrir Le Carnet')}`),
        });
        warned = 1;
      } catch (_) { /* on continue */ }
    }
    // On mémorise les conflits déjà signalés pour ne pas répéter l'email au prochain passage automatique.
    const marks = [...conflicts].map(([id, reasons]) => ({ kind: 'conflict_meeting', item_id: meeting.id, user_id: id, stamp: `${meeting.starts_at}|${meeting.ends_at}|${reasonsStamp(reasons)}`, sent_at: new Date().toISOString() }));
    if (marks.length) { try { await supabaseAdmin.from('event_notifications').upsert(marks, { onConflict: 'kind,item_id,user_id' }); } catch (_) {} }
    return res.status(200).json({ ok: true, sent, conflicts: conflicts.size, warned });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
}
